import base64
import logging
import os
import time
from typing import List, Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from pydantic import BaseModel

from . import models


LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
LOG_FORMAT = os.environ.get(
    "LOG_FORMAT",
    "%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logging.basicConfig(level=LOG_LEVEL, format=LOG_FORMAT, force=True)
logging.getLogger("uvicorn").setLevel(LOG_LEVEL)
logging.getLogger("uvicorn.error").setLevel(LOG_LEVEL)
logging.getLogger("uvicorn.access").setLevel(LOG_LEVEL)
os.environ.setdefault("UVICORN_LOG_LEVEL", LOG_LEVEL.lower())

logger = logging.getLogger("embedder.api")
logger.info("[BOOT] logging initialised level=%s format='%s'", LOG_LEVEL, LOG_FORMAT)

app = FastAPI(title="Embedder Service", version="0.1.0")


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - start) * 1000.0
    logger.info(
        "[HTTP] %s %s -> %s %.2fms",
        request.method,
        request.url.path,
        getattr(response, "status_code", "?"),
        duration_ms,
    )
    return response


@app.on_event("startup")
async def startup_event() -> None:
    logger.info("[BOOT] initialising embedder service (pid=%s)", os.getpid())
    try:
        models.load_model()
        logger.info(
            "[BOOT] model ready id=%s dim=%s device=%s scales=%s tta=%s",
            models.MODEL_ID,
            models.TARGET_DIM,
            models.VISION_DEVICE,
            ",".join(f"{f:.2f}" for f in models.IMAGE_SCALE_FACTORS),
            os.environ.get("ENABLE_TTA", "1") != "0",
        )
        if models.VISION_DEVICE and models.VISION_DEVICE.startswith("cuda"):
            logger.info("[BOOT] gpu_state=%s", models._format_gpu_state())
    except Exception as exc:  # pragma: no cover
        logger.exception("[BOOT] failed to load model: %s", exc)
        raise

class TextRequest(BaseModel):
    text: str

class TextBatchRequest(BaseModel):
    texts: List[str]

class ImageEmbedJSON(BaseModel):
    uri: Optional[str] = None  # future use if remote fetch allowed
    bytes_b64: Optional[str] = None

class ImageBatchRequest(BaseModel):
    images_b64: List[str]

class EmbeddingDiagnostics(BaseModel):
    dim: int
    norm: float
    tiles: Optional[int] = None
    crops: Optional[int] = None
    scales: Optional[int] = None
    prep_ms: Optional[float] = None
    transfer_ms: Optional[float] = None
    infer_ms: Optional[float] = None
    total_ms: Optional[float] = None
    token_count: Optional[int] = None
    context_length: Optional[int] = None
    tokenize_ms: Optional[float] = None
    elapsed: Optional[float] = None


class ImageBatchResponse(BaseModel):
    vecs: List[List[float]]
    errors: List[Optional[str]]
    diagnostics: List[Optional[EmbeddingDiagnostics]]

@app.get("/healthz")
def healthz():
    return {"status": "ok", "time": time.time()}

@app.post("/warmup")
def warmup():
    """Load model & run a tiny forward pass to reduce first-request latency."""
    import random
    from PIL import Image
    import io as _io
    start = time.perf_counter()
    errors = []
    try:
        models.load_model()
    except Exception as e:  # pragma: no cover
        logger.exception("[WARMUP] model load failed: %s", e)
        errors.append(f"load_model: {e}")

    # run text warmup (defensive: catch to avoid a soft-failure bringing down warmup)
    try:
        _ = models.embed_text("warmup")
    except Exception as e:  # pragma: no cover
        logger.exception("[WARMUP] text warmup failed: %s", e)
        errors.append(f"embed_text: {e}")

    # create small random RGB image (32x32) and embed
    try:
        img = Image.new("RGB", (32, 32), (random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        _ = models.embed_image_bytes(buf.getvalue())
    except Exception as e:  # pragma: no cover
        logger.exception("[WARMUP] image warmup failed: %s", e)
        errors.append(f"embed_image: {e}")

    elapsed = time.perf_counter() - start
    if errors:
        logger.warning("[WARMUP] completed with errors in %.3fs: %s", elapsed, errors)
        return {"status": "partial", "elapsed": elapsed, "errors": errors}
    logger.info(f"[WARMUP] completed in {elapsed:.3f}s")
    return {"status": "ok", "elapsed": elapsed}

@app.post("/embed/text")
def embed_text_endpoint(req: TextRequest):
    start_time = time.perf_counter()
    text_preview = req.text[:100] + "..." if len(req.text) > 100 else req.text
    logger.info(f"[EMBED_TEXT] Starting text embedding - text_length={len(req.text)}, preview='{text_preview}'")
    
    if not req.text.strip():
        logger.warning(f"[EMBED_TEXT] Empty text received")
        raise HTTPException(status_code=400, detail="text empty")

    try:
        vec, diag = models.embed_text(req.text, with_diagnostics=True)
        elapsed = time.perf_counter() - start_time
        logger.info(
            "[EMBED_TEXT] Successfully embedded text - dim=%d, elapsed=%.3fs, norm=%.6f",
            len(vec),
            elapsed,
            diag.get("norm", 0.0),
        )
        diag_obj = EmbeddingDiagnostics(**{**diag, "elapsed": elapsed})
        return {"vec": vec, "diag": diag}
    except Exception as e:
        elapsed = time.perf_counter() - start_time
        logger.error(f"[EMBED_TEXT] Failed to embed text - error={str(e)}, elapsed={elapsed:.3f}s")
        raise HTTPException(status_code=500, detail=f"embedding failed: {str(e)}")

@app.post("/embed/text/batch")
def embed_text_batch(req: TextBatchRequest):
    out = [models.embed_text(t) for t in req.texts]
    return {"vecs": out}

@app.post("/embed/image")
async def embed_image(request: Request, file: UploadFile | None = File(None)):
    """Flexible image embedding endpoint.

    Accepts either multipart/form-data with a file upload OR application/json with {bytes_b64}.
    """
    start_time = time.perf_counter()
    content_type = request.headers.get("content-type", "")
    data_bytes: bytes | None = None
    source_info = ""

    logger.info(f"[EMBED_IMAGE] Starting image embedding - content_type='{content_type}'")

    if "multipart/form-data" in content_type:
        if file is None:
            logger.warning(f"[EMBED_IMAGE] No file provided in multipart request")
            raise HTTPException(status_code=400, detail="file missing")
        data_bytes = await file.read()
        source_info = f"file={file.filename}, size={len(data_bytes)}"
        logger.info(f"[EMBED_IMAGE] Received multipart file - {source_info}")
    else:
        try:
            payload = ImageEmbedJSON.parse_raw(await request.body())
        except Exception as e:
            logger.error(f"[EMBED_IMAGE] Failed to parse JSON payload - error={str(e)}")
            raise HTTPException(status_code=400, detail=f"invalid json: {e}")
        if payload.bytes_b64:
            try:
                data_bytes = base64.b64decode(payload.bytes_b64)
                source_info = f"b64_length={len(payload.bytes_b64)}, decoded_size={len(data_bytes)}"
                logger.info(f"[EMBED_IMAGE] Received base64 data - {source_info}")
            except Exception as e:
                logger.error(f"[EMBED_IMAGE] Failed to decode base64 - error={str(e)}")
                raise HTTPException(status_code=400, detail=f"b64 decode error: {e}")
        elif payload.uri:
            # Optional local file read (dev only). Use env ALLOW_LOCAL_URI=1 to enable for safety.
            if not os.environ.get("ALLOW_LOCAL_URI"):
                logger.warning(f"[EMBED_IMAGE] URI access disabled - uri='{payload.uri}'")
                raise HTTPException(status_code=400, detail="uri fetch disabled")
            if not os.path.exists(payload.uri):
                logger.error(f"[EMBED_IMAGE] URI not found - uri='{payload.uri}'")
                raise HTTPException(status_code=404, detail="uri not found")
            with open(payload.uri, "rb") as f:
                data_bytes = f.read()
            source_info = f"uri='{payload.uri}', size={len(data_bytes)}"
            logger.info(f"[EMBED_IMAGE] Loaded from URI - {source_info}")
        else:
            logger.warning(f"[EMBED_IMAGE] No data source provided")
            raise HTTPException(status_code=400, detail="provide bytes_b64 or uri")

    try:
        vec, diag = models.embed_image_bytes(data_bytes, with_diagnostics=True)
        elapsed = time.perf_counter() - start_time
        logger.info(
            "[EMBED_IMAGE] Successfully embedded image - %s, dim=%d, elapsed=%.3fs, norm=%.6f",
            source_info,
            len(vec),
            elapsed,
            diag.get("norm", 0.0),
        )
        diag_obj = EmbeddingDiagnostics(**{**diag, "elapsed": elapsed})
        return {"vec": vec, "diag": diag}
    except Exception as e:
        elapsed = time.perf_counter() - start_time
        logger.error(f"[EMBED_IMAGE] Failed to embed image - {source_info}, error={str(e)}, elapsed={elapsed:.3f}s")
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/embed/image/batch", response_model=ImageBatchResponse)
async def embed_image_batch(req: ImageBatchRequest):
    vecs: List[List[float]] = []
    errors: List[Optional[str]] = []
    diagnostics: List[Optional[EmbeddingDiagnostics]] = []
    for b64 in req.images_b64:
        if not b64:
            vecs.append([])
            errors.append("empty b64")
            diagnostics.append(None)
            continue
        try:
            data_bytes = base64.b64decode(b64)
            v, diag = models.embed_image_bytes(data_bytes, with_diagnostics=True)
            vecs.append(v)
            errors.append(None)
            diagnostics.append(EmbeddingDiagnostics(**diag))
        except Exception as e:  # pragma: no cover
            vecs.append([])
            errors.append(str(e))
            diagnostics.append(None)
    return ImageBatchResponse(vecs=vecs, errors=errors, diagnostics=diagnostics)
