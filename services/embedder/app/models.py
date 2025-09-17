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

# Optional sentence-transformers backend for text-only encoders (unused unless you wire it up)
try:  # pragma: no cover
    from sentence_transformers import SentenceTransformer  # type: ignore
    _HAS_SENTENCE_TX = True
except Exception:
    SentenceTransformer = None  # type: ignore
    _HAS_SENTENCE_TX = False

# Globals populated at load-time
_preprocess: transforms.Compose = transforms.Compose([
    transforms.Resize(336, interpolation=transforms.InterpolationMode.BICUBIC),
    transforms.CenterCrop(336),
    transforms.ToTensor(),
    transforms.Normalize(mean=[0.48145466, 0.4578275, 0.40821073], std=[0.26862954, 0.26130258, 0.27577711]),
])

VISION_MODEL: Optional[nn.Module] = None
VISION_DEVICE: Optional[str] = None
TEXT_MODEL: Optional[nn.Module] = None
TEXT_TOKENIZER: Optional[Callable] = None
TARGET_DIM: Optional[int] = None
AMP_DTYPE: Optional[torch.dtype] = None

# Default to EVA02-CLIP L/14 @336 (native 768-d)
MODEL_ID: str = os.environ.get(
    "VISION_MODEL_ID",
    "hf-hub:timm/eva02_large_patch14_clip_336.merged2b_s6b_b61k"
)

TARGET_IMAGE_SIZE: int = int(os.environ.get("VISION_SIZE", "336"))
CROP_SIZE: int = int(os.environ.get("TTA_CROP_SIZE", os.environ.get("VISION_SIZE", "336")))
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
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():  # Apple Silicon fallback
        return "mps"
    return "cpu"


def load_model(device: str = None) -> None:
    """
    Load EVA02-CLIP L/14@336 (or env-provided model) with OpenCLIP.
    Synchronizes preprocess, image size, tokenizer, and target embedding dim.
    """
    global VISION_MODEL, VISION_DEVICE, TEXT_MODEL, TEXT_TOKENIZER
    global _preprocess, TARGET_DIM, TARGET_IMAGE_SIZE, CROP_SIZE, AMP_DTYPE

    if VISION_MODEL is not None:
        return

    VISION_DEVICE = device or _get_device()
    if VISION_DEVICE.startswith("cuda"):
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        try:
            torch.set_float32_matmul_precision(os.environ.get("MATMUL_PRECISION", "high"))
        except Exception:
            torch.set_float32_matmul_precision("high")
    else:
        AMP_DTYPE = None

    if not _HAS_OPEN_CLIP:
        raise RuntimeError("open_clip is not installed. `pip install -U open-clip-torch`")

    try:
        # Load model + its recommended preprocess (includes mean/std & 336px sizing for this checkpoint)
        model, preprocess = open_clip.create_model_from_pretrained(MODEL_ID, device=VISION_DEVICE)
        model.eval()

        precision = os.environ.get("MODEL_PRECISION", "fp16").lower()
        if VISION_DEVICE.startswith("cuda"):
            if precision == "bf16":
                AMP_DTYPE = torch.bfloat16
            elif precision == "fp32":
                AMP_DTYPE = None
            else:
                AMP_DTYPE = torch.float16
        else:
            AMP_DTYPE = None

        if AMP_DTYPE is not None:
            model = model.to(device=VISION_DEVICE, dtype=AMP_DTYPE)
        else:
            model = model.to(device=VISION_DEVICE)

        # --- tokenizer with fallback (some HF names aren't recognized as-is) ---
        try:
            tokenizer = open_clip.get_tokenizer(MODEL_ID)
        except Exception:
            # EVA02 uses CLIP BPE; ViT-L-14 tokenizer is compatible
            tokenizer = open_clip.get_tokenizer("ViT-L-14")

        # --- derive sizes from model unless overridden by env ---
        model_image_size = getattr(getattr(model, "visual", None), "image_size", None)
        if isinstance(model_image_size, (tuple, list)):
            model_image_size = int(model_image_size[0])
        if not isinstance(model_image_size, int):
            model_image_size = 336  # sensible default for this checkpoint

        TARGET_IMAGE_SIZE = int(os.environ.get("VISION_SIZE", str(model_image_size)))
        CROP_SIZE = int(os.environ.get("TTA_CROP_SIZE", str(TARGET_IMAGE_SIZE)))

        # --- reuse model's mean/std; keep our pipeline shape (Resize -> CenterCrop -> ToTensor -> Normalize) ---
        mean, std = [0.48145466, 0.4578275, 0.40821073], [0.26862954, 0.26130258, 0.27577711]
        if hasattr(preprocess, "transforms"):
            for t in preprocess.transforms:  # type: ignore
                if isinstance(t, transforms.Normalize):
                    mean = list(t.mean)  # type: ignore
                    std = list(t.std)    # type: ignore
                    break

        _preprocess = transforms.Compose([
            transforms.Resize(TARGET_IMAGE_SIZE, interpolation=transforms.InterpolationMode.BICUBIC),
            transforms.CenterCrop(TARGET_IMAGE_SIZE),
            transforms.ToTensor(),
            transforms.Normalize(mean=mean, std=std),
        ])

        # --- bind globals ---
        VISION_MODEL = model
        TEXT_MODEL = model
        TEXT_TOKENIZER = tokenizer

        # --- determine target embedding dim (EVA02 L/14@336 is 768-d) ---
        dim = getattr(model, "embed_dim", None)
        if dim is None and hasattr(model, "text") and hasattr(model.text, "output_dim"):
            dim = getattr(model.text, "output_dim")
        if dim is None and hasattr(model, "text") and hasattr(model.text, "proj"):
            proj = getattr(model.text, "proj")
            if hasattr(proj, "out_features"):
                dim = proj.out_features
        if dim is None:
            dim = int(os.environ.get("EMBED_DIM", "768"))
        TARGET_DIM = int(dim)

    except Exception as e:  # pragma: no cover
        hint = (
            "Set VISION_MODEL_ID to a reachable EVA02/EVA/CLIP checkpoint or export HF_TOKEN if the repo is gated. "
            f"Current MODEL_ID='{MODEL_ID}'."
        )
        print(f"[embedder] open-clip vision load failed: {e}\n{hint}")
        raise RuntimeError(f"failed to load model '{MODEL_ID}': {e}") from e


def load_and_preprocess(image_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def _project_embedding(vec: torch.Tensor) -> torch.Tensor:
    """Ensure embeddings match TARGET_DIM and are L2-normalised."""
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
    max_ratio = float(os.environ.get("PANORAMA_MAX_RATIO", "2.6"))  # width/height threshold for tiling

    # --- optional panorama tiling ---
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

    # --- crops + preprocessing ---
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

    if len(crops) == 0:
        raise ValueError("no crops produced")

    batch = torch.stack(crops).to(VISION_DEVICE)
    if AMP_DTYPE is not None:
        batch = batch.to(dtype=AMP_DTYPE)
    amp_ctx = (
        torch.autocast("cuda", dtype=AMP_DTYPE)  # type: ignore[arg-type]
        if AMP_DTYPE is not None and VISION_DEVICE and VISION_DEVICE.startswith("cuda")
        else contextlib.nullcontext()
    )
    with torch.no_grad():
        with amp_ctx:
            emb = VISION_MODEL.encode_image(batch)  # type: ignore  # (N, D)
            emb = emb.mean(0)                       # TTA average -> (D,)
        emb = _project_embedding(emb)
    return emb.cpu().tolist()


def embed_text(text: str) -> List[float]:
    load_model()
    text = (text or "").strip()
    if not text:
        if TARGET_DIM is None:
            raise RuntimeError("model not initialised")
        return [0.0] * TARGET_DIM

    with torch.no_grad():
        tokens = TEXT_TOKENIZER([text])  # type: ignore
        # Some tokenizers return tensors, some return lists; ensure device placement
        if hasattr(tokens, "to"):
            tokens = tokens.to(VISION_DEVICE)  # type: ignore
        elif isinstance(tokens, (list, tuple)):
            tokens = torch.tensor(tokens, device=VISION_DEVICE, dtype=torch.long)
        amp_ctx = (
            torch.autocast("cuda", dtype=AMP_DTYPE)  # type: ignore[arg-type]
            if AMP_DTYPE is not None and VISION_DEVICE and VISION_DEVICE.startswith("cuda")
            else contextlib.nullcontext()
        )
        with amp_ctx:
            emb = TEXT_MODEL.encode_text(tokens)   # type: ignore  # (B, D)
            v = emb[0]
        v = _project_embedding(v)
    return v.cpu().tolist()
