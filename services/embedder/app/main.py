from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from pydantic import BaseModel
from typing import List, Optional
import time
import base64
import os

from .models import embed_image_bytes, embed_text

app = FastAPI(title="Embedder Service", version="0.1.0")

class TextRequest(BaseModel):
    text: str

class TextBatchRequest(BaseModel):
    texts: List[str]

class ImageEmbedJSON(BaseModel):
    uri: Optional[str] = None  # future use if remote fetch allowed
    bytes_b64: Optional[str] = None

class ImageBatchRequest(BaseModel):
    images_b64: List[str]

class ImageBatchResponse(BaseModel):
    vecs: List[List[float]]
    errors: List[Optional[str]]

@app.get("/healthz")
def healthz():
    return {"status": "ok", "time": time.time()}

@app.post("/embed/text")
def embed_text_endpoint(req: TextRequest):
    if not req.text.strip():
        raise HTTPException(status_code=400, detail="text empty")
    vec = embed_text(req.text)
    return {"vec": vec}

@app.post("/embed/text/batch")
def embed_text_batch(req: TextBatchRequest):
    out = [embed_text(t) for t in req.texts]
    return {"vecs": out}

@app.post("/embed/image")
async def embed_image(request: Request, file: UploadFile | None = File(None)):
    """Flexible image embedding endpoint.

    Accepts either multipart/form-data with a file upload OR application/json with {bytes_b64}.
    """
    content_type = request.headers.get("content-type", "")
    data_bytes: bytes | None = None

    if "multipart/form-data" in content_type:
        if file is None:
            raise HTTPException(status_code=400, detail="file missing")
        data_bytes = await file.read()
    else:
        try:
            payload = ImageEmbedJSON.parse_raw(await request.body())
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"invalid json: {e}")
        if payload.bytes_b64:
            try:
                data_bytes = base64.b64decode(payload.bytes_b64)
            except Exception as e:
                raise HTTPException(status_code=400, detail=f"b64 decode error: {e}")
        elif payload.uri:
            # Optional local file read (dev only). Use env ALLOW_LOCAL_URI=1 to enable for safety.
            if not os.environ.get("ALLOW_LOCAL_URI"):
                raise HTTPException(status_code=400, detail="uri fetch disabled")
            if not os.path.exists(payload.uri):
                raise HTTPException(status_code=404, detail="uri not found")
            with open(payload.uri, "rb") as f:
                data_bytes = f.read()
        else:
            raise HTTPException(status_code=400, detail="provide bytes_b64 or uri")

    try:
        vec = embed_image_bytes(data_bytes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"vec": vec}


@app.post("/embed/image/batch", response_model=ImageBatchResponse)
async def embed_image_batch(req: ImageBatchRequest):
    vecs: List[List[float]] = []
    errors: List[Optional[str]] = []
    for b64 in req.images_b64:
        if not b64:
            vecs.append([])
            errors.append("empty b64")
            continue
        try:
            data_bytes = base64.b64decode(b64)
            v = embed_image_bytes(data_bytes)
            vecs.append(v)
            errors.append(None)
        except Exception as e:  # pragma: no cover
            vecs.append([])
            errors.append(str(e))
    return ImageBatchResponse(vecs=vecs, errors=errors)
