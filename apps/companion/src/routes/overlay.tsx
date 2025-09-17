import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { search } from '../api'
import type { SearchResultItem } from '../api'

export const Route = createFileRoute('/overlay')({
  component: Overlay,
})

function Overlay() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)

  const debounceRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    if (!query.trim()) {
      setResults([])
      return
    }

    debounceRef.current = window.setTimeout(async () => {
      try {
        setSearching(true)
        const data = await search('user', query, 8, {})
        setResults(data)
      } catch (err) {
        console.error('overlay search error', err)
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 220)

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current)
    }
  }, [query])

  useEffect(() => {
    const prevBody = document.body.style.background
    const prevHtml = (document.documentElement as HTMLElement).style.background
    document.body.style.background = 'transparent'
    ;(document.documentElement as HTMLElement).style.background = 'transparent'
    return () => {
      document.body.style.background = prevBody
      ;(document.documentElement as HTMLElement).style.background = prevHtml
    }
  }, [])

  useEffect(() => {
    let unlisten: UnlistenFn | undefined
    listen('toggle-overlay', () => inputRef.current?.focus())
      .then((fn) => {
        unlisten = fn
      })
      .catch((err) => console.error('toggle-overlay listen failed', err))

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        invoke('toggle_overlay').catch(() => {})
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, Math.max(results.length - 1, 0)))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' && results[activeIdx]) {
        invoke('open_file', { path: results[activeIdx].uri })
          .then(() => { inputRef.current?.focus() })
          .catch(() => {})
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      if (unlisten) unlisten()
    }
  }, [results, activeIdx])

  const hasQuery = query.trim().length > 0
  const showResults = searching || hasQuery || results.length > 0

  return (
    <div className="palette-root" onClick={() => invoke('toggle_overlay').catch(() => {})}>
      <div
        className={`palette-card ${showResults ? 'palette-card--expanded' : ''}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="palette-input">
          <div className="palette-icon">
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </div>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search photos, PDFs…"
            className="palette-input-field"
            autoFocus
          />
          <div className="palette-keycaps">
            <span>Ctrl</span>
            <span>Shift</span>
            <span>K</span>
          </div>
        </div>

        <div className={`palette-results ${showResults ? 'palette-results--open' : ''}`}>
          {searching && (
            <div className="palette-placeholder">
              <div className="palette-spinner" />
              Searching…
            </div>
          )}

          {!searching && results.length === 0 && hasQuery && (
            <div className="palette-placeholder">No results for “{query}”</div>
          )}

          {!searching && results.length === 0 && !hasQuery && (
            <div className="palette-placeholder">Type to search your indexed media</div>
          )}

          {!searching && results.length > 0 && (
            <ul className="palette-list">
              {results.map((r, i) => (
                <li
                  key={r.media_id}
                  className={`palette-row ${i === activeIdx ? 'palette-row--active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={async () => {
                    try {
                      await invoke('open_file', { path: r.uri })
                      // keep overlay open; refocus search box
                      inputRef.current?.focus()
                    } catch (_) {
                      /* swallow */
                    }
                  }}
                >
                  <div className="palette-row-icon">
                    {r.modality === 'image' && (
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M9 8h.01" />
                      </svg>
                    )}
                    {r.modality === 'pdf_page' && (
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 11V3l8 8v8a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h6" />
                      </svg>
                    )}
                  </div>
                  <div className="palette-row-body">
                    <p className="palette-row-title">{r.uri.split(/[\\/]/).pop() || r.uri}</p>
                    <p className="palette-row-subtitle">{r.uri}</p>
                  </div>
                  <div className="palette-row-score">{(r.score * 100).toFixed(0)}%</div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className={`palette-footer ${showResults ? 'palette-footer--open' : ''}`}>
          <div className="palette-footer-hint">
            <span>Esc</span>
            <span>to close</span>
            <span>Enter</span>
            <span>to open</span>
          </div>
          <span className="palette-footer-brand">Taura • Semantic Recall</span>
        </footer>
      </div>
    </div>
  )
}
