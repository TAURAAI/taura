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
  album?: string | null
  source?: string | null
}

export interface SearchResponse {
  results: SearchResultItem[]
}

import { getApiBase, getUserId } from './state/config'

export async function search(user_id: string | undefined, text: string, top_k = 12, filters: SearchFilters = {}): Promise<SearchResultItem[]> {
  if (!text.trim()) return []
  const base = getApiBase()
  const effectiveUser = (user_id ?? getUserId()).trim()
  const res = await fetch(`${base}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: effectiveUser, text, top_k, filters })
  })
  if (!res.ok) throw new Error(`search failed: ${res.status}`)
  const data: SearchResponse = await res.json()
  return data.results
}

export interface StatsResponse {
  user_id: string
  media_count: number
  embedded_count: number
  last_indexed_at?: string | null
}

export async function fetchStats(user_id?: string): Promise<StatsResponse> {
  const base = getApiBase()
  const effectiveUser = (user_id ?? getUserId()).trim()
  const res = await fetch(`${base}/stats?user_id=${encodeURIComponent(effectiveUser)}`)
  if (!res.ok) throw new Error(`stats failed: ${res.status}`)
  return res.json()
}
