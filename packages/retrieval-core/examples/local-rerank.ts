// Usage:
//   pnpm -C packages/retrieval-core run examples:rerank
import { cosine, rerank, type MediaItem } from '../src/index'

function rndVec(n = 1152): Float32Array {
  return Float32Array.from({ length: n }, () => Math.random() - 0.5)
}

async function main() {
  const query = rndVec()
  const items: MediaItem[] = Array.from({ length: 10 }, (_, i) => ({
    id: String(i + 1),
    userId: 'u',
    modality: 'image',
    uri: `file:///img${i + 1}.jpg`,
    ts: new Date(Date.now() - Math.random() * 1000 * 60 * 60 * 24 * 365).toISOString(),
    lat: 48.858 + (Math.random() - 0.5) * 0.02,
    lon: 2.294 + (Math.random() - 0.5) * 0.02,
    embedding: rndVec(),
  }))

  const ranked = rerank(query, items, {
    timeBoost: { kind: 'decay', halfLifeDays: 180, weight: 0.06 },
    geoBoost: { lat: 48.858, lon: 2.294, km: 3, weight: 0.08 },
    modalityPrior: { image: 0.02 },
  })

  // eslint-disable-next-line no-console
  console.table(ranked.slice(0, 5).map(r => ({ id: r.id, score: Number(r.score.toFixed(3)), ts: r.ts })))
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e)
  process.exit(1)
})
