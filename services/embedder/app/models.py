import torch
import torch.nn as nn
from torchvision import transforms
from PIL import Image
from typing import List, Optional, Tuple
import io
import os

try:
    import open_clip  # type: ignore
    _HAS_OPEN_CLIP = True
except Exception:  # pragma: no cover
    open_clip = None  # type: ignore
    _HAS_OPEN_CLIP = False

# Optional sentence-transformers backend for text-only encoders
try:  # pragma: no cover
    from sentence_transformers import SentenceTransformer  # type: ignore
    _HAS_SENTENCE_TX = True
except Exception:
    SentenceTransformer = None  # type: ignore
    _HAS_SENTENCE_TX = False

_preprocess = transforms.Compose([
    transforms.Resize(576),
    transforms.CenterCrop(576),
    transforms.ToTensor(),
])

VISION_MODEL: Optional[nn.Module] = None
VISION_DEVICE: Optional[str] = None
TEXT_MODEL: Optional[nn.Module] = None
TEXT_TOKENIZER: Optional[callable] = None


def load_model(device: str = "cuda" if torch.cuda.is_available() else "cpu") -> None:
    global VISION_MODEL, VISION_DEVICE, TEXT_MODEL, TEXT_TOKENIZER, _preprocess
    if VISION_MODEL is not None:
        return

    VISION_DEVICE = device
    if _HAS_OPEN_CLIP:
        try:
            model, preprocess = open_clip.create_model_from_pretrained('hf-hub:timm/ViT-SO400M-14-SigLIP-384', device=device)
            tokenizer = open_clip.get_tokenizer('hf-hub:timm/ViT-SO400M-14-SigLIP-384')
            model.eval()
            
            target = int(os.environ.get("VISION_SIZE", "384"))
            _preprocess = transforms.Compose([
                transforms.Resize(target, interpolation=transforms.InterpolationMode.BICUBIC),
                transforms.CenterCrop(target),
                preprocess.transforms[-1] if hasattr(preprocess, 'transforms') else transforms.ToTensor(),
            ])
            
            VISION_MODEL = model
            TEXT_MODEL = model
            TEXT_TOKENIZER = tokenizer
        except Exception as e:  # pragma: no cover
            print(f"[embedder] open-clip vision load failed: {e}")
            raise e


def load_and_preprocess(image_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def embed_image_bytes(image_bytes: bytes) -> List[float]:
    load_model()
    img = load_and_preprocess(image_bytes)
    enable_tta = os.environ.get("ENABLE_TTA", "1") != "0"
    max_ratio = float(os.environ.get("PANORAMA_MAX_RATIO", "2.6"))  # width/height threshold
    tiles: List[Image.Image] = []
    if img.width / max(img.height, 1) >= max_ratio:
        n_tiles = 3 if img.width / max(img.height,1) >= max_ratio*1.5 else 2
        tile_w = img.width // n_tiles
        for i in range(n_tiles):
            left = i * tile_w
            right = img.width if i == n_tiles-1 else (i+1)*tile_w
            crop = img.crop((left, 0, right, img.height))
            tiles.append(crop)
    else:
        tiles.append(img)
    crops = []
    for base in tiles:
        if enable_tta:
            try:
                for c in transforms.FiveCrop(384)(base):
                    crops.append(_preprocess(c))
            except Exception:
                crops.append(_preprocess(base))
        else:
            crops.append(_preprocess(base))
    batch = torch.stack(crops).to(VISION_DEVICE)
    with torch.no_grad():
        emb = VISION_MODEL.encode_image(batch)  # type: ignore
        emb = emb.mean(0)
        emb = nn.functional.normalize(emb, dim=-1)
    return emb.cpu().tolist()


def embed_text(text: str) -> List[float]:
    load_model()
    text = (text or "").strip()
    if not text:
        return [0.0]*768
    with torch.no_grad():
        tokens = TEXT_TOKENIZER([text]).to(VISION_DEVICE)  # type: ignore
        emb = TEXT_MODEL.encode_text(tokens)  # type: ignore (B, D)
        emb = nn.functional.normalize(emb, dim=-1)
        v = emb[0]
    return v.cpu().tolist()