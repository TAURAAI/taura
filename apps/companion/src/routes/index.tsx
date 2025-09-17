import { createFileRoute, Link } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AppShell } from '../components/AppShell'

export const Route = createFileRoute('/')({ 
  component: HomeScreen,
})

type DashboardStats = {
  filesIndexed: number
  totalMedia: number
  lastIndexed: string | null
}

function HomeScreen() {
  const [stats, setStats] = useState<DashboardStats>({ filesIndexed: 0, totalMedia: 0, lastIndexed: null })
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
      const response = await fetch('http://localhost:8080/stats?user_id=user')
      if (!response.ok) throw new Error(`stats ${response.status}`)
      const data: { media_count: number; embedded_count: number; last_indexed_at?: string | null } = await response.json()
      setStats({
        filesIndexed: data.embedded_count ?? 0,
        totalMedia: data.media_count ?? 0,
        lastIndexed: data.last_indexed_at ? new Date(data.last_indexed_at).toLocaleString() : null,
      })
    } catch (e) {
      console.error('Failed to load stats:', e)
      setStats({ filesIndexed: 0, totalMedia: 0, lastIndexed: null })
    }
  }

  async function handleQuickOverlay() {
    try {
      await invoke('toggle_overlay')
    } catch (e) {
      console.error('Failed to toggle overlay:', e)
    }
  }

  return (
    <AppShell>
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
            <div className="text-xs text-white/40">
              {stats.lastIndexed ? `Last indexed: ${stats.lastIndexed}` : 'No embeddings yet'}
            </div>
            <div className="text-[11px] text-white/35 mt-1">Total media detected: {stats.totalMedia.toLocaleString()}</div>
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
    </AppShell>
  )
}
