import { createFileRoute } from '@tanstack/react-router'
import logo from '../logo.svg'
import { useState, useEffect, useRef } from 'react'
import { search } from '../api'
import type { SearchResultItem } from '../api'
// @ts-ignore invoke types not yet in project typing context
import { invoke } from '@tauri-apps/api/core'

export const Route = createFileRoute('/' as never)({
  component: App,
})

function App() {
  const [query, setQuery] = useState('')
  const [folderCount, setFolderCount] = useState<number | null>(null)
  const [samples, setSamples] = useState<string[]>([])
  const [items, setItems] = useState<{ path: string; size: number; modified?: string; modality: string }[]>([])
  const [indexing, setIndexing] = useState(false)
  const [results, setResults] = useState<SearchResultItem[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<number | null>(null)

  useEffect(() => {
    if (!query.trim()) {
      setResults([])
      return
    }
    if (debounceRef.current) window.clearTimeout(debounceRef.current)
    debounceRef.current = window.setTimeout(async () => {
      try {
        setSearching(true)
        const r = await search('demo-user', query, 9, {})
        setResults(r)
      } catch (e) {
        console.error(e)
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => { if (debounceRef.current) window.clearTimeout(debounceRef.current) }
  }, [query])
  const [scanning, setScanning] = useState(false)

  async function handleScan() {
    setScanning(true)
    try {
  const res = await invoke<{ count: number; samples: string[]; items: { path:string; size:number; modified?: string; modality: string }[] }>('scan_folder', { path: 'C:/placeholder', maxSamples: 8 })
  setFolderCount(res.count)
  setSamples(res.samples)
  setItems(res.items)
    } catch (e) {
      console.error(e)
    } finally {
      setScanning(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-neutral-900 text-neutral-100 font-sans">
      <header className="p-4 flex items-center gap-4 border-b border-neutral-700">
        <img src={logo} className="h-10 w-10 animate-[spin_20s_linear_infinite]" />
        <h1 className="text-lg font-semibold">TAURA Companion</h1>
      </header>
      <main className="flex-1 p-6 space-y-6 max-w-3xl w-full mx-auto">
        <section className="space-y-2">
          <label className="text-sm uppercase tracking-wide text-neutral-400">Search</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type to search your media (stub)"
            className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-sky-500"
          />
          <p className="text-xs text-neutral-500">Type to query backend (stub returns empty until DB wired).</p>
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">Indexing</h2>
            <button
              onClick={handleScan}
              disabled={scanning}
              className="rounded bg-sky-600 hover:bg-sky-500 disabled:opacity-50 px-3 py-1 text-sm font-medium"
            >{scanning ? 'Scanning...' : 'Scan Folder'}</button>
          </div>
          <div className="text-sm text-neutral-400 space-y-1">
            {folderCount === null ? 'No folder scanned yet.' : `Indexed ${folderCount} media files.`}
            {samples.length > 0 && (
              <ul className="text-xs max-h-32 overflow-auto list-disc pl-5 space-y-0.5">
                {samples.map(s => <li key={s}>{s}</li>)}
              </ul>
            )}
          </div>
          {items.length > 0 && (
            <div className="flex items-center gap-3">
              <button
                disabled={indexing}
                onClick={async () => {
                  setIndexing(true)
                  try {
                    const payload = { items: items.slice(0, 200).map(it => ({ user_id: 'demo-user', modality: it.modality, uri: it.path, ts: it.modified })) }
                    const upserted = await invoke<number>('sync_index', { serverUrl: 'http://localhost:8080', payload })
                    console.log('upserted', upserted)
                  } catch (e) { console.error(e) } finally { setIndexing(false) }
                }}
                className="rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1 text-sm font-medium"
              >{indexing ? 'Uploading...' : 'Send to Server'}</button>
              <span className="text-xs text-neutral-500">(First 200 items)</span>
            </div>
          )}
        </section>
        <section className="space-y-2">
          <h2 className="font-medium">Results</h2>
          {searching && <div className="text-xs text-neutral-500">Searching...</div>}
          <div className="grid grid-cols-3 gap-2 text-xs text-neutral-400">
            {results.length === 0 && !searching && Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-square rounded bg-neutral-800 flex items-center justify-center opacity-40">{i + 1}</div>
            ))}
            {results.map(r => (
              <div key={r.media_id} className="aspect-square rounded bg-neutral-800 flex flex-col items-center justify-center p-1 overflow-hidden">
                <span className="text-[10px] truncate w-full" title={r.uri}>{r.modality}</span>
                <span className="text-[9px] text-sky-400">{r.score.toFixed(2)}</span>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  )
}
