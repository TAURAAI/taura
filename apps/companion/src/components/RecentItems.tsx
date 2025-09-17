import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

interface RecentItem {
  uri: string
  modality: string
  ts?: string
  score?: number
}

// Placeholder: in future, call a dedicated recent endpoint; for now
// we reuse a trivial stored list from backend (if implemented) or fallback to local store.
export function RecentItems() {
  const [items, setItems] = useState<RecentItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        // placeholder invoke (will silently fail if command missing)
        const recents = await invoke<RecentItem[] | null>('recent_items').catch(()=>null)
        if (!active) return
        if (recents && recents.length) setItems(recents)
        else setItems([])
      } catch (e: any) {
        if (!active) return
        setError(e?.message || 'Failed to load recents')
        setItems([])
      }
    })()
    return () => { active = false }
  }, [])

  return (
    <div className="glass-card p-5 flex flex-col gap-4" aria-labelledby="recent-items-heading">
      <div className="flex items-center justify-between">
        <h2 id="recent-items-heading" className="text-base font-medium text-white">Recent Items</h2>
        <span className="text-[10px] text-white/40 uppercase tracking-wide">Alpha</span>
      </div>
      {error && <div className="text-xs text-red-400">{error}</div>}
      {!error && items === null && <div className="text-xs text-white/40">Loading…</div>}
      {!error && items?.length === 0 && <div className="text-xs text-white/40">No recent activity yet</div>}
      <ul className="flex flex-col gap-2">
        {items && items.map(it => (
          <li key={it.uri} className="flex items-center gap-3 text-xs text-white/70 truncate">
            <div className="w-6 h-6 rounded bg-white/5 border border-white/10 flex items-center justify-center text-[9px] text-white/50">
              {it.modality.slice(0,3).toUpperCase()}
            </div>
            <span className="truncate flex-1">{it.uri.split(/[\\/]/).pop() || it.uri}</span>
            {it.score !== undefined && <span className="text-white/30">{(it.score*100).toFixed(0)}%</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}
