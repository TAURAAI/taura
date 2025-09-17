import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision import transforms
from PIL import Image
from typing import List, Optional, Callable
import contextlib
import io
import os

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


def load_model(device: str = None) -> None:
    global VISION_MODEL, VISION_DEVICE, TEXT_MODEL, TEXT_TOKENIZER
    global _preprocess, TARGET_DIM, TARGET_IMAGE_SIZE, CROP_SIZE, AMP_DTYPE

    if VISION_MODEL is not None:
        return

    VISION_DEVICE = device or _get_device()
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

        mean, std = [0.48145466, 0.4578275, 0.40821073], [0.26862954, 0.26130258, 0.27577711]
        if hasattr(preprocess, "transforms"):
            for t in preprocess.transforms:  # type: ignore[attr-defined]
                if isinstance(t, transforms.Normalize):
                    mean = list(t.mean)
                    std = list(t.std)
                    break
        _preprocess = transforms.Compose([
            transforms.Resize(TARGET_IMAGE_SIZE, interpolation=transforms.InterpolationMode.BICUBIC),
            transforms.CenterCrop(TARGET_IMAGE_SIZE),
            transforms.ToTensor(),
            transforms.Normalize(mean=mean, std=std),
        ])

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

    except Exception as e:
        hint = (
            "Set VISION_MODEL_ID to a reachable EVA02/EVA/CLIP/SigLIP checkpoint converted for OpenCLIP "
            "or export HF_TOKEN if gated. "
            f"Current MODEL_ID='{MODEL_ID}'."
        )
        print(f"[embedder] open-clip vision load failed: {e}\n{hint}")
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
    load_model()
    img = load_and_preprocess(image_bytes)

    enable_tta = os.environ.get("ENABLE_TTA", "1") != "0"
    max_ratio = float(os.environ.get("PANORAMA_MAX_RATIO", "2.6"))

    tiles: List[Image.Image] = []
    if img.width / max(img.height, 1) >= max_ratio:
        n_tiles = 3 if img.width / max(img.height, 1) >= max_ratio * 1.5 else 2
        tile_w = img.width // n_tiles
        for i in range(n_tiles):
            left = i * tile_w
            right = img.width if i == n_tiles - 1 else (i + 1) * tile_w
            tiles.append(img.crop((left, 0, right, img.height)))
    else:
        tiles.append(img)

    crops = []
    target_side = CROP_SIZE
    for base in tiles:
        if enable_tta:
            try:
                for c in transforms.FiveCrop(target_side)(base):
                    crops.append(_preprocess(c))
            except Exception:
                crops.append(_preprocess(base))
        else:
            crops.append(_preprocess(base))

    if not crops:
        raise ValueError("no crops produced")

    batch = torch.stack(crops)
    if VISION_DEVICE and VISION_DEVICE.startswith("cuda"):
        batch = batch.pin_memory()
    batch = batch.to(VISION_DEVICE, non_blocking=True)
    if AMP_DTYPE is not None:
        batch = batch.to(dtype=AMP_DTYPE)

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
    return emb.cpu().tolist()


def embed_text(text: str) -> List[float]:
    load_model()
    text = (text or "").strip()
    if not text:
        if TARGET_DIM is None:
            raise RuntimeError("model not initialised")
        return [0.0] * TARGET_DIM

    ctx_len = getattr(TEXT_MODEL, "context_length", 77)
    with torch.no_grad():
        tokens = TEXT_TOKENIZER([text], context_length=ctx_len)  # type: ignore
        if hasattr(tokens, "to"):
            tokens = tokens.to(VISION_DEVICE, non_blocking=True)  # type: ignore
        elif isinstance(tokens, (list, tuple)):
            tokens = torch.tensor(tokens, device=VISION_DEVICE, dtype=torch.long)
        amp_ctx = (
            torch.autocast("cuda", dtype=AMP_DTYPE)  # type: ignore[arg-type]
            if AMP_DTYPE is not None and VISION_DEVICE and VISION_DEVICE.startswith("cuda")
            else contextlib.nullcontext()
        )
        with amp_ctx:
            emb = TEXT_MODEL.encode_text(tokens)  # type: ignore[attr-defined]
            v = F.normalize(emb, dim=-1)[0]
        v = _project_embedding(v)
    return v.cpu().tolist()
