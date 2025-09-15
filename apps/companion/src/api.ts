export interface SearchFilters {
  modality?: string[]
  time_range?: [string, string]
  geo?: { lat: number; lon: number; km: number }
}

export interface SearchResultItem {
  media_id: string
  score: number
  thumb_url?: string
  uri: string
  ts?: string
  lat?: number | null
  lon?: number | null
  modality: string
}

export interface SearchResponse {
  results: SearchResultItem[]
}

const API_BASE = 'http://localhost:8080'

export async function search(user_id: string, text: string, top_k = 12, filters: SearchFilters = {}): Promise<SearchResultItem[]> {
  if (!text.trim()) return []
  const res = await fetch(`${API_BASE}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id, text, top_k, filters })
  })
  if (!res.ok) throw new Error(`search failed: ${res.status}`)
  const data: SearchResponse = await res.json()
  return data.results
}
