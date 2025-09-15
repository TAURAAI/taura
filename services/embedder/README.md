# Embedder Service (Prototype)

FastAPI-based embedding microservice (placeholder models).

TODO: Replace dummy encoders with SigLIP-2 ViT-L/14 + proper text tower.

## Endpoints
- GET `/healthz` -> health status
- POST `/embed/text` {"text": "query"}
- POST `/embed/text/batch` {"texts": ["a","b"]}
- POST `/embed/image` multipart/form-data file=<image>

## Run locally (CPU)
```powershell
cd services/embedder
python -m venv .venv
. .venv/Scripts/Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 9000
```

## Docker (GPU)
```powershell
docker build -t embedder:dev services/embedder
# With NVIDIA runtime
# Ensure NVIDIA Container Toolkit is installed
# On Windows (WSL2) ensure GPU support is enabled

docker run --gpus all -p 9000:9000 embedder:dev
```

## TODO (Upgrade to Production)
- Replace Dummy encoders with real SigLIP-2 (vision + text) weights
- Add batching scheduler combining incoming requests within 10-20ms window
- Add ONNX / TensorRT export path for lower latency
- Add tracing + Prometheus metrics
- Implement 5-crop + optional multi-scale TTA with configurable flag
- Add error budget & p95 latency histogram
