# syntax=docker/dockerfile:1
FROM pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local UV_LINK_MODE=copy sh
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN UV_EXTRA_INDEX_URL=https://download.pytorch.org/whl/cu121 \
    uv sync --frozen --no-dev
ENV VIRTUAL_ENV="/app/.venv"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY app ./app

# Set environment variables (before warm-up to ensure correct checkpoint is fetched)
ENV VISION_MODEL_ID="hf-hub:timm/ViT-SO400M-14-SigLIP-384"
ENV VISION_SIZE="384"
ENV ENABLE_TTA="1"
ENV ENABLE_MULTI_SCALE="1"
ENV MULTI_SCALE_FACTORS="1.0,1.35"
ENV MULTI_SCALE_MAX_DIM="1536"
ENV PANORAMA_MAX_RATIO="2.6"
ENV MODEL_PRECISION="bf16"

# Pre-download the model
RUN python -c "from app.models import load_model; load_model()"

ENV PYTHONUNBUFFERED=1
EXPOSE 9000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9000"]
