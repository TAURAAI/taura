import { createFileRoute, Link, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

export const Route = createFileRoute('/settings')({
  component: SettingsApp,
})

type ScannedItem = {
  path: string
  size: number
  modified?: string
  modality: 'image' | 'pdf_page' | 'video' | string
  lat?: number
  lon?: number
  timestamp?: string
}

type ScanResponse = {
  count: number
  items: ScannedItem[]
}

function SettingsApp() {
  const [selectedFolder, setSelectedFolder] = useState<string>('')
  const [isScanning, setIsScanning] = useState(false)
  const [scanResults, setScanResults] = useState<ScanResponse | null>(null)
  const [isIndexing, setIsIndexing] = useState(false)
  const [indexProgress, setIndexProgress] = useState(0)
  const location = useRouterState({ select: s => s.location.pathname })
  const navClass = (path: string) => `nav-item ${location === path ? 'active' : ''}`

  useEffect(() => {
    // Load default folder on startup
    void loadDefaultFolder()
  }, [])

  async function loadDefaultFolder() {
    try {
      const defaultPath = await invoke<string>('get_default_folder')
      setSelectedFolder(defaultPath)
    } catch (e) {
      console.error('Failed to load default folder:', e)
    }
  }

  async function handlePickFolder() {
    try {
      const result = await invoke<string | null>('pick_folder')
      if (result) {
        setSelectedFolder(result)
      }
    } catch (e) {
      console.error('Failed to pick folder:', e)
    }
  }

  async function handleScanFolder() {
    if (!selectedFolder) return
    
    setIsScanning(true)
    try {
      const result = await invoke<ScanResponse>('scan_folder', {
        path: selectedFolder,
        maxSamples: 1000,
      })
      setScanResults(result)
    } catch (e) {
      console.error('Scan failed:', e)
    } finally {
      setIsScanning(false)
    }
  }

  async function handleStartIndexing() {
    if (!scanResults) return

    setIsIndexing(true)
    setIndexProgress(0)

    try {
      const chunkSize = 50
      const chunks = []
      for (let i = 0; i < scanResults.items.length; i += chunkSize) {
        chunks.push(scanResults.items.slice(i, i + chunkSize))
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        try {
          const payload = {
            items: chunk.map((item) => ({
              user_id: 'user',
              modality: item.modality,
              uri: item.path,
              ts: item.modified,
              lat: item.lat,
              lon: item.lon,
              timestamp: item.timestamp,
            })),
          }
          
          await invoke<number>('sync_index', {
            serverUrl: 'http://localhost:8080',
            payload,
          })
          
          setIndexProgress(((i + 1) / chunks.length) * 100)
        } catch (e) {
          console.warn('Failed to sync chunk:', e)
        }
      }
    } catch (e) {
      console.error('Indexing failed:', e)
    } finally {
      setIsIndexing(false)
      setIndexProgress(0)
    }
  }

  async function handleShowOverlay() {
    // Check if we're on mobile/Android - if so, don't show overlay
    if (navigator.userAgent.includes('Mobile') || navigator.userAgent.includes('Android')) {
      console.log('Overlay not available on mobile platforms')
      return
    }
    
    try {
      await invoke('toggle_overlay')
    } catch (e) {
      console.error('Failed to show overlay:', e)
    }
  }

  return (
    <div className="layout-shell">
      <aside className="sidebar">
        <div className="px-4 py-4 flex items-center gap-2 text-white/80 font-semibold tracking-tight">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
          </div>
          Taura
        </div>
        <nav className="mt-2 space-y-1 px-2">
          <Link to="/" className={navClass('/')}>Dashboard</Link>
          <Link to="/settings" className={navClass('/settings')}>Settings</Link>
        </nav>
        <div className="mt-auto p-4 text-[11px] text-white/35">v0.1.0</div>
      </aside>
      <main className="content-area">
        <header className="mb-8">
          <h1 className="heading-xl mb-2">Settings</h1>
          <p className="muted text-sm">Manage indexing, server, and overlay behavior</p>
        </header>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="glass-card p-6 flex flex-col gap-4">
            <h2 className="text-base font-semibold text-white">Folder Selection</h2>
            <div className="text-xs text-white/50">Choose which root folder to index.</div>
            <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-mono text-white/80 break-all">{selectedFolder || 'No folder selected'}</div>
            <button onClick={handlePickFolder} className="btn-outline w-fit">Choose Folder</button>
          </div>
          <div className="glass-card p-6 flex flex-col gap-4">
            <h2 className="text-base font-semibold text-white">File Scanning</h2>
            <div className="text-xs text-white/50">Scan the current folder to enumerate media prior to indexing.</div>
            <button onClick={handleScanFolder} disabled={!selectedFolder || isScanning} className="btn-primary w-fit disabled:opacity-40 disabled:cursor-not-allowed">{isScanning ? 'Scanning…' : 'Scan Folder'}</button>
            {scanResults && (
              <div className="text-xs text-white/60 space-y-1">
                <div className="font-medium text-white/80">Found {scanResults.count.toLocaleString()} files</div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                  {Object.entries(scanResults.items.reduce((acc, item) => {acc[item.modality] = (acc[item.modality]||0)+1; return acc;}, {} as Record<string, number>)).map(([m,c]) => (
                    <div key={m} className="flex justify-between"><span className="text-white/40">{m}</span><span className="text-white/70">{c}</span></div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="glass-card p-6 flex flex-col gap-4">
            <h2 className="text-base font-semibold text-white">Server Indexing</h2>
            <div className="text-xs text-white/50">Batch upload metadata & request embeddings on the server.</div>
            <button onClick={handleStartIndexing} disabled={!scanResults || isIndexing} className="btn-primary w-fit disabled:opacity-40 disabled:cursor-not-allowed">{isIndexing ? `Indexing ${indexProgress.toFixed(0)}%` : 'Start Indexing'}</button>
            {isIndexing && (
              <div className="w-full h-2 rounded bg-white/10 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all" style={{ width: `${indexProgress}%` }} />
              </div>
            )}
          </div>
          {/* Only show overlay control on desktop */}
          {!(navigator.userAgent.includes('Mobile') || navigator.userAgent.includes('Android')) && (
            <div className="glass-card p-6 flex flex-col gap-4">
              <h2 className="text-base font-semibold text-white">Overlay Control</h2>
              <div className="text-xs text-white/50">Toggle the search overlay (or use Ctrl+Shift+K).</div>
              <button onClick={handleShowOverlay} className="btn-outline w-fit">Toggle Overlay</button>
            </div>
          )}
          <div className="glass-card p-6 flex flex-col gap-4 md:col-span-2">
            <h2 className="text-base font-semibold text-white">Advanced</h2>
            <div className="grid md:grid-cols-3 gap-4 text-xs">
              <div className="flex flex-col gap-1">
                <label className="text-white/40 text-[11px] uppercase tracking-wide">Search Mode</label>
                <select className="bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-white/80 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500">
                  <option>Semantic</option>
                  <option>Keyword</option>
                  <option>Hybrid</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-white/40 text-[11px] uppercase tracking-wide">Max Results</label>
                <input type="number" defaultValue={10} className="bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-white/80 text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-white/40 text-[11px] uppercase tracking-wide">Server URL</label>
                <input type="text" defaultValue="http://localhost:8080" className="bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-white/80 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}