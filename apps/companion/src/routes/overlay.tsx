import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { search } from '../api'
import type { SearchResultItem } from '../api'

export const Route = createFileRoute('/overlay')({
  component: RouteComponent,
})

function RouteComponent() {
  return <OverlayNew />
}

function OverlayNew() {
  const [query, setQuery] = useState('')
  const [isExpanded, setIsExpanded] = useState(false)
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)

  const debounceRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      setIsExpanded(false)
      return
    }

    if (debounceRef.current) window.clearTimeout(debounceRef.current)

    debounceRef.current = window.setTimeout(async () => {
      try {
        setSearching(true)
        setIsExpanded(true)
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
            setIsExpanded(true)
          }
        })
      } catch (e) {
        console.error('Failed to setup global shortcut listener:', e)
      }
    }
    void setupListener()
  }, [])

  const handleFocus = () => setIsExpanded(true)

  const handleBlur = () => {
    setTimeout(() => {
      if (!query.trim()) setIsExpanded(false)
    }, 200)
  }

  return (
    <div className="fixed inset-0 pointer-events-none p-2">
      <div className="pointer-events-auto">
        <div
          className={`
            transition-all duration-500 ease-out transform
            ${isExpanded ? 'scale-100 opacity-100' : 'scale-95 opacity-90'}
            bg-black/5 backdrop-blur-2xl 
            border border-white/5
            rounded-2xl shadow-2xl
            before:absolute before:inset-0 before:rounded-2xl before:bg-gradient-to-br before:from-white/10 before:via-transparent before:to-purple-500/10 before:backdrop-blur-xl before:-z-10
            relative overflow-hidden
          `}
        >
          <div className="absolute inset-0 bg-gradient-to-br from-blue-500/5 via-transparent to-purple-600/10 rounded-2xl" />

          <div className="relative flex items-center px-5 py-3">
            <div className="flex-shrink-0 mr-3">
              <div className="w-5 h-5 rounded-full bg-gradient-to-r from-blue-400/80 to-purple-500/80 flex items-center justify-center backdrop-blur-sm">
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
            </div>

            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
              placeholder="Search your files..."
              aria-label="Search"
              className="flex-1 bg-transparent text-white/90 placeholder-white/40 text-sm font-medium outline-none"
            />
          </div>

          {isExpanded && (
            <div className="border-t border-white/5 bg-black/10 backdrop-blur-sm">
              {searching && (
                <div className="px-5 py-6 text-white/60 text-center text-sm">
                  <div className="w-5 h-5 border border-white/30 border-t-white/80 rounded-full animate-spin mx-auto mb-3" />
                  Searching...
                </div>
              )}

              {!searching && results.length === 0 && query.trim() && (
                <div className="px-5 py-6 text-white/50 text-center text-sm">
                  No results for &quot;{query}&quot;
                </div>
              )}

              {!searching && results.length === 0 && !query.trim() && (
                <div className="px-5 py-4 text-white/30 text-center text-xs">
                  Start typing to search
                </div>
              )}

              {results.length > 0 && (
                <div className="max-h-80 overflow-y-auto">
                  {results.map((result) => (
                    <div
                      key={result.media_id}
                      className="px-5 py-3 hover:bg-white/5 transition-all duration-200 cursor-pointer border-b border-white/5 last:border-b-0"
                      onMouseDown={(e) => e.preventDefault()} // keep input focus until click completes
                    >
                      <div className="flex items-center space-x-3">
                        <div className="flex-shrink-0">
                          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-400/20 to-purple-500/20 border border-white/10 flex items-center justify-center backdrop-blur-sm">
                            {result.modality === 'image' && (
                              <svg className="w-4 h-4 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                              </svg>
                            )}
                            {result.modality === 'pdf_page' && (
                              <svg className="w-4 h-4 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                            )}
                          </div>
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="text-white/90 font-medium text-sm truncate">
                            {result.uri.split(/[/\\]/).pop() || result.uri}
                          </div>
                          <div className="text-white/40 text-xs truncate">
                            {result.uri}
                          </div>
                        </div>

                        <div className="flex-shrink-0 text-white/30 text-xs">
                          {(result.score * 100).toFixed(0)}%
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
