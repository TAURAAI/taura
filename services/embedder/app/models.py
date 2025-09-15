import torch
import torch.nn as nn
from torchvision import transforms
from PIL import Image
from typing import List
import io

# Placeholder model: in production replace with SigLIP-2 ViT-L/14 loading logic
# We simulate an encoder that outputs 768-dim vectors.

class DummyVisionEncoder(nn.Module):
    def __init__(self, dim: int = 768):
        super().__init__()
        self.dim = dim
        self.backbone = nn.Sequential(
            nn.Conv2d(3, 32, 3, stride=2, padding=1),
            nn.ReLU(),
            nn.AdaptiveAvgPool2d((1,1)),
        )
        self.head = nn.Linear(32, dim)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        z = self.backbone(x)
        z = z.flatten(1)
        z = self.head(z)
        z = nn.functional.normalize(z, dim=-1)
        return z

_preprocess = transforms.Compose([
    transforms.Resize(576),
    transforms.CenterCrop(576),
    transforms.ToTensor(),
])

VISION_MODEL: DummyVisionEncoder | None = None


def load_vision_model(device: str = "cuda" if torch.cuda.is_available() else "cpu"):
    global VISION_MODEL
    if VISION_MODEL is None:
        VISION_MODEL = DummyVisionEncoder().to(device).eval()
    return VISION_MODEL, device


def load_and_preprocess(image_bytes: bytes) -> Image.Image:
    return Image.open(io.BytesIO(image_bytes)).convert("RGB")


def embed_image_bytes(image_bytes: bytes) -> List[float]:
    model, device = load_vision_model()
    img = load_and_preprocess(image_bytes)
    # 5-crop TTA (simplified: center + four corners via FiveCrop)
    tta = transforms.FiveCrop(512)
    crops = tta(img)
    tensors = []
    for c in crops:
        tensors.append(_preprocess(c))
    batch = torch.stack(tensors).to(device)
    with torch.no_grad():
        emb = model(batch)  # (5, 768)
        emb = emb.mean(0)   # average pooling
        emb = nn.functional.normalize(emb, dim=-1)
    return emb.cpu().tolist()

# Text encoder placeholder (should be SigLIP text tower or similar)
class DummyTextEncoder(nn.Module):
    def __init__(self, dim: int = 768):
        super().__init__()
        self.emb = nn.Embedding(30522, dim)
        self.proj = nn.Linear(dim, dim)

    def forward(self, tokens: torch.Tensor):
        x = self.emb(tokens)
        x = x.mean(1)
        x = self.proj(x)
        x = nn.functional.normalize(x, dim=-1)
        return x

TEXT_MODEL: DummyTextEncoder | None = None

def load_text_model(device: str = "cuda" if torch.cuda.is_available() else "cpu"):
    global TEXT_MODEL
    if TEXT_MODEL is None:
        TEXT_MODEL = DummyTextEncoder().to(device).eval()
    return TEXT_MODEL, device

_token_id = 42

def embed_text(text: str) -> List[float]:
    model, device = load_text_model()
    # Extremely naive tokenization placeholder
    tokens = torch.tensor([[(_token_id + i) % 30522 for i, _ in enumerate(text.split()[:128])]] or [[_token_id]]).to(device)
    with torch.no_grad():
        emb = model(tokens)  # (1, 768)
    return emb[0].cpu().tolist()
