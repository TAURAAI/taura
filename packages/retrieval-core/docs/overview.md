# Retrieval Core — Overview

Retrieval Core contains small, focused primitives to build Taura‑style recall:

- Vector scoring (cosine)
- Lightweight reranking (time/geo/modality priors)
- SQL builders for pgvector
- A typed Taura API client and a hybrid search helper

It’s framework‑agnostic and ships fully typed ESM + CJS + d.ts.

## Reranking philosophy

1. Candidate generation via ANN (pgvector or Qdrant) → top‑K.
2. Cheap rerank combining:
   - Cosine similarity
   - Time bias (decay or window)
   - Geo proximity (haversine)
   - Modality priors
3. Optional cross‑encoder in a second pass (future extension).

## When to use client‑side rerank

- You already have a fast vector store and want a small relevance lift.
- You want to tailor bias without changing server code (e.g., recency‑heavy for chats; geo‑heavy for trip albums).
- You need deterministic, portable logic you can run anywhere.

See `examples/` for runnable scripts.
