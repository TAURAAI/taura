import { createFileRoute } from '@tanstack/react-router'
import { useSyncExternalStore, useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { AppShell } from '../components/AppShell'
import { QuickSearch } from '../components/QuickSearch'
import { RecentItems } from '../components/RecentItems'
import { fetchStats } from '../api'
import { useAppConfig } from '../state/config'
import { indexerStore, setRootPath, startFullScan } from '../indexer'
import { useAuthContext } from '../state/AuthContext'

export const Route = createFileRoute('/')({ 
  component: HomeScreen,
})

type DashboardStats = {
  filesIndexed: number
  totalMedia: number
  lastIndexed: string | null
}

function useIndexerState() {
  return useSyncExternalStore(
    (onChange) => indexerStore.subscribe(() => onChange()),
    () => indexerStore.get(),
  )
}

function HomeScreen() {
  useEffect(() => { document.title = 'Taura — Home' }, [])
  const idx = useIndexerState()
  const [stats, setStats] = useState<DashboardStats>({ filesIndexed: 0, totalMedia: 0, lastIndexed: null })
  const [serverStatus, setServerStatus] = useState('checking')
  const uploadState = idx.upload
  const lastUpload = idx.lastUpload
  const queueDepth = uploadState ? uploadState.queueDepth : lastUpload?.queueDepth ?? 0
  const streamSummary = uploadState
    ? `${uploadState.sent}/${uploadState.queued}`
    : lastUpload
    ? `${lastUpload.embeddedSuccess}/${lastUpload.requested}`
    : '0/0'

  const config = useAppConfig()
  const { session } = useAuthContext()
  const overlayEnabled = Boolean(session)
  const quickActions = [
    ...(overlayEnabled
      ? [
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
        ]
      : []),
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
      if (!data) {
        setStats({ filesIndexed: 0, totalMedia: 0, lastIndexed: null })
        return
      }
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
              <button
                className={`btn-primary ${overlayEnabled ? '' : 'opacity-50 cursor-not-allowed'}`}
                onClick={() => {
                  if (!overlayEnabled) return
                  invoke('toggle_overlay').catch(() => {})
                }}
                disabled={!overlayEnabled}
              >
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
            <div>
              <span className="stat-label">Stream</span>
              <div className="stat-value text-sm text-white/70">{streamSummary}{queueDepth ? ` • Q${queueDepth}` : ''}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="home-grid">
        <section className="home-left">
          <div className="section-heading">
            <h2>Quick actions</h2>
            <p>Stay in flow with one-tap commands.</p>
          </div>
          <div className="action-stack">
            {quickActions.map((action) => (
              <button key={action.title} className="action-card" onClick={action.action}>
                <span className="action-icon">{action.icon}</span>
                <span className="action-body">
                  <span className="action-title">{action.title}</span>
                  <span className="action-subtitle">{action.description}</span>
                </span>
                <span className="action-cta">{action.cta}</span>
              </button>
            ))}
          </div>

          <div className="section-heading mt-10">
            <h2>Recent results</h2>
            <p>Your latest matches across photos and docs.</p>
          </div>
          <RecentItems />
        </section>

        <section className="home-right">
          <div className="section-heading">
            <h2>Try it now</h2>
            <p>Search your library without leaving the desktop.</p>
          </div>
          <QuickSearch userId={config.userId} />
        </section>
      </div>
    </AppShell>
  )
}
