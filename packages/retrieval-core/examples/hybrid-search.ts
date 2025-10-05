// Usage:
//   TAURA_BASE_URL=http://localhost:8080 TAURA_TOKEN=... USER_ID=... pnpm -C packages/retrieval-core run examples:hybrid -- "paris eiffel"
import { TauraClient, hybridSearch, type SearchFilters } from '../src/index'

const baseURL = process.env.TAURA_BASE_URL || 'http://localhost:8080'
const token = process.env.TAURA_TOKEN || ''
const userId = process.env.USER_ID || 'user-123'

async function main() {
  const client = new TauraClient({ baseURL, token })
  const text = (process.argv.slice(2).join(' ') || 'paris eiffel').trim()
  const filters: SearchFilters = { modality: ['image', 'pdf_page'] }
  const results = await hybridSearch(
    client,
    userId,
    text,
    filters,
    { applyClientRerank: true, timeBoost: { kind: 'decay', halfLifeDays: 365, weight: 0.08 } }
  )
  // eslint-disable-next-line no-console
  console.log(`Query: ${text}`)
  for (const r of results.slice(0, 12)) {
    // eslint-disable-next-line no-console
    console.log(`${(r.score * 100).toFixed(0)}%\t${r.modality}\t${r.uri}`)
  }
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})

