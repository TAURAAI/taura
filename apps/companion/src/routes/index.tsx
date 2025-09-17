import { createFileRoute, Link, useRouterState } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

export const Route = createFileRoute('/')({ 
  component: HomeScreen,
})

function HomeScreen() {
  const [stats, setStats] = useState({ filesIndexed: 0, lastScan: null as string | null })
  const [serverStatus, setServerStatus] = useState('checking')

  useEffect(() => {
    checkServerStatus()
    loadStats()
  }, [])

  async function checkServerStatus() {
    try {
      const response = await fetch('http://localhost:8080/healthz')
      setServerStatus(response.ok ? 'online' : 'offline')
    } catch {
      setServerStatus('offline')
    }
  }

  async function loadStats() {
    try {
      const defaultPath = await invoke<string>('get_default_folder')
      const result = await invoke<{ count: number }>('scan_folder', {
        path: defaultPath,
        maxSamples: 0,
      })
      setStats({ 
        filesIndexed: result.count, 
        lastScan: new Date().toLocaleDateString() 
      })
    } catch (e) {
      console.error('Failed to load stats:', e)
    }
  }

  async function handleQuickOverlay() {
    try {
      await invoke('toggle_overlay')
    } catch (e) {
      console.error('Failed to toggle overlay:', e)
    }
  }

  const location = useRouterState({ select: s => s.location.pathname })
  const navClass = (path: string) => `nav-item ${location === path ? 'active' : ''}`

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
          <h1 className="heading-xl mb-2">Dashboard</h1>
          <p className="muted text-sm">Overview of your indexed media and system status</p>
        </header>
        <div className="grid gap-6 md:grid-cols-3 mb-10">
          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs uppercase tracking-wide text-white/50">Files Indexed</span>
              <span className="metric-chip">{serverStatus}</span>
            </div>
            <div className="text-4xl font-semibold mb-1">{stats.filesIndexed.toLocaleString()}</div>
            <div className="text-xs text-white/40">{stats.lastScan ? `Last scan: ${stats.lastScan}` : 'No scan yet'}</div>
          </div>
          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-4">
              <span className="text-xs uppercase tracking-wide text-white/50">Server</span>
            </div>
            <div className="text-3xl font-semibold mb-1 capitalize">{serverStatus}</div>
            <div className="text-xs text-white/40">Health endpoint polled</div>
          </div>
          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-4"><span className="text-xs uppercase tracking-wide text-white/50">Mode</span></div>
            <div className="text-3xl font-semibold mb-1">Semantic</div>
            <div className="text-xs text-white/40">Vector recall active</div>
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-6 mb-10">
          <div className="glass-card p-6 flex flex-col">
            <h2 className="text-lg font-medium mb-2 text-white">Search Overlay</h2>
            <p className="text-sm text-white/50 mb-4">Launch the universal search palette anywhere.</p>
            <button onClick={handleQuickOverlay} className="btn-primary w-fit">Open Overlay</button>
          </div>
          <div className="glass-card p-6 flex flex-col">
            <h2 className="text-lg font-medium mb-2 text-white">Index Settings</h2>
            <p className="text-sm text-white/50 mb-4">Configure folders, filters and privacy options.</p>
            <Link to="/settings" className="btn-outline w-fit">Open Settings</Link>
          </div>
        </div>
        <div className="divider" />
        <section className="grid md:grid-cols-3 gap-6">
          {[{
            title:'Smart Indexing', desc:'Analyze photos, documents & media automatically.'},
            {title:'Natural Language', desc:'Describe what you remember—not filenames.'},
            {title:'Instant Results', desc:'Low-latency vector retrieval with ANN.'}].map(b => (
            <div key={b.title} className="glass-card p-5">
              <h3 className="text-sm font-semibold mb-1 text-white/90">{b.title}</h3>
              <p className="text-xs text-white/50 leading-relaxed">{b.desc}</p>
            </div>
          ))}
        </section>
      </main>
    </div>
  )
}