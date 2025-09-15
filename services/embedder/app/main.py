from fastapi import FastAPI, UploadFile, File, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import time

from .models import embed_image_bytes, embed_text

app = FastAPI(title="Embedder Service", version="0.1.0")

class TextRequest(BaseModel):
    text: str

class TextBatchRequest(BaseModel):
    texts: List[str]

class ImageURLRequest(BaseModel):
    url: str

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
async def embed_image(file: UploadFile = File(...)):
    data = await file.read()
    try:
        vec = embed_image_bytes(data)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"vec": vec}
