import { createFileRoute } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AppShell } from '../components/AppShell'
import { QuickSearch } from '../components/QuickSearch'
import { RecentItems } from '../components/RecentItems'
import { fetchStats } from '../api'
import { useAppConfig } from '../state/config'

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
  const config = useAppConfig()

  useEffect(() => {
    checkServerStatus()
    loadStats()
  }, [config.serverUrl, config.userId])

  async function checkServerStatus() {
    try {
      const response = await fetch(`${config.serverUrl.replace(/\/$/, '')}/healthz`)
      setServerStatus(response.ok ? 'online' : 'offline')
    } catch {
      setServerStatus('offline')
    }
  }

  async function loadStats() {
    try {
      const data = await fetchStats(config.userId)
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
      <header className="mb-6">
        <h1 className="heading-xl mb-1">Home</h1>
        <p className="muted text-sm">Search and manage your indexed media.</p>
      </header>
      <div className="grid gap-6 md:grid-cols-3 mb-8">
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] uppercase tracking-wide text-white/50">Indexed</span>
            <span className="metric-chip capitalize">{serverStatus}</span>
          </div>
          <div className="text-3xl font-semibold mb-1">{stats.filesIndexed.toLocaleString()}</div>
          <div className="text-xs text-white/40">{stats.lastIndexed ? `Last: ${stats.lastIndexed}` : 'No embeddings yet'}</div>
          <div className="text-[11px] text-white/30 mt-1">Media: {stats.totalMedia.toLocaleString()}</div>
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] uppercase tracking-wide text-white/50">Server</span>
          </div>
          <div className="text-2xl font-semibold mb-1 capitalize">{serverStatus}</div>
          <div className="text-[11px] text-white/40">Health polled</div>
          <button onClick={handleQuickOverlay} className="mt-3 btn-outline h-8 px-3 text-xs">Overlay</button>
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] uppercase tracking-wide text-white/50">Mode</span>
          </div>
          <div className="text-2xl font-semibold mb-1">Semantic</div>
          <div className="text-[11px] text-white/40">Vector recall active</div>
          <button onClick={() => invoke('open_settings_window').catch(()=>{})} className="mt-3 btn-outline h-8 px-3 text-xs">Settings</button>
        </div>
      </div>
      <div className="grid gap-6 md:grid-cols-2 mb-8">
        <QuickSearch />
        <RecentItems />
      </div>
    </AppShell>
  )
}
