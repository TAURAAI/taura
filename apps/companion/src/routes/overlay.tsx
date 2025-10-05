import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { search } from '../api'
import type { SearchResultItem } from '../api'
import { useAppConfig } from '../state/config'

export const Route = createFileRoute('/overlay')({
  component: Overlay,
})

function Overlay() {
  useEffect(() => { document.title = 'Taura — Overlay' }, [])
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const { userId } = useAppConfig()

  const debounceRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    if (!query.trim()) {
      setResults([])
      return
    }

    debounceRef.current = window.setTimeout(async () => {
      try {
        setSearching(true)
        const data = await search(userId, query, 8, {})
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
  }, [query, userId])

  useEffect(() => {
    const prevBody = document.body.style.background
    const prevHtml = (document.documentElement as HTMLElement).style.background
    document.body.style.background = 'transparent'
    ;(document.documentElement as HTMLElement).style.background = 'transparent'
    // Remember previously focused element to restore on close
    prevFocusRef.current = (document.activeElement as HTMLElement) || null
    return () => {
      document.body.style.background = prevBody
      ;(document.documentElement as HTMLElement).style.background = prevHtml
      // Restore focus to previous element
      try { prevFocusRef.current?.focus() } catch { /* noop */ }
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
      if (e.key === 'Tab') {
        // Focus trap inside dialog
        const focusable = Array.from(document.querySelectorAll<HTMLElement>('.palette-card button, .palette-card [href], .palette-card input, .palette-card [tabindex]:not([tabindex="-1"])'))
        if (focusable.length > 0) {
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
        }
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

  // Keep focus synced to active option for screen readers and keyboard users
  useEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    const active = listEl.querySelector<HTMLElement>(`[data-index="${activeIdx}"]`)
    if (active) active.focus()
  }, [activeIdx, results.length])

  return (
    <div className="palette-root">
      <div
        className={`palette-card ${showResults ? 'palette-card--expanded' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Search your library"
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
            aria-label="Search input"
            onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(0) } }}
          />
          <div className="palette-keycaps">
            <span>Ctrl</span>
            <span>Shift</span>
            <span>K</span>
          </div>
        </div>

        <div className={`palette-results ${showResults ? 'palette-results--open' : ''}`} aria-live="polite">
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
            <ul className="palette-list" role="listbox" aria-label="Search results" ref={listRef} aria-activedescendant={results[activeIdx] ? `result-${activeIdx}` : undefined}>
              {results.map((r, i) => (
                <li
                  id={`result-${i}`}
                  key={r.media_id}
                  role="option"
                  aria-selected={i === activeIdx}
                  tabIndex={i === activeIdx ? 0 : -1}
                  data-index={i}
                  className={`palette-row ${i === activeIdx ? 'palette-row--active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveIdx(i)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); invoke('open_file', { path: r.uri }).then(() => inputRef.current?.focus()).catch(()=>{}) } }}
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
