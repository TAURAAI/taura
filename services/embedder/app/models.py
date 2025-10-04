import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision import transforms
from torchvision.transforms import functional as TF
from PIL import Image
from typing import Callable, Dict, List, Optional, Tuple
import contextlib
import io
import logging
import os
import time

try:
    import open_clip  # type: ignore
    _HAS_OPEN_CLIP = True
except Exception:  # pragma: no cover
    open_clip = None  # type: ignore
    _HAS_OPEN_CLIP = False

# Optional sentence-transformers backend for text-only encoders (unused unless wired up)
try:  # pragma: no cover
    from sentence_transformers import SentenceTransformer  # type: ignore
    _HAS_SENTENCE_TX = True
except Exception:
    SentenceTransformer = None  # type: ignore
    _HAS_SENTENCE_TX = False

_preprocess: transforms.Compose = transforms.Compose([
    transforms.Resize(384, interpolation=transforms.InterpolationMode.BICUBIC),
    transforms.CenterCrop(384),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.48145466, 0.4578275, 0.40821073],
                         std=[0.26862954, 0.26130258, 0.27577711]),
])

VISION_MODEL: Optional[nn.Module] = None
VISION_DEVICE: Optional[str] = None
TEXT_MODEL: Optional[nn.Module] = None
TEXT_TOKENIZER: Optional[Callable] = None
TARGET_DIM: Optional[int] = None
AMP_DTYPE: Optional[torch.dtype] = None
IMAGE_SCALE_FACTORS: List[float] = [1.0]

logger = logging.getLogger("embedder.models")

NORM_MEAN_VALUES: List[float] = [0.48145466, 0.4578275, 0.40821073]
NORM_STD_VALUES: List[float] = [0.26862954, 0.26130258, 0.27577711]
_NORM_CACHE: Dict[Tuple[str, torch.dtype], Tuple[torch.Tensor, torch.Tensor]] = {}

# ✅ use the TIMM-converted SigLIP checkpoint that includes open_clip_config.json
MODEL_ID: str = os.environ.get(
    "VISION_MODEL_ID",
    "hf-hub:timm/ViT-SO400M-14-SigLIP-384",
)

TARGET_IMAGE_SIZE: int = int(os.environ.get("VISION_SIZE", "384"))
CROP_SIZE: int = int(os.environ.get("TTA_CROP_SIZE", os.environ.get("VISION_SIZE", "384")))
REQUIRE_CUDA: bool = os.environ.get("REQUIRE_CUDA", "1") != "0"


def _get_device() -> str:
    if torch.cuda.is_available():
        preferred = os.environ.get("CUDA_DEVICE", "cuda")
        if preferred.startswith("cuda:"):
            index = int(preferred.split(":", 1)[1])
            if index >= torch.cuda.device_count():
                raise RuntimeError(f"requested {preferred} but only {torch.cuda.device_count()} cuda devices present")
            torch.cuda.set_device(index)
        return preferred
    if REQUIRE_CUDA:
        raise RuntimeError("CUDA required but not available; set REQUIRE_CUDA=0 to allow CPU fallback")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def _format_gpu_state() -> str:
    if not torch.cuda.is_available():
        return "cpu"
    try:
        idx = torch.cuda.current_device()
        props = torch.cuda.get_device_properties(idx)
        total_gb = props.total_memory / (1024 ** 3)
        allocated = torch.cuda.memory_allocated(idx) / (1024 ** 3)
        reserved = torch.cuda.memory_reserved(idx) / (1024 ** 3)
        capability = f"{props.major}.{props.minor}"
        return (
            f"{props.name} (cap {capability}, total {total_gb:.2f}GB, "
            f"alloc {allocated:.2f}GB, reserved {reserved:.2f}GB)"
        )
    except Exception as exc:  # pragma: no cover
        return f"cuda (introspection error: {exc})"


def _get_norm_tensors(device: torch.device, dtype: torch.dtype) -> Tuple[torch.Tensor, torch.Tensor]:
    key = (str(device), dtype)
    cached = _NORM_CACHE.get(key)
    if cached is None:
        mean = torch.tensor(NORM_MEAN_VALUES, dtype=torch.float32, device=device).view(1, 3, 1, 1)
        std = torch.tensor(NORM_STD_VALUES, dtype=torch.float32, device=device).view(1, 3, 1, 1)
        if dtype != torch.float32:
            mean = mean.to(dtype)
            std = std.to(dtype)
        _NORM_CACHE[key] = (mean, std)
        cached = (mean, std)
    return cached


def load_model(device: str = None) -> None:
    global VISION_MODEL, VISION_DEVICE, TEXT_MODEL, TEXT_TOKENIZER
    global _preprocess, TARGET_DIM, TARGET_IMAGE_SIZE, CROP_SIZE, AMP_DTYPE, IMAGE_SCALE_FACTORS

    if VISION_MODEL is not None:
        logger.debug("load_model noop (already initialised on %s)", VISION_DEVICE)
        return

    VISION_DEVICE = device or _get_device()
    logger.info("[MODEL_INIT] selected_device=%s require_cuda=%s", VISION_DEVICE, REQUIRE_CUDA)
    if VISION_DEVICE.startswith("cuda"):
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        try:
            torch.set_float32_matmul_precision(os.environ.get("MATMUL_PRECISION", "high"))
        except Exception:
            torch.set_float32_matmul_precision("high")
    else:
        AMP_DTYPE = None
        logger.warning("[MODEL_INIT] CUDA unavailable; falling back to %s", VISION_DEVICE)

    if not _HAS_OPEN_CLIP:
        raise RuntimeError("open_clip is not installed. `pip install -U open-clip-torch`")

    try:
        # load the OpenCLIP-converted SigLIP model from HF Hub
        model, preprocess = open_clip.create_model_from_pretrained(MODEL_ID, device=VISION_DEVICE)
        model.eval()

        default_precision = "fp16"
        if torch.cuda.is_available() and getattr(torch.cuda, "is_bf16_supported", lambda: False)():
            default_precision = "bf16"
        precision = os.environ.get("MODEL_PRECISION", default_precision).lower()
        if VISION_DEVICE.startswith("cuda"):
            AMP_DTYPE = {"bf16": torch.bfloat16, "fp32": None}.get(precision, torch.float16)
        else:
            AMP_DTYPE = None

        if AMP_DTYPE is not None:
            model = model.to(device=VISION_DEVICE, dtype=AMP_DTYPE)
        else:
            model = model.to(device=VISION_DEVICE)
        logger.info(
            "[MODEL_INIT] precision=%s amp_dtype=%s device_state=%s",
            precision,
            str(AMP_DTYPE),
            _format_gpu_state(),
        )

        # tokenizer for this HF id (falls back to 'siglip' if needed)
        try:
            tokenizer = open_clip.get_tokenizer(MODEL_ID)
        except Exception:
            tokenizer = open_clip.get_tokenizer("siglip")

        # sizes / normalization from model's own preprocess
        model_image_size = getattr(getattr(model, "visual", None), "image_size", None)
        if isinstance(model_image_size, (tuple, list)):
            model_image_size = int(model_image_size[0])
        if not isinstance(model_image_size, int):
            model_image_size = 384

        TARGET_IMAGE_SIZE = int(os.environ.get("VISION_SIZE", str(model_image_size)))
        CROP_SIZE = int(os.environ.get("TTA_CROP_SIZE", str(TARGET_IMAGE_SIZE)))

        scale_factors: List[float] = [1.0]
        if os.environ.get("ENABLE_MULTI_SCALE", "1") != "0":
            raw_factors = os.environ.get("MULTI_SCALE_FACTORS", "1.0,1.35")
            for token in raw_factors.split(","):
                token = token.strip()
                if not token:
                    continue
                try:
                    value = float(token)
                except ValueError:
                    continue
                if value <= 0:
                    continue
                if all(abs(value - existing) > 1e-3 for existing in scale_factors):
                    scale_factors.append(value)
        scale_factors.sort()
        if not any(abs(f - 1.0) <= 1e-3 for f in scale_factors):
            scale_factors.insert(0, 1.0)
        IMAGE_SCALE_FACTORS = scale_factors
        logger.info(
            "[MODEL_INIT] multi_scale_factors=%s (target_size=%d, crop_size=%d, tta_enabled=%s)",
            ",".join(f"{f:.2f}" for f in IMAGE_SCALE_FACTORS),
            TARGET_IMAGE_SIZE,
            CROP_SIZE,
            os.environ.get("ENABLE_TTA", "1") != "0",
        )

        mean, std = [0.48145466, 0.4578275, 0.40821073], [0.26862954, 0.26130258, 0.27577711]
        if hasattr(preprocess, "transforms"):
            for t in preprocess.transforms:  # type: ignore[attr-defined]
                if isinstance(t, transforms.Normalize):
                    mean = list(t.mean)
                    std = list(t.std)
                    break
        global NORM_MEAN_VALUES, NORM_STD_VALUES
        NORM_MEAN_VALUES = mean
        NORM_STD_VALUES = std
        _NORM_CACHE.clear()
        # Base (original) preprocessing pipeline retained separately to avoid recursion
        base_preprocess = transforms.Compose([
            transforms.Resize(TARGET_IMAGE_SIZE, interpolation=transforms.InterpolationMode.BICUBIC),
            transforms.CenterCrop(TARGET_IMAGE_SIZE),
            transforms.ToTensor(),
            transforms.Normalize(mean=mean, std=std),
        ])

        # Store on globals for potential external inspection / debug
        globals()['_base_preprocess'] = base_preprocess  # type: ignore

        # Adaptive wrapper: only resize/distort tiny images; never reference the wrapper itself
        def _adaptive_preprocess(img: Image.Image):  # type: ignore
            """Adaptive preprocessing.

            - If the smallest side >= TARGET_IMAGE_SIZE -> use base pipeline (resize+center crop)
            - If smaller -> upscale directly to square TARGET_IMAGE_SIZE (keeps it deterministic)
            The previous version reassigned _preprocess then referenced it inside, causing infinite
            recursion on large images. Here we always call base_preprocess explicitly.
            """
            min_dim = min(img.width, img.height)
            if min_dim < TARGET_IMAGE_SIZE:
                # Fast path for small images (single resize to square)
                return transforms.Compose([
                    transforms.Resize((TARGET_IMAGE_SIZE, TARGET_IMAGE_SIZE), interpolation=transforms.InterpolationMode.BICUBIC),
                    transforms.ToTensor(),
                    transforms.Normalize(mean=mean, std=std),
                ])(img)
            return base_preprocess(img)

        # Expose adaptive as the active preprocess callable (not a Compose anymore)
        globals()['_preprocess'] = _adaptive_preprocess  # type: ignore

        VISION_MODEL = model
        TEXT_MODEL = model
        TEXT_TOKENIZER = tokenizer

        dim = getattr(model, "embed_dim", None)
        if dim is None and hasattr(model, "text") and hasattr(model.text, "output_dim"):
            dim = getattr(model.text, "output_dim")
        if dim is None and hasattr(model, "text") and hasattr(model.text, "proj"):
            proj = getattr(model.text, "proj")
            if hasattr(proj, "out_features"):
                dim = proj.out_features
        TARGET_DIM = int(dim or int(os.environ.get("EMBED_DIM", "768")))
        logger.info(
            "[MODEL_INIT] model_ready id=%s dim=%d device=%s precision=%s multi_scale=%s",
            MODEL_ID,
            TARGET_DIM,
            VISION_DEVICE,
            str(AMP_DTYPE or "fp32"),
            ",".join(f"{f:.2f}" for f in IMAGE_SCALE_FACTORS),
        )

    except Exception as e:
        hint = (
            "Set VISION_MODEL_ID to a reachable EVA02/EVA/CLIP/SigLIP checkpoint converted for OpenCLIP "
            "or export HF_TOKEN if gated. "
            f"Current MODEL_ID='{MODEL_ID}'."
        )
        logger.error("[MODEL_INIT] load failure model=%s error=%s hint=%s", MODEL_ID, e, hint)
        raise RuntimeError(f"failed to load model '{MODEL_ID}': {e}") from e


def load_and_preprocess(image_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def _project_embedding(vec: torch.Tensor) -> torch.Tensor:
    if TARGET_DIM is None:
        raise RuntimeError("model not initialised; call load_model() first")
    vec = vec.float()
    if vec.ndim != 1:
        raise ValueError(f"expected 1D embedding tensor, got shape {tuple(vec.shape)}")
    current = vec.shape[0]
    if current != TARGET_DIM:
        raise ValueError(f"embedding dim {current} != target {TARGET_DIM}")
    return F.normalize(vec, dim=-1)


def embed_image_bytes(image_bytes: bytes) -> List[float]:
    start = time.perf_counter()
    load_model()
    logger.debug(
        "[MODEL_EMBED_IMAGE] ingest bytes=%d device=%s scales=%s",
        len(image_bytes),
        VISION_DEVICE,
        ",".join(f"{f:.2f}" for f in IMAGE_SCALE_FACTORS),
    )

    img = load_and_preprocess(image_bytes)
    enable_tta = os.environ.get("ENABLE_TTA", "1") != "0"
    max_ratio = float(os.environ.get("PANORAMA_MAX_RATIO", "2.6"))
    tiles: List[Image.Image] = []
    aspect_ratio = img.width / max(img.height, 1)
    if aspect_ratio >= max_ratio:
        n_tiles = 3 if aspect_ratio >= max_ratio * 1.5 else 2
        tile_w = img.width // max(n_tiles, 1)
        for i in range(n_tiles):
            left = i * tile_w
            right = img.width if i == n_tiles - 1 else (i + 1) * tile_w
            tiles.append(img.crop((left, 0, right, img.height)))
    else:
        tiles.append(img)
    logger.debug(
        "[MODEL_EMBED_IMAGE] tiles=%d aspect_ratio=%.2f tta=%s panorama_threshold=%.2f",
        len(tiles),
        aspect_ratio,
        enable_tta,
        max_ratio,
    )

    crops: List[torch.Tensor] = []
    target_side = CROP_SIZE
    max_multi_dim = int(os.environ.get("MULTI_SCALE_MAX_DIM", "1536"))
    device_str = VISION_DEVICE or "cpu"
    device = torch.device(device_str)
    use_cuda = device.type == "cuda"
    norm_mean, norm_std = _get_norm_tensors(device, torch.float32)
    target_dtype = AMP_DTYPE if AMP_DTYPE is not None and use_cuda else torch.float32

    def _make_crops(tensor: torch.Tensor, crop_size: int, tta: bool) -> List[torch.Tensor]:
        _, _, h, w = tensor.shape
        outs: List[torch.Tensor] = []
        if tta and h >= crop_size and w >= crop_size:
            outs.append(tensor[..., :crop_size, :crop_size].contiguous())
            outs.append(tensor[..., :crop_size, w - crop_size :].contiguous())
            outs.append(tensor[..., h - crop_size :, :crop_size].contiguous())
            outs.append(tensor[..., h - crop_size :, w - crop_size :].contiguous())
            top = max((h - crop_size) // 2, 0)
            left = max((w - crop_size) // 2, 0)
            center = tensor[..., top : top + crop_size, left : left + crop_size]
            if center.shape[-2:] != (crop_size, crop_size):
                center = F.interpolate(center, size=(crop_size, crop_size), mode="bicubic", align_corners=False)
            outs.append(center.contiguous())
        else:
            top = max((h - crop_size) // 2, 0)
            left = max((w - crop_size) // 2, 0)
            crop = tensor[..., top : top + crop_size, left : left + crop_size]
            if crop.shape[-2:] != (crop_size, crop_size):
                crop = F.interpolate(crop, size=(crop_size, crop_size), mode="bicubic", align_corners=False)
            outs.append(crop.contiguous())
        return outs

    transfer_ms = 0.0
    for tile_idx, base in enumerate(tiles):
        base_tensor = TF.pil_to_tensor(base).to(torch.float32).unsqueeze(0) / 255.0
        base_tensor = base_tensor.contiguous(memory_format=torch.channels_last)
        if use_cuda:
            base_tensor = base_tensor.pin_memory()
            transfer_start = time.perf_counter()
            copy_stream = torch.cuda.Stream(device=torch.cuda.current_device())
            with torch.cuda.stream(copy_stream):
                base_tensor_device = base_tensor.to(device, non_blocking=True)
            torch.cuda.current_stream().wait_stream(copy_stream)
            transfer_ms += (time.perf_counter() - transfer_start) * 1000.0
        else:
            base_tensor_device = base_tensor.to(device)
        base_tensor_device = base_tensor_device.contiguous(memory_format=torch.channels_last)
        base_h = base_tensor_device.shape[-2]
        base_w = base_tensor_device.shape[-1]

        for scale_factor in IMAGE_SCALE_FACTORS:
            scaled = base_tensor_device
            if abs(scale_factor - 1.0) > 1e-3:
                new_h = max(1, min(int(round(base_h * scale_factor)), max_multi_dim))
                new_w = max(1, min(int(round(base_w * scale_factor)), max_multi_dim))
                if new_h != base_h or new_w != base_w:
                    scaled = F.interpolate(
                        base_tensor_device,
                        size=(new_h, new_w),
                        mode="bicubic",
                        align_corners=False,
                    )
                logger.debug(
                    "[MODEL_EMBED_IMAGE] tile=%d scale=%.2f resized=%dx%d",
                    tile_idx,
                    scale_factor,
                    int(scaled.shape[-1]),
                    int(scaled.shape[-2]),
                )

            produced = 0
            for crop in _make_crops(scaled, target_side, enable_tta):
                crop = crop.to(torch.float32)
                crop = (crop - norm_mean) / norm_std
                if target_dtype is not torch.float32:
                    crop = crop.to(dtype=target_dtype)
                crops.append(crop.squeeze(0).contiguous(memory_format=torch.channels_last))
                produced += 1

            logger.debug(
                "[MODEL_EMBED_IMAGE] tile=%d scale=%.2f produced=%d", tile_idx, scale_factor, produced
            )

    if not crops:
        raise ValueError("no crops produced")

    prep_elapsed = (time.perf_counter() - start) * 1000.0
    batch = torch.stack(crops).contiguous(memory_format=torch.channels_last)
    if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
        if batch.device.type != "cuda":
            batch = batch.pin_memory()
            transfer_start = time.perf_counter()
            transfer_stream = torch.cuda.Stream(device=torch.cuda.current_device())
            with torch.cuda.stream(transfer_stream):
                batch = batch.to(VISION_DEVICE, non_blocking=True)
                if AMP_DTYPE is not None:
                    batch = batch.to(dtype=AMP_DTYPE, non_blocking=True)
            torch.cuda.current_stream().wait_stream(transfer_stream)
            transfer_ms = (time.perf_counter() - transfer_start) * 1000.0
        elif AMP_DTYPE is not None and batch.dtype != AMP_DTYPE:
            batch = batch.to(dtype=AMP_DTYPE)
    else:
        if batch.device != torch.device(VISION_DEVICE or "cpu"):
            batch = batch.to(VISION_DEVICE or "cpu")
        if AMP_DTYPE is not None and batch.dtype != AMP_DTYPE:
            batch = batch.to(dtype=AMP_DTYPE)

    if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
        torch.cuda.synchronize()
    infer_start = time.perf_counter()
    amp_ctx = (
        torch.autocast("cuda", dtype=AMP_DTYPE)  # type: ignore[arg-type]
        if AMP_DTYPE is not None and VISION_DEVICE and VISION_DEVICE.startswith("cuda")
        else contextlib.nullcontext()
    )
    with torch.no_grad():
        with amp_ctx:
            emb = VISION_MODEL.encode_image(batch)  # type: ignore[attr-defined]
            emb = F.normalize(emb, dim=-1).mean(0)
        emb = _project_embedding(emb)
    if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
        torch.cuda.synchronize()
    infer_elapsed = (time.perf_counter() - infer_start) * 1000.0
    total_elapsed = (time.perf_counter() - start) * 1000.0

    result = emb.cpu().tolist()
    logger.info(
        "[MODEL_EMBED_IMAGE] success crops=%d tiles=%d scales=%d prep_ms=%.2f h2d_ms=%.2f infer_ms=%.2f total_ms=%.2f "
        "norm=%.6f device=%s gpu=%s",
        len(crops),
        len(tiles),
        len(IMAGE_SCALE_FACTORS),
        prep_elapsed,
        transfer_ms,
        infer_elapsed,
        total_elapsed,
        sum(x * x for x in result) ** 0.5,
        VISION_DEVICE,
        _format_gpu_state(),
    )
    return result


def embed_text(text: str) -> List[float]:
    start = time.perf_counter()
    load_model()
    text = (text or "").strip()
    text_preview = text[:48] + "…" if len(text) > 48 else text
    logger.debug(
        "[MODEL_EMBED_TEXT] ingest chars=%d preview='%s' device=%s",
        len(text),
        text_preview,
        VISION_DEVICE,
    )

    if not text:
        if TARGET_DIM is None:
            raise RuntimeError("model not initialised")
        logger.debug("[MODEL_EMBED_TEXT] empty_text -> zero_vector")
        return [0.0] * TARGET_DIM

    ctx_len = getattr(TEXT_MODEL, "context_length", 77)
    if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
        torch.cuda.synchronize()
    tokenize_start = time.perf_counter()
    transfer_ms = 0.0
    with torch.no_grad():
        tokens = TEXT_TOKENIZER([text], context_length=ctx_len)  # type: ignore
        if hasattr(tokens, "to"):
            if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
                transfer_start = time.perf_counter()
                copy_stream = torch.cuda.Stream(device=torch.cuda.current_device())
                with torch.cuda.stream(copy_stream):
                    tokens = tokens.to(VISION_DEVICE, non_blocking=True)  # type: ignore
                torch.cuda.current_stream().wait_stream(copy_stream)
                transfer_ms = (time.perf_counter() - transfer_start) * 1000.0
            else:
                tokens = tokens.to(VISION_DEVICE)  # type: ignore
        elif isinstance(tokens, (list, tuple)):
            tokens = torch.tensor(tokens, device=VISION_DEVICE, dtype=torch.long)
        tokenize_ms = (time.perf_counter() - tokenize_start) * 1000.0

        # Defensive validation: ensure token indices are integers, non-negative
        # and within the tokenizer/model vocabulary. Device-side CUDA asserts
        # (indexSelectLargeIndex) often happen when an index >= vocab_size is
        # passed to an embedding lookup. Raising here gives a clear Python
        # exception and avoids a confusing device assert.
        try:
            # ensure integer dtype
            if isinstance(tokens, torch.Tensor):
                tokens = tokens.long()
            # compute min/max only for tensor inputs
            if isinstance(tokens, torch.Tensor):
                try:
                    min_idx = int(tokens.min().item())
                    max_idx = int(tokens.max().item())
                except Exception:
                    min_idx = None
                    max_idx = None

                if min_idx is not None and min_idx < 0:
                    raise RuntimeError(f"token index negative: min={min_idx}")

                # try to discover vocab size from model token embedding
                vocab_size = None
                te = getattr(TEXT_MODEL, "token_embedding", None)
                if te is not None:
                    if hasattr(te, "num_embeddings"):
                        vocab_size = int(te.num_embeddings)
                    elif hasattr(te, "weight"):
                        vocab_size = int(te.weight.shape[0])

                if vocab_size is not None and max_idx is not None and max_idx >= vocab_size:
                    raise RuntimeError(f"token index {max_idx} >= vocab size {vocab_size}")
        except Exception:
            # log full context and re-raise to surface a clear error instead of a
            # device-side CUDA assert. The caller (FastAPI) will return a 500.
            logger.exception("[MODEL_EMBED_TEXT] token validation failed; tokens=%s", getattr(tokens, 'shape', tokens))
            raise

        amp_ctx = (
            torch.autocast("cuda", dtype=AMP_DTYPE)  # type: ignore[arg-type]
            if AMP_DTYPE is not None and VISION_DEVICE and VISION_DEVICE.startswith("cuda")
            else contextlib.nullcontext()
        )
        if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
            torch.cuda.synchronize()
        infer_start = time.perf_counter()
        with amp_ctx:
            emb = TEXT_MODEL.encode_text(tokens)  # type: ignore[attr-defined]
            v = F.normalize(emb, dim=-1)[0]
        if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
            torch.cuda.synchronize()
        infer_ms = (time.perf_counter() - infer_start) * 1000.0

    v = _project_embedding(v)
    total_ms = (time.perf_counter() - start) * 1000.0
    result = v.cpu().tolist()
    logger.info(
        "[MODEL_EMBED_TEXT] success tokens=%s tokenize_ms=%.2f h2d_ms=%.2f infer_ms=%.2f total_ms=%.2f norm=%.6f device=%s gpu=%s",
        getattr(tokens, "shape", None),
        tokenize_ms,
        transfer_ms,
        infer_ms,
        total_ms,
        sum(x * x for x in result) ** 0.5,
        VISION_DEVICE,
        _format_gpu_state(),
    )
    return result
