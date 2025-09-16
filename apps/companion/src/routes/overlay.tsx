import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { search } from '../api'
import type { SearchResultItem } from '../api'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'

export const Route = createFileRoute('/overlay')({
  component: OverlayNew,
})

function OverlayNew() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  // dynamic height adjust
  useDynamicHeight(results, searching, query)

  const debounceRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }

    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    debounceRef.current = window.setTimeout(async () => {
      try {
  setSearching(true)
        const r = await search('user', query, 6, {})
        setResults(r)
      } catch (e) {
        console.error(e)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [query])

  // Listen for global shortcut events
  useEffect(() => {
    const setupListener = async () => {
      try {
        await listen('toggle-overlay', () => {
          if (inputRef.current) {
            inputRef.current.focus()
          }
        })
      } catch (e) {
        console.error('Failed to setup global shortcut listener:', e)
      }
    }
    void setupListener()

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        invoke('toggle_overlay').catch(() => {})
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx(i => Math.min(i + 1, results.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx(i => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        if (results[activeIdx]) {
          invoke('open_file', { path: results[activeIdx].uri }).then(() => invoke('toggle_overlay').catch(()=>{}))
        }
      }
    }
    window.addEventListener('keydown', keyHandler)
    return () => { window.removeEventListener('keydown', keyHandler) }
  }, [results, activeIdx])

  const handleFocus = () => {}
  const handleBlur = () => {}

  useEffect(() => {
    document.body.style.backgroundColor = 'transparent'
    return () => { document.body.style.backgroundColor = '' }
  }, [])

  return (
    <div className="overflow-hidden flex justify-center animate-overlay-fade">
      <div className="w-full max-w-[720px] rounded-2xl border border-white/8 bg-[rgb(var(--bg-elev-2)/0.97)] backdrop-blur-xl overflow-hidden shadow-[0_8px_48px_-8px_rgba(0,0,0,0.55),0_2px_6px_-1px_rgba(0,0,0,0.4)] ring-1 ring-black/50">
          {/* Input bar */}
          <div className="flex items-center gap-3 px-5 py-3 border-b border-white/10 bg-white/5">
            <div className="w-6 h-6 flex items-center justify-center rounded-md bg-gradient-to-r from-blue-500/60 to-purple-500/60 text-white/90">
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
              </svg>
            </div>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
              placeholder="Search photos, PDFs…"
              className="flex-1 bg-transparent text-base text-white placeholder-white/40 focus:outline-none"
              autoFocus
            />
            <div className="hidden md:flex items-center gap-1 text-[10px] font-medium text-white/40">
              <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">Ctrl</span>
              <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">Shift</span>
              <span className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10">K</span>
            </div>
          </div>
          {/* Results area */}
          <div className="max-h-[360px] overflow-y-auto overflow-x-hidden custom-scrollbar">
            {searching && (
              <div className="py-14 text-center text-white/60 text-sm">
                <div className="w-6 h-6 border-2 border-white/20 border-t-white/70 rounded-full animate-spin mx-auto mb-4" />
                Searching…
              </div>
            )}
            {!searching && results.length === 0 && query.trim() && (
              <div className="py-16 text-center text-white/50 text-sm select-none">No results for “{query}”</div>
            )}
            {!searching && results.length === 0 && !query.trim() && (
              <div className="py-16 text-center text-white/40 text-sm select-none">Type to search your indexed media</div>
            )}
            {!searching && results.length > 0 && (
              <ul className="divide-y divide-white/5">
                {results.map((r, i) => (
                  <li key={r.media_id} className={`group cursor-pointer transition-colors ${i === activeIdx ? 'bg-white/[0.10]' : 'hover:bg-white/[0.06]'}`}
                    onMouseDown={e => e.preventDefault()}
                    onMouseEnter={() => setActiveIdx(i)}
                    onClick={async () => { await invoke('open_file', { path: r.uri }); await invoke('toggle_overlay'); }}> 
                    <div className="flex items-center gap-4 px-5 py-3">
                      <div className="w-9 h-9 flex items-center justify-center rounded-lg bg-white/5 border border-white/10 text-white/70">
                        {r.modality === 'image' && (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M9 8h.01"/></svg>
                        )}
                        {r.modality === 'pdf_page' && (
                          <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 11V3l8 8v8a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h6"/></svg>
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-sm font-medium truncate ${i===activeIdx?'text-white':'text-white/90'}`}>{r.uri.split(/[\\/]/).pop() || r.uri}</p>
                        <p className="text-xs text-white/40 truncate">{r.uri}</p>
                      </div>
                      <div className="text-xs text-white/40 tabular-nums w-12 text-right">{(r.score * 100).toFixed(0)}%</div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="px-4 py-2 flex items-center justify-between text-[10px] text-white/40 border-t border-white/10 bg-white/5 tracking-wide">
            <div className="flex items-center gap-2">
              <span className="text-white/50">Esc</span>
              <span className="text-white/25">to close</span>
              <span className="text-white/50">Enter</span>
              <span className="text-white/25">to open</span>
            </div>
            <div className="hidden md:block text-white/30">Taura • Semantic Recall</div>
          </div>
        </div>
    </div>
  )
}

function useDynamicHeight(baseResults: SearchResultItem[], searching: boolean, query: string) {
  useEffect(() => {
  const appWindow = getCurrentWindow();
    const rows = baseResults.length;
    let content: number;
    if (searching) {
      content = 140; // spinner state
    } else if (!query.trim()) {
      content = 120; // placeholder state
    } else if (rows === 0) {
      content = 140; // no results message
    } else {
      content = 20 + rows * 56; // list
    }
    const total = 68 /* input */ + 44 /* footer */ + content;
    appWindow.setSize(new LogicalSize(720, Math.min(560, Math.max(200, total)))).catch(()=>{});
  }, [baseResults, searching, query]);
}
