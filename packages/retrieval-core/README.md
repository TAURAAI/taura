# @taura-ai/retrieval-core

Reusable retrieval primitives for semantic search apps.

This package provides:

- Data types for queries, filters, and media items
- Fast local scoring utilities (cosine similarity, time/geo boosts)
- A light reranker that combines vector similarity + heuristics
- Helpers to generate parameterized pgvector SQL snippets

Install `npm i @taura-ai/retrieval-core` 

## Quick start

```ts
import {
  cosine,
  rerank,
  buildPgvectorCosineQuery,
  TauraClient,
  hybridSearch,
  type MediaItem,
  type RerankOptions,
  type SearchFilters,
} from '@taura-ai/retrieval-core'

const q = Float32Array.from([/* 1152-dim */])
const candidates: MediaItem[] = [
  { id: '1', userId: 'u', modality: 'image', uri: 'file:///a.jpg', embedding: Float32Array.from([...]), ts: '2023-01-02T03:00:00Z', lat: 48.858, lon: 2.295 },
  // ...
]

const opts: RerankOptions = {
  timeBoost: { kind: 'decay', halfLifeDays: 365 },
  geoBoost: { lat: 48.858, lon: 2.294, km: 50, weight: 0.1 },
  modalityPrior: { image: 1.0, pdf_page: 0.9 },
}

const ranked = rerank(q, candidates, opts).slice(0, 12)

// Server-side helper (pgvector cosine ordering)
const sql = buildPgvectorCosineQuery({ tableVec: 'media_vecs', table: 'media' })

// Typed Taura API client
const client = new TauraClient({ baseURL: 'https://api.taura.dev', token: 'Bearer <jwt>' })
const filters: SearchFilters = { modality: ['image', 'pdf_page'] }
const results = await client.search({ user_id: 'user-123', text: 'paris eiffel', top_k: 12, filters })

// Hybrid search: call API then (optionally) rerank client‑side
const hybrid = await hybridSearch(client, 'user-123', 'passport renewal june 2022', { modality: ['image'] }, { applyClientRerank: true })
```

See more in `docs/overview.md` and runnable code in `examples/`.

## API

- `cosine(a, b)`: cosine similarity in [0..1]
- `rerank(queryVec, items, options)`: returns items with `score` sorted desc
- `buildPgvectorCosineQuery(config)`: returns a parameterized SQL string you can use in a prepared statement.

See `src/index.ts` for full typings.
