import { useEffect, useMemo, useRef, useState } from 'react'

type DemoItem = { id: string; uri: string; modality: 'image'|'pdf_page'|'text'; score: number }

const DEMO_DATA: DemoItem[] = [
  { id: '1', uri: '/Users/you/Photos/2019/paris_eiffel.jpg', modality: 'image', score: 0.91 },
  { id: '2', uri: '/Users/you/Documents/ids/passport_renewal_2022.pdf#page=3', modality: 'pdf_page', score: 0.84 },
  { id: '3', uri: '/Users/you/Photos/2018/louvre_tour.jpg', modality: 'image', score: 0.78 },
  { id: '4', uri: '/Users/you/Documents/travel/itinerary_paris.md', modality: 'text', score: 0.73 },
]

export default function OverlayDemo() {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const results = useMemo(() => {
    if (!q.trim()) return [] as DemoItem[]
    const qc = q.toLowerCase()
    return DEMO_DATA.filter(x => x.uri.toLowerCase().includes(qc)).slice(0, 6)
  }, [q])

  useEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    const el = listEl.querySelector<HTMLElement>(`[data-index="${active}"]`)
    el?.focus()
  }, [active, results.length])

  return (
    <div className="w-full h-full flex items-start justify-center p-3 bg-[#1b1d22]">
      <div className={`palette-card ${results.length ? 'palette-card--expanded' : ''}`} style={{ width: 'min(92%, 560px)' }} role="dialog" aria-modal="false" aria-label="Demo command palette">
        <div className="palette-input">
          <div className="palette-icon" aria-hidden>
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </div>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search photos, PDFs…"
            className="palette-input-field"
            aria-label="Demo search"
            onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setActive(0) } }}
          />
          <div className="palette-keycaps"><span>Ctrl</span><span>Shift</span><span>K</span></div>
        </div>
        <div className={`palette-results ${results.length ? 'palette-results--open' : ''}`} aria-live="polite">
          {q && results.length === 0 && (
            <div className="palette-placeholder">No results for “{q}”</div>
          )}
          {!q && (
            <div className="palette-placeholder">Type to search your indexed media</div>
          )}
          {results.length > 0 && (
            <ul className="palette-list" role="listbox" ref={listRef} aria-activedescendant={results[active] ? `demo-${active}` : undefined}>
              {results.map((r, i) => (
                <li
                  id={`demo-${i}`}
                  key={r.id}
                  data-index={i}
                  role="option"
                  aria-selected={i===active}
                  tabIndex={i===active?0:-1}
                  className={`palette-row ${i===active?'palette-row--active':''}`}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onKeyDown={(e) => { if (e.key==='Enter') { e.preventDefault(); inputRef.current?.focus() } }}
                  onClick={() => inputRef.current?.focus()}
                >
                  <div className="palette-row-icon">
                    {r.modality === 'image' && (
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M9 8h.01" /></svg>
                    )}
                    {r.modality === 'pdf_page' && (
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 11V3l8 8v8a2 2 0 01-2 2H6a2 2 0 01-2-2V5a2 2 0 012-2h6" /></svg>
                    )}
                    {r.modality === 'text' && (
                      <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M6 10h12M8 14h8M10 18h4" /></svg>
                    )}
                  </div>
                  <div className="palette-row-body">
                    <p className="palette-row-title">{r.uri.split(/[\\/]/).pop()}</p>
                    <p className="palette-row-subtitle">{r.uri}</p>
                  </div>
                  <div className="palette-row-score">{(r.score*100|0)}%</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <footer className={`palette-footer ${results.length ? 'palette-footer--open' : ''}`}>
          <div className="palette-footer-hint"><span>Esc</span><span>to close</span><span>Enter</span><span>to open</span></div>
          <span className="palette-footer-brand">Taura • Semantic Recall</span>
        </footer>
      </div>
    </div>
  )
}

