# Taura Development Setup

## Quick Start (Tauri App Only)

To test the media discovery functionality without backend services:

```bash
# Start just the Tauri companion app
cd apps/companion && pnpm dev
```

This will start the Tauri app which can scan local folders and display media files.

## Full Development Stack

### Prerequisites

1. **Docker Desktop** - Required for database
2. **Go 1.23+** - For API Gateway
3. **Python 3.9+** - For embedding service
4. **Node.js 18+** and **pnpm** - For frontend
5. **Rust** - For Tauri app

### Setup Infrastructure

```bash
# Start PostgreSQL with pgvector
pnpm run dev:infra
```

### Development Commands

```bash
# Start everything (requires Docker, Go, Python)
pnpm run dev:full

# Or start individual services:
pnpm run dev:companion     # Tauri app
pnpm run dev:api-gateway   # Go backend
pnpm run dev:embedder      # Python FastAPI
pnpm run dev:infra         # Docker containers
```

### Environment Setup

#### Python Dependencies
```bash
cd services/embedder
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

#### Go Dependencies
```bash
cd services/api-gateway
go mod download
```

## Architecture

- **Companion App**: Tauri v2 app for media indexing and search UI
- **API Gateway**: Go Fiber service for handling requests
- **Embedder**: Python FastAPI service for generating embeddings
- **Database**: PostgreSQL with pgvector extension

## Current Status

✅ **Working**: Media file discovery and scanning in Tauri app  
🔄 **In Progress**: Backend integration, embedding generation  
🚧 **Todo**: Search functionality, proper folder picker
  schema/             # SQL schema (pg.sql)
infra/
  docker-compose.yml  # Postgres (pgvector) + Adminer
```

## Prerequisites
- Node.js 18+ (pnpm installed globally: `npm i -g pnpm`)
- Rust toolchain (for Tauri)
- Go 1.22+
- Docker Desktop

## First-time Setup
```powershell
# From repo root
pnpm install # (installs root dev deps like turbo if any added later)

# Start database
docker compose -f infra/docker-compose.yml up -d

# Apply schema
# (Install psql if not present; on Windows via winget: winget install PostgreSQL.postgresql)
psql -h localhost -U postgres -d omnirecall -f packages/schema/pg.sql
```

## Run Services
```powershell
# API Gateway
cd services/api-gateway
go run ./cmd/server

# Tauri Companion (separate shell)
cd apps/companion
npm run dev  # or pnpm dev once converted
# In another shell: cargo build will be triggered automatically by tauri when building the desktop app 
```

Visit Adminer: http://localhost:8081 (system: PostgreSQL, server: postgres, user: postgres, password: postgres, db: omnirecall)

## Endpoints (Stub)
- GET `http://localhost:8080/healthz` → "ok"
- POST `http://localhost:8080/search` → `{ results: [] }`
- POST `http://localhost:8080/sync` → `{ upserted: N }`

## Next Steps
- Wire `/search` to real pgvector query + embedding service
- Implement embedding microservice (FastAPI + SigLIP-2)
- Add ingestion logic (folder scan, EXIF extraction, hashing)
- Add filters (time, geo, modality) to `PostSearch`
- Introduce OpenTelemetry, metrics, logging enrichment

## Notes
Tailwind v4 single import directive in `src/styles.css` is deliberate.
Tauri `scan_folder` command currently stubbed.

## Updated Embedding & Search Workflow

1. Companion app scans a folder and calls `/sync` with a list of media items (user_id may be an email; backend resolves a UUID).
2. The API gateway inserts (or resolves) the media row and for `image` and `pdf_page` modalities immediately calls the embedder service.
3. Returned 768‑d embedding is inserted/upserted into `media_vecs`.
4. The overlay UI issues `/search` as you type. Gateway embeds the query text, performs pgvector ANN (`ORDER BY embedding <=> query ASC LIMIT K`).
5. Selecting a result opens the file via a native OS open command and hides the overlay. Press `Esc` to hide overlay at any time.

### Embedder Endpoints (current contract)
`POST /embed/text` JSON `{ "text": "describe a sunset over water" }` → `{ vec: number[768] }`

`POST /embed/image` JSON (preferred during dev): `{ "uri": "C:/path/to/image.jpg" }` (requires env `ALLOW_LOCAL_URI=1`).
Or supply `{ "bytes_b64": "..." }` with base64 image bytes. Multipart file upload also still works.

### Overlay Shortcuts
- Esc: hide overlay window
- Click result: open file & hide overlay

### Pending Enhancements
- Batch embedding in `/sync` (collect N images then call future `/embed/image/batch`)
- Time & geo filters in `/search`
- Background queue for embeddings to keep `/sync` low latency

## License
MIT (adjust as needed)
