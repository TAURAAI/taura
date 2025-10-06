# Embedder Service (Prototype)

FastAPI-based embedding microservice (production-tuned models) with on-device multi-scale preprocessing so GPU pipelines stay saturated while keeping CPU load low.

Default build ships with **SigLIP So400M ViT-L/14 @384** (`hf-hub:timm/ViT-SO400M-14-SigLIP-384`) via OpenCLIP, 384 px resize/crop, multi-scale 5-crop TTA, and cosine-normalised **1152-d** outputs tuned for pgvector.

## Endpoints
- GET `/healthz` -> health status
- POST `/embed/text` {"text": "query"}
- POST `/embed/text/batch` {"texts": ["a","b"]}
- POST `/embed/image` multipart/form-data file=<image>

## Run locally (CPU)
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh   # Install uv once per machine
cd services/embedder
UV_EXTRA_INDEX_URL="https://download.pytorch.org/whl/cpu" \
  uv sync --python "$(uv python find --max 3.12 --min 3.10)"
source .venv/bin/activate  # On Windows PowerShell use: .venv/Scripts/Activate.ps1
uv run --no-sync uvicorn app.main:app --reload --port 9000
```

> The `UV_EXTRA_INDEX_URL` ensures CPU-only wheels resolve without needing CUDA locally. Remove it if you have a GPU-capable PyTorch index available.

## Docker (GPU)
```powershell
docker build -t embedder:dev services/embedder
# With NVIDIA runtime
# Ensure NVIDIA Container Toolkit is installed
# On Windows (WSL2) ensure GPU support is enabled

docker run --gpus all -p 9000:9000 embedder:dev
```

## Environment

- `VISION_MODEL_ID` (default `hf-hub:timm/ViT-SO400M-14-SigLIP-384`)
- `VISION_SIZE` (default `384`, override to upsample/downsample)
- `TTA_CROP_SIZE` (defaults to `VISION_SIZE`; set smaller to reduce 5-crop cost or equal for max accuracy)
- `MODEL_PRECISION` (`bf16` default when GPU supports it, accepts `fp16`, `fp32`)
- `ENABLE_MULTI_SCALE` (`1` by default; set `0` to disable the extra scaled passes)
- `MULTI_SCALE_FACTORS` (comma list, default `1.0,1.35`; each factor rescales tiles before crops are generated)
- `MULTI_SCALE_MAX_DIM` (cap for scaled width/height, default `1536`)
- `MATMUL_PRECISION` (`high` by default; set to `medium` for slightly faster matmul with modest quality drop)
- `CUDA_DEVICE` (e.g. `cuda:0` to pin to a specific GPU)
- `ENABLE_TTA` (`1` to run 5-crop + panorama tiling, `0` to disable for latency-sensitive paths)
- `PANORAMA_MAX_RATIO` (split very wide images into tiles; default `2.6`)
- `REQUIRE_CUDA` (`1` by default; set to `0` only if CPU/MPS fallback is acceptable)
- `LOG_LEVEL` / `LOG_FORMAT` to control structured logging ( defaults: `INFO`, `"%(asctime)s | %(levelname)s | %(name)s | %(message)s" )
- Models hosted on Hugging Face may require a valid `HF_TOKEN`; export it inside the container (`export HF_TOKEN=...`) before starting the server if you see 401 errors.

## TODO (Upgrade to Production)
- Add batching scheduler combining incoming requests within 10-20ms window
- Add ONNX / TensorRT export path for lower latency
- Add tracing + Prometheus metrics
- Add lightweight cross-encoder reranker endpoint for top-K refinement
- Add error budget & p95 latency histogram
