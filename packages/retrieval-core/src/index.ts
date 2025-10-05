export type Modality = 'image' | 'pdf_page' | 'doc' | 'audio_seg' | 'video_kf' | 'text'

export interface MediaItem {
  id: string
  userId: string
  modality: Modality
  uri: string
  thumbUrl?: string | null
  ts?: string | null // ISO8601
  lat?: number | null
  lon?: number | null
  album?: string | null
  embedding?: Float32Array // 768-d default
}

export interface TimeBoostDecay {
  kind: 'decay'
  halfLifeDays: number // recency bias
  weight?: number // default 0.1
}

export interface TimeBoostWindow {
  kind: 'window'
  start?: string // ISO
  end?: string // ISO
  weight?: number // default 0.15
}

export interface GeoBoost {
  lat: number
  lon: number
  km: number
  weight?: number // default 0.1
}

export interface RerankOptions {
  timeBoost?: TimeBoostDecay | TimeBoostWindow
  geoBoost?: GeoBoost
  modalityPrior?: Partial<Record<Modality, number>>
  embeddingDim?: number // default 768
}

export interface RankedItem extends MediaItem { score: number }

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function toRad(deg: number) { return deg * Math.PI / 180 }

function timeBoostScore(item: MediaItem, opt: TimeBoostDecay | TimeBoostWindow): number {
  if (!item.ts) return 0
  const t = new Date(item.ts).getTime()
  if (!isFinite(t)) return 0
  if (opt.kind === 'decay') {
    const now = Date.now()
    const dtDays = Math.max(0, (now - t) / (1000 * 60 * 60 * 24))
    const half = Math.max(1, opt.halfLifeDays)
    const val = Math.exp(-Math.LN2 * (dtDays / half))
    return (opt.weight ?? 0.1) * val
  } else {
    const start = opt.start ? new Date(opt.start).getTime() : -Infinity
    const end = opt.end ? new Date(opt.end).getTime() : Infinity
    const inside = t >= start && t <= end
    return inside ? (opt.weight ?? 0.15) : 0
  }
}

function geoBoostScore(item: MediaItem, opt: GeoBoost): number {
  if (item.lat == null || item.lon == null) return 0
  const d = haversineKm(item.lat, item.lon, opt.lat, opt.lon)
  const within = d <= opt.km
  if (!within) return 0
  const val = 1 - (d / Math.max(1e-6, opt.km))
  return (opt.weight ?? 0.1) * Math.max(0, val)
}

export function rerank(queryVec: Float32Array, items: MediaItem[], opts: RerankOptions = {}): RankedItem[] {
  const prior = opts.modalityPrior || {}
  const out: RankedItem[] = []
  for (const it of items) {
    let score = 0
    if (it.embedding && it.embedding.length) {
      score = cosine(queryVec, it.embedding)
    }
    if (opts.timeBoost) score += timeBoostScore(it, opts.timeBoost)
    if (opts.geoBoost) score += geoBoostScore(it, opts.geoBoost)
    if (prior[it.modality] != null) score += Number(prior[it.modality])
    out.push({ ...it, score })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}

export interface PgQueryConfig {
  tableVec: string // e.g. media_vecs
  table: string // e.g. media
}

export function buildPgvectorCosineQuery(cfg: PgQueryConfig): string {
  // Parameter order: $1 embedding, $2 user_id, $3 from_ts, $4 to_ts, $5 modality[], $6 limit
  return `
SELECT m.id,
       1 - (v.embedding <=> $1) AS score,
       m.thumb_url, m.uri, m.ts, m.lat, m.lon, m.modality
FROM ${cfg.tableVec} v
JOIN ${cfg.table} m ON m.id = v.media_id
WHERE m.user_id = $2 AND m.deleted = false
  AND ($3::timestamptz IS NULL OR m.ts >= $3)
  AND ($4::timestamptz IS NULL OR m.ts <= $4)
  AND (COALESCE($5::text[], ARRAY[]::text[]) = ARRAY[]::text[] OR m.modality = ANY($5))
ORDER BY v.embedding <=> $1 ASC
LIMIT $6;`.trim()
}

// --- Taura API (typed client) ---

export interface SearchGeoFilter { lat: number; lon: number; km: number }
export interface SearchFilters {
  modality?: Modality[]
  time_range?: [string | null, string | null]
  geo?: SearchGeoFilter
  album?: string
}

export interface SearchRequest {
  user_id: string
  text: string
  top_k?: number
  filters?: SearchFilters
}

export interface SearchResultItem {
  media_id: string
  score: number
  thumb_url?: string | null
  uri: string
  ts?: string | null
  lat?: number | null
  lon?: number | null
  modality: Modality
}

export interface SearchResponse extends Array<SearchResultItem> {}

export interface EmbedTextRequest { text: string }
export interface EmbedImageRequest { bytes_b64?: string; url?: string }
export interface EmbedResponse { vec: number[] }

export interface TauraClientOptions {
  baseURL: string // e.g., https://api.taura.dev
  token?: string // Bearer token
  fetchFn?: typeof fetch
  timeoutMs?: number
}

export class TauraClient {
  readonly baseURL: string
  readonly token?: string
  private fetchFn: typeof fetch
  private timeoutMs: number

  constructor(opts: TauraClientOptions) {
    this.baseURL = opts.baseURL.replace(/\/$/, '')
    this.token = opts.token
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch?.bind(globalThis) as typeof fetch)
    if (!this.fetchFn) throw new Error('No fetch available; provide opts.fetchFn')
    this.timeoutMs = opts.timeoutMs ?? 10_000
  }

  private headers(): HeadersInit {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.token) h['Authorization'] = `Bearer ${this.token}`
    return h
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      const res = await this.fetchFn(`${this.baseURL}${path}`, { ...init, signal: ctrl.signal })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${res.statusText}: ${txt}`)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(t)
    }
  }

  async search(req: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>('/search', {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(req),
    })
  }

  async embedText(text: string): Promise<Float32Array> {
    const out = await this.request<EmbedResponse>('/embed/text', {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ text } satisfies EmbedTextRequest),
    })
    return Float32Array.from(out.vec)
  }

  async embedImageBytes(bytes: Uint8Array): Promise<Float32Array> {
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.slice(i, i + chunk))
    }
    const b64 = (typeof btoa !== 'undefined'
      ? btoa(binary)
      : (globalThis as any).Buffer.from(bytes).toString('base64'))
    const out = await this.request<EmbedResponse>('/embed/image', {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ bytes_b64: b64 } satisfies EmbedImageRequest),
    })
    return Float32Array.from(out.vec)
  }

  async embedImageUrl(url: string): Promise<Float32Array> {
    const out = await this.request<EmbedResponse>('/embed/image', {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ url } satisfies EmbedImageRequest),
    })
    return Float32Array.from(out.vec)
  }
}

export interface HybridSearchOptions extends RerankOptions {
  topK?: number
  applyClientRerank?: boolean
}

export async function hybridSearch(
  client: TauraClient,
  userId: string,
  text: string,
  filters: SearchFilters = {},
  opts: HybridSearchOptions = {}
): Promise<RankedItem[]> {
  const topK = opts.topK ?? 24
  const results = await client.search({ user_id: userId, text, top_k: topK, filters })
  if (!opts.applyClientRerank) {
    return results.map(r => ({
      id: r.media_id,
      userId,
      modality: r.modality,
      uri: r.uri,
      thumbUrl: r.thumb_url ?? undefined,
      ts: r.ts ?? undefined,
      lat: r.lat ?? undefined,
      lon: r.lon ?? undefined,
      score: r.score,
    }))
  }
  const q = await client.embedText(text)
  const items: MediaItem[] = results.map(r => ({
    id: r.media_id,
    userId,
    modality: r.modality,
    uri: r.uri,
    thumbUrl: r.thumb_url ?? undefined,
    ts: r.ts ?? undefined,
    lat: r.lat ?? undefined,
    lon: r.lon ?? undefined,
  }))
  return rerank(q, items, opts)
}
