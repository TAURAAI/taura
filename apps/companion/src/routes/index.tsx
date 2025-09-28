import { createFileRoute, Link, useRouterState } from '@tanstack/react-router'
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AppShell } from '../components/AppShell'
import { QuickSearch } from '../components/QuickSearch'
import { RecentItems } from '../components/RecentItems'
import { fetchStats } from '../api'
import { useAppConfig } from '../state/config'
import { setRootPath, startFullScan } from '../indexer'

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
  const quickActions = [
    {
      title: 'Open Command Overlay',
      description: 'Launch the universal palette (⌘⌥K) to search photos, PDFs, and transcripts.',
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8" />
        </svg>
      ),
      action: () => invoke('toggle_overlay').catch(() => {}),
      cta: 'Open overlay',
    },
    {
      title: 'Rescan Library',
      description: 'Trigger a fresh pass over your root folder to catch new or updated media.',
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15a7 7 0 0110-9l4 4M19 9a7 7 0 01-10 9l-4-4" />
        </svg>
      ),
      action: () => startFullScan().catch(() => {}).finally(() => setTimeout(() => loadStats(), 600)),
      cta: 'Rescan now',
    },
    {
      title: 'Set Root Folder',
      description: 'Point Taura at the directory you want indexed. Photos and PDFs remain local.',
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h4l2-2h6l2 2h4v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
        </svg>
      ),
      action: () => invoke('pick_folder')
        .then((res: any) => {
          if (!res) return
          return setRootPath(String(res)).catch(() => {}).finally(() => setTimeout(() => loadStats(), 1200))
        })
        .catch(() => {}),
      cta: 'Choose folder',
    },
  ]

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
    // Check if we're on mobile/Android - if so, don't show overlay
    if (navigator.userAgent.includes('Mobile') || navigator.userAgent.includes('Android')) {
      console.log('Overlay not available on mobile platforms')
      return
    }
    
    try {
      await invoke('toggle_overlay')
    } catch (e) {
      console.error('Failed to toggle overlay:', e)
    }
  }

  const location = useRouterState({ select: s => s.location.pathname })
  const navClass = (path: string) => `nav-item ${location === path ? 'active' : ''}`

  return (
    <AppShell>
      <div className="home-hero">
        <div className="hero-card">
          <div className="hero-content">
            <div className="hero-label">Semantic Recall</div>
            <h1 className="hero-title">Find any memory in milliseconds.</h1>
            <p className="hero-subtitle">Taura watches your folders, embeds media on the GPU, and returns the right photo, PDF page, or transcript as you type.</p>
            <div className="hero-pills">
              <span className="hero-pill">
                <strong>{stats.filesIndexed.toLocaleString()}</strong>
                <span>Indexed items</span>
              </span>
              <span className="hero-pill">
                <strong className={serverStatus === 'online' ? 'text-emerald-300' : 'text-amber-200'}>{serverStatus}</strong>
                <span>Gateway</span>
              </span>
              <span className="hero-pill">
                <strong>{config.privacyMode === 'strict-local' ? 'Local only' : 'Hybrid'}</strong>
                <span>Privacy mode</span>
              </span>
            </div>
            <div className="hero-actions">
              <button className="btn-primary" onClick={() => invoke('toggle_overlay').catch(() => {})}>
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18m9-9H3" />
                </svg>
                Summon overlay
              </button>
              <button className="btn-outline" onClick={() => invoke('open_settings_window').catch(() => {})}>Open settings</button>
            </div>
          </div>
          <div className="hero-stats glass-card">
            <div>
              <span className="stat-label">Last embed</span>
              <div className="stat-value">{stats.lastIndexed || 'pending'}</div>
            </div>
            <div>
              <span className="stat-label">Total media tracked</span>
              <div className="stat-value">{stats.totalMedia.toLocaleString()}</div>
            </div>
            <div>
              <span className="stat-label">Server URL</span>
              <div className="stat-value text-xs text-white/60 truncate" title={config.serverUrl}>{config.serverUrl}</div>
            </div>
          </div>
        </div>
        <div className="grid md:grid-cols-2 gap-6 mb-10">
          {/* Only show overlay card on desktop */}
          {!(navigator.userAgent.includes('Mobile') || navigator.userAgent.includes('Android')) && (
            <div className="glass-card p-6 flex flex-col">
              <h2 className="text-lg font-medium mb-2 text-white">Search Overlay</h2>
              <p className="text-sm text-white/50 mb-4">Launch the universal search palette anywhere.</p>
              <button onClick={handleQuickOverlay} className="btn-primary w-fit">Open Overlay</button>
            </div>
          )}
          <div className="glass-card p-6 flex flex-col">
            <h2 className="text-lg font-medium mb-2 text-white">Index Settings</h2>
            <p className="text-sm text-white/50 mb-4">Configure folders, filters and privacy options.</p>
            <Link to="/settings" className="btn-outline w-fit">Open Settings</Link>
          </div>

          <div className="section-heading mt-10">
            <h2>Recent results</h2>
            <p>Your latest matches across photos and docs.</p>
          </div>
          <RecentItems />

        <section className="home-right">
          <div className="section-heading">
            <h2>Try it now</h2>
            <p>Search your library without leaving the desktop.</p>
          </div>
          <QuickSearch userId={config.userId} />
        </section>
      </div>
      </div>
    </AppShell>
  )
}
