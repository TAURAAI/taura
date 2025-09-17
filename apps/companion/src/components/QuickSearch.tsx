import { useEffect, useRef, useState } from 'react'
import { search, type SearchResultItem } from '../api'
import { invoke } from '@tauri-apps/api/core'
import { useAppConfig } from '../state/config'

interface QuickSearchProps {
  userId?: string
  onResults?(items: SearchResultItem[]): void
}

export function QuickSearch({ userId, onResults }: QuickSearchProps) {
  const config = useAppConfig()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dRef = useRef<number | null>(null)

  useEffect(() => {
    if (dRef.current) window.clearTimeout(dRef.current)
    if (!query.trim()) { setResults([]); onResults?.([]); return }
    dRef.current = window.setTimeout(async () => {
      setLoading(true); setError(null)
      try {
        const r = await search(userId ?? config.userId, query, 6, {})
        setResults(r)
        onResults?.(r)
      } catch (e: any) {
        setError(e?.message || 'Search failed')
        setResults([]); onResults?.([])
      } finally { setLoading(false) }
    }, 200)
    return () => { if (dRef.current) window.clearTimeout(dRef.current) }
  }, [query, config.userId, userId, onResults])

  return (
    <div className="glass-card quick-search-card p-5 flex flex-col gap-4" aria-labelledby="quick-search-heading">
      <div className="flex items-center justify-between">
        <h2 id="quick-search-heading" className="text-base font-medium text-white">Quick Search</h2>
        <button onClick={() => invoke('toggle_overlay').catch(()=>{})} className="text-[11px] px-2 py-1 rounded bg-white/5 hover:bg-white/10 border border-white/10 transition">Open Overlay</button>
      </div>
      <div>
        <input
          value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type to search..."
            className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white/90 focus:outline-none focus:ring-1 focus:ring-indigo-500 placeholder:text-white/30"
            aria-label="Quick search input"
        />
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      <ul className="flex flex-col divide-y divide-white/5 rounded-md overflow-hidden border border-white/10 bg-white/2">
        {loading && <li className="p-3 text-xs text-white/40">Searching…</li>}
        {!loading && results.length === 0 && query && <li className="p-3 text-xs text-white/40">No matches</li>}
        {!loading && !query && <li className="p-3 text-xs text-white/40">Start typing to see results</li>}
        {results.map(r => (
          <li key={r.media_id} className="group flex items-center gap-3 p-3 text-xs hover:bg-white/5 cursor-pointer"
            onClick={() => invoke('open_file', { path: r.uri }).catch(()=>{})}
          >
            <div className="w-8 h-8 rounded-md bg-white/5 border border-white/10 flex items-center justify-center text-white/50 text-[10px] uppercase">
              {r.modality.startsWith('pdf') ? 'PDF' : r.modality.slice(0,3)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate text-white/80">{r.uri.split(/[\\/]/).pop() || r.uri}</p>
              <p className="truncate text-white/35">{(r.score*100).toFixed(0)}% • {r.modality}</p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
