# syntax=docker/dockerfile:1
FROM pytorch/pytorch:2.3.1-cuda12.1-cudnn8-runtime AS base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt ./
RUN pip3 install --no-cache-dir -r requirements.txt
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
RUN python3 -c "from app.models import load_model; load_model()"

ENV PYTHONUNBUFFERED=1
EXPOSE 9000
CMD ["python3", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9000"]
