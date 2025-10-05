<div align="center">

# Taura

Instant recall of your personal media (photos, PDF pages, documents – more soon) directly from any text box or the global overlay. Type a memory like "paris eiffel 2019" and surface the exact photo or page in under 150 ms.

[![Companion Build & Release](https://github.com/TAURAAI/taura/actions/workflows/companion-release.yml/badge.svg)](https://github.com/TAURAAI/taura/actions/workflows/companion-release.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](#license)

</div>

## ✨ Vision
While you type, Taura suggests the right media instantly. Multi‑modal embeddings + time/place heuristics + lightweight UX (desktop overlay + mobile keyboards).

## 🔍 Current Status (Oct 2025)
| Area | Status | Notes |
|------|--------|-------|
| Tauri Companion (scan + overlay + auth) | ✅ Working | Folder scan (recursive, throttled), NDJSON streaming sync, overlay window + global shortcut, Google OAuth flow (token verify via Google endpoint) |
| Media Enumeration (images / pdf / video tags) | ✅ Basic | Classifies file extension to modality (image, pdf_page, video); EXIF, GPS, OCR not yet extracted |
| Streaming Sync (/sync/stream) | ✅ Implemented | Per-item upsert + inline image bytes (<=25MB) + enqueue embedding batcher & queue depth metrics |
| Embedding Queue + Batch Processor | ✅ Implemented | In‑process queue w/ retries, batch dispatch to /embed/image/batch, persistence to media_vecs |
| Text Embedding Path | ✅ Working | /search calls embedder /embed/text with diagnostics & norm validation |
| Image Embedding Path | ✅ Working | Inline base64 path (hybrid mode) → queue → batch embedding (multi‑scale + crops + panorama tiling) |
| Search Endpoint (/search) | ✅ Working | Vector ANN (IVFFlat) + dynamic probes + keyword fallback + temporal (year/month) rerank & heuristic boosting |
| Filters (modality, time range, geo, album) | ✅ Working | All parsed & applied server‑side in SQL clause construction |
| Keyword Fallback | ✅ Working | When ANN low score / empty, falls back to LIKE over uri/album/source |
| Rerank (light heuristic) | ✅ Working | Score bonuses for keyword/temporal hints; no cross‑encoder yet |
| Postgres + pgvector infra | ✅ Working | Connection pool + ivfflat.probes tuning (env) |
| Auth (Google token verification) | ✅ Basic | ID token verification via Google tokeninfo; returns user UUID (no session JWT yet) |
| Client Auth Persistence | ✅ Minimal | Session stored in companion via local storage (Rust side ensures authenticated before overlay) |
| Stats Endpoint (/stats) | ✅ Implemented | Returns media_count, embedded_count, last_indexed_at (user id/email resolution) |
| PDF Page Rendering | ⏳ Planned | PDF pages currently added as modality=pdf_page but not rendered into thumbnails or split pages |
| Video Keyframes / Audio Transcripts | ⏳ Planned | Not implemented |
| Android IME | 🧪 Skeleton | Project stub only (no runtime search bridging yet) |
| iOS Keyboard Extension | ⏳ Not started | — |
| Privacy Modes | 🧩 Partial | Hybrid implemented (inline bytes). Strict‑Local not yet (no local embedding) |
| Observability (metrics / tracing) | ⏳ Planned | Logging extensive; metrics, OTel not added |
| CI Build / Release | ✅ Added | GitHub Actions multi‑platform build (companion-release.yml) |
| Evaluation Harness | ⏳ Planned | sample_eval.json placeholder only |
| Security Hardening | ⏳ Planned | No authz scopes / rate limiting / JWT yet |

## 🏗 Architecture Overview
Core components (see `AGENTS.md` for exhaustive spec):
- Companion App (Tauri v2 / React) – local indexing, UI, optional local vector db.
- API Gateway (Go + Fiber) – search & sync orchestration, auth, metrics.
- Embedder (Python FastAPI) – SigLIP‑2 / MobileCLIP embeddings (GPU in prod, CPU dev fallback).
- Postgres + pgvector – primary vector store (768‑d).
- Future workers – PDF page rasterization, video keyframes, audio (Whisper) transcripts.

Data model (simplified): `media (meta)` ↔ `media_vecs (embedding vector[768])`.

## 🛠 Local Development

### Prerequisites
Docker Desktop, Node.js 18+, pnpm, Rust toolchain, Go 1.23+, Python 3.9+.

### One‑liner (infra + companion only)
```powershell
pnpm install; pnpm run dev:infra; pnpm run dev:companion
```

### Full Stack (in parallel via Turbo)
```powershell
pnpm install
pnpm run dev:infra
pnpm run dev:full
```

### Individual Services
```powershell
pnpm run dev:infra        # Postgres + pgvector
pnpm run dev:api-gateway  # Go API (localhost:8080)
pnpm run dev:embedder     # FastAPI embedder (localhost:9000)
pnpm run dev:companion    # Desktop overlay + settings
```

### Database Schema Apply
```powershell
psql -h localhost -U postgres -d taura -f packages/schema/pg.sql
```

### Embedder Python Env
```powershell
cd services/embedder
pip install -r requirements.txt
```

## 🔐 Privacy Modes (Design)
- Strict-Local: Only metadata + (optionally) text embeddings leave device; images embedded locally (future).
- Hybrid (default for MVP): Images/PDF pages sent (or presigned) to server for embedding; only vectors + thumbs stored.

## 🔎 Retrieval Flow (MVP)
1. User types query → Gateway embeds text via Embedder.
2. pgvector ANN: IVF (lists=100) cosine → top 200.
3. Return top N (default 12) with metadata & thumbnail URIs.
4. (Phase 2) Rerank with light cross‑encoder.

## 🧪 API (Currently Implemented)
```
GET  /healthz                       -> { status }
POST /auth/google                   -> verify Google id_token, upsert user, return { user_id }
POST /user/upsert                   -> create or fetch user by email (simple helper)
POST /sync                          -> JSON batch (per-item inline) (legacy path)
POST /sync/stream (NDJSON)          -> High-throughput streaming ingest + enqueue embeds
POST /search                        -> ANN + rerank + filters + fallback
GET  /stats?user_id=EMAIL|UUID      -> { user_id, media_count, embedded_count, last_indexed_at }

Embedder Service (FastAPI):
GET  /healthz                       -> { status: ok }
POST /warmup                        -> run model warmup (text+image)
POST /embed/text                    -> { vec, diag }
POST /embed/text/batch              -> { vecs[] }
POST /embed/image (multipart|json)  -> { vec, diag }
POST /embed/image/batch             -> { vecs[], errors[], diagnostics[] }
```

## 🖥 Overlay UX Shortcuts
- Esc: hide overlay
- Click result: open file & hide overlay

## 📦 Build & Release (Planned CI)
Tagged release (vX.Y.Z) will trigger multi‑platform build (Windows .msi/.exe, macOS .dmg/.app, Linux AppImage/Deb/RPM) via GitHub Actions using `@tauri-apps/cli`. Artifacts uploaded to a draft GitHub Release; optional notarization/signing steps can be added later.

### Local Production Build
```powershell
cd apps/companion
pnpm build && pnpm tauri:dev # (replace with tauri build once signing configured)
```

## 📁 Repo Layout (excerpt)
```
apps/companion        # Tauri desktop (React + Vite + Tailwind 4)
services/api-gateway  # Go Fiber gateway
services/embedder     # FastAPI embedding service
packages/schema       # SQL migrations / schema
infra/docker-compose  # Postgres + pgvector
AGENTS.md             # Detailed engineering plan
```

## 🚀 Roadmap (Next Milestones)
- [ ] Implement /stats handler (media counts, last indexed timestamps)
- [ ] Thumbnail generation + storage (incl. PDF raster pages)
- [ ] PDF page splitting & per-page embedding
- [ ] Add auth token issuance (JWT/PASETO) & session renewal
- [ ] Strict‑Local mode (local embedding fallback / model packaging)
- [ ] Metrics + tracing (OpenTelemetry) & p95 dashboards
- [ ] Evaluation harness (Recall@10, MRR) with curated test set
- [ ] Android IME integration calling /search (debounced)
- [ ] Cross‑encoder rerank (top‑K ~200) optional toggle
- [ ] Rate limiting & abuse protections
- [ ] Keyframe extraction for video, transcript ingestion for audio/video
- [ ] Encryption / secure at-rest local cache (future)

## 🤝 Contributing
Early stage. Feel free to open issues or small PRs (lint/tests forthcoming). Please discuss major architectural changes first (see AGENTS.md). Ensure commits keep build green.

## 🧾 License
MIT — see [LICENSE](LICENSE) (subject to change before 1.0 if needed).

## 📝 Appendix: Embedding & Search (Detail)
Companion -> /sync (batch) -> Gateway inserts media rows and calls Embedder for each new image (to be queued later). Query path: text -> /embed/text -> vector -> pgvector ANN using `embedding <=> $query` ordering (cosine). Score returned as `1 - distance` for intuitive ranking.

---
> Generated status updated automatically by maintainers (last manual edit: Oct 2025).
