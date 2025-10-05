<div align="center">

# Taura - Instant Visual Recall

Find any photo, PDF page, or document in milliseconds while you type.

[![Companion Build & Release](https://github.com/TAURAAI/taura/actions/workflows/companion-release.yml/badge.svg)](https://github.com/TAURAAI/taura/actions/workflows/companion-release.yml)
</div>

## Table of Contents
- [Overview](#overview)
- [Current Status](#-current-status-oct-2025)
- [Architecture Overview](#-architecture-overview)
- [Repository Setup](#repository-setup-final-submission)
- [Local Development](#-local-development)
- [Deployment](#deployment-current-state)
- [API](#-api-currently-implemented)
- [Retrieval-Core SDK](#-retrieval-core-sdk-taura-airetrieval-core)
- [Submissions](#5-submissions)
- [License](#-license)

## Overview
Taura combines multi-modal embeddings with time and place heuristics to surface the exact media you are thinking of - directly from any text box (overlay) or the desktop companion. Taura also has a keyboard built in Kotlin for Android, which is still a WIP.

## 🔍 Current Status (Oct 2025)
| Area | Status | Notes |
|------|--------|-------|
| Companion (scan • overlay • auth) | ✅ Working | Recursive scan (throttled), cinematic onboarding + preview, overlay global shortcut, Google OAuth; overlay routing fixed |
| Preview Experience | ✅ Polished | Local image previews via data URLs (no local-resource errors), cinematic ImageTrail with vignette, clear CTAs |
| Media Enumeration | ✅ Basic | File-extension modality: image/pdf_page/video; EXIF/GPS/OCR extraction planned |
| Streaming Sync (/sync/stream) | ✅ Implemented | NDJSON upsert, inline image bytes (<=25MB), queue + depth metrics |
| Embedding (GPU) | ✅ Implemented | SigLIP So400M (1152-dim), multi-crop + panorama tiling; text + image endpoints |
| Search (/search) | ✅ Working | pgvector IVFFlat (lists=100, probes configurable), filters (modality/time/geo/album), keyword fallback |
| Rerank (heuristics) | ✅ Working | Time decay/window, geo boosts, modality prior; retrieval-core exposes typed rerank API |
| retrieval-core SDK | ✅ Published | @taura-ai/retrieval-core: typed client (search/embed), hybridSearch, pgvector helpers, examples+docs |
| Postgres + pgvector | ✅ Working | 1152-dim vectors, dim-check + table recreate, practical indexes (modality/album/geo/not-deleted) |
| Auth schema | ✅ Added | auth_identities, sessions, api_tokens, orgs, org_members, invites, audit_logs in schema |
| Stats (/stats) | ✅ Implemented | media_count, embedded_count, last_indexed_at |
| Privacy Modes | 🧩 Partial | Hybrid implemented; Strict-Local (local embedding) planned |
| Observability | ⏳ Planned | OTel/metrics dashboards not yet wired |
| Mobile Keyboards | 🧪 Skeleton | Android IME stub; iOS extension not started |
| PDF / Video / Audio | ⏳ Planned | PDF raster/keyframes/transcripts not implemented |
| CI Build/Release | ✅ Added | Multi‑platform build pipeline (companion‑release.yml) |

## 🏗 Architecture Overview
Core components:
- Companion App (Tauri v2 / React) - local indexing, UI, optional local vector db.
- API Gateway (Go + Fiber) - search and sync orchestration, auth, metrics.
- Embedder (Python FastAPI) - SigLIP So400M (1152-dim), multi-crop + panorama tiling.
- Postgres + pgvector - primary vector store (1152-d), IVFFlat lists=100.
- Workers (future) - PDF page rasterization, keyframes, transcripts.

Data model (simplified): users / media / media_vecs (vector[1152]) / auth tables (identities, sessions, API tokens), orgs, audit logs.

## 🛠 Local Development

### Prerequisites
Docker Desktop, Node.js 18+, pnpm, Rust toolchain, Go 1.23+, Python 3.9+.

### One-liner (infra + companion only)
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

### Python Setup
```bash
cd services/embedder
pip install -r requirements.txt
```

## Deployment (current state)

- API Gateway (Go Fiber): deployed on a dedicated VM behind HTTPS. Probes for pgvector IVFFlat are configurable via `SEARCH_IVFFLAT_PROBES` (capped at lists=100).
- Embedding microservice (Python FastAPI): deployed on Runpod A40 GPU pod. Uses SigLIP So400M (1152-dim) with multi-crop and panorama tiling.
- Postgres + pgvector: managed on the VM or a hosted Postgres instance, with `media_vecs` dimension 1152 and IVFFlat index `lists=100`.

## 🔐 Privacy Modes (Design)
- Strict-Local: Only metadata + (optionally) text embeddings leave device; images embedded locally (future).
- Hybrid (default for MVP): Images/PDF pages sent (or presigned) to server for embedding; only vectors + thumbs stored.

## 🔎 Retrieval Flow
1. User types a query - API Gateway calls the Embedder to embed text (1152-dim).
2. Gateway runs pgvector ANN (IVFFlat, cosine, probes configurable) with filters (modality, time range, geo, album) and selects a candidate pool.
3. Gateway applies lightweight heuristic rerank (time decay or window, geo boosts, modality prior) and returns top N with metadata and thumbnail URIs.
4. If vector search is low confidence or empty, a keyword fallback (URI, album, source) is used and results are reranked.
5. Optional: clients can apply additional reranking using @taura-ai/retrieval-core (hybridSearch) if desired.

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
Tagged release (vX.Y.Z) will trigger multi-platform build (Windows .msi/.exe, macOS .dmg/.app, Linux AppImage/Deb/RPM) via GitHub Actions using `@tauri-apps/cli`. Artifacts uploaded to a draft GitHub Release; optional notarization/signing steps can be added later.

Download installers from GitHub Releases and install:
- https://github.com/TAURAAI/taura/releases

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
packages/retrieval-core # Typed SDK (client, rerank, sql helpers)
```

## 🚀 Roadmap (Next Milestones)
- [ ] Implement /stats handler (media counts, last indexed timestamps)
- [ ] Thumbnail generation + storage (incl. PDF raster pages)
- [ ] PDF page splitting & per-page embedding
- [ ] Add auth token issuance (JWT or PASETO) and session renewal
- [ ] Strict-Local mode (local embedding fallback / model packaging)
- [ ] Metrics + tracing (OpenTelemetry) and p95 dashboards
- [ ] Evaluation harness (Recall@10, MRR) with curated test set
- [ ] Android IME integration calling /search (debounced)
- [ ] Cross-encoder rerank (top-K ~200) optional toggle
- [ ] Rate limiting & abuse protections
- [ ] Keyframe extraction for video, transcript ingestion for audio/video
- [ ] Encryption / secure at-rest local cache (future)