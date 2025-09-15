# Taura Monorepo (OmniRecall MVP)

Monorepo scaffolding for the multimodal recall project: Tauri companion app, Go API gateway, Postgres + pgvector infra.

## Structure
```
apps/
  companion/          # Vite + React + Tailwind v4 + Tauri (src-tauri)
services/
  api-gateway/        # Go Fiber service (/healthz /search /sync)
packages/
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

## License
MIT (adjust as needed)
