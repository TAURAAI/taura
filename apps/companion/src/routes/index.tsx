import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSyncExternalStore, useState, useEffect, useRef, useCallback } from 'react'
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
  const navigate = useNavigate()
  const idx = useIndexerState()
  const [stats, setStats] = useState<DashboardStats>({ filesIndexed: 0, totalMedia: 0, lastIndexed: null })
  const [serverStatus, setServerStatus] = useState('checking')
  const [actionFeedback, setActionFeedback] = useState<Record<string, { status: 'idle' | 'busy' | 'success' | 'error'; message?: string }>>({})
  const actionTimersRef = useRef<Record<string, number>>({})
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
  const rootConfigured = Boolean(idx.rootPath)

  type QuickAction = {
    id: string
    title: string
    description: string
    icon: React.ReactElement
    cta: string
    run: () => Promise<void> | void
    disabled?: boolean
    disabledMessage?: string
    successMessage?: string
    busyLabel?: string
  }

  const quickActions: QuickAction[] = [
    {
      id: 'overlay',
      title: 'Open Command Overlay',
      description: 'Launch the universal palette (⌘⌥K) to search photos, PDFs, and transcripts.',
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h8" />
        </svg>
      ),
      run: async () => {
        if (!overlayEnabled) {
          throw new Error('Sign in to enable the overlay')
        }
        await invoke('toggle_overlay')
      },
      cta: overlayEnabled ? 'Open overlay' : 'Sign in first',
      disabled: !overlayEnabled,
      disabledMessage: 'Sign in with your Taura account to use the overlay.',
      successMessage: 'Overlay toggled — look for the floating window.',
      busyLabel: 'Opening…',
    },
    {
      id: 'rescan',
      title: 'Rescan Library',
      description: 'Trigger a fresh pass over your root folder to catch new or updated media.',
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 15a7 7 0 0110-9l4 4M19 9a7 7 0 01-10 9l-4-4" />
        </svg>
      ),
      run: async () => {
        if (!rootConfigured) {
          throw new Error('Choose a root folder before scanning.')
        }
        if (idx.phase === 'scanning') {
          throw new Error('A scan is already running.')
        }
        await startFullScan()
        window.setTimeout(() => {
          void loadStats()
        }, 600)
      },
      cta: rootConfigured ? 'Rescan now' : 'Set folder first',
      disabled: !rootConfigured || idx.phase === 'scanning',
      disabledMessage: !rootConfigured
        ? 'Pick a root folder so Taura knows where to look.'
        : 'Scanning in progress — we will pick up new files next run.',
      successMessage: 'Rescan kicked off — progress will appear above.',
      busyLabel: 'Starting…',
    },
    {
      id: 'set-root',
      title: 'Set Root Folder',
      description: 'Point Taura at the directory you want indexed. Photos and PDFs remain local.',
      icon: (
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7h4l2-2h6l2 2h4v12a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
        </svg>
      ),
      run: async () => {
        const res = await invoke<string | null>('pick_folder')
        if (!res) {
          throw new Error('Folder selection cancelled.')
        }
        await setRootPath(String(res))
        await loadStats()
      },
      cta: rootConfigured ? 'Change folder' : 'Choose folder',
      successMessage: 'Root folder saved — Taura will keep it in sync.',
      busyLabel: 'Saving…',
    },
  ]

  const checkServerStatus = useCallback(async () => {
    try {
      const response = await fetch(`${config.serverUrl.replace(/\/$/, '')}/healthz`)
      setServerStatus(response.ok ? 'online' : 'offline')
    } catch {
      setServerStatus('offline')
    }
  }, [config.serverUrl])

  const loadStats = useCallback(async () => {
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
  }, [config.userId])

  useEffect(() => {
    checkServerStatus()
    loadStats()
  }, [checkServerStatus, loadStats])

  useEffect(() => {
    return () => {
      Object.values(actionTimersRef.current).forEach((timerId) => window.clearTimeout(timerId))
    }
  }, [])

  const scheduleFeedbackClear = (id: string) => {
    if (actionTimersRef.current[id]) {
      window.clearTimeout(actionTimersRef.current[id])
    }
    actionTimersRef.current[id] = window.setTimeout(() => {
      setActionFeedback((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
    }, 4000)
  }

  const handleQuickAction = async (action: QuickAction) => {
    if (action.disabled) {
      if (action.disabledMessage) {
        setActionFeedback((prev) => ({
          ...prev,
          [action.id]: { status: 'error', message: action.disabledMessage },
        }))
        scheduleFeedbackClear(action.id)
      }
      return
    }

    setActionFeedback((prev) => ({
      ...prev,
      [action.id]: { status: 'busy' },
    }))

    if (actionTimersRef.current[action.id]) {
      window.clearTimeout(actionTimersRef.current[action.id])
      delete actionTimersRef.current[action.id]
    }

    try {
      await action.run()
      setActionFeedback((prev) => ({
        ...prev,
        [action.id]: {
          status: 'success',
          message: action.successMessage || 'Done.',
        },
      }))
      scheduleFeedbackClear(action.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action failed.'
      setActionFeedback((prev) => ({
        ...prev,
        [action.id]: { status: 'error', message },
      }))
      scheduleFeedbackClear(action.id)
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
              <button className="btn-outline" onClick={() => navigate({ to: '/settings' })}>Open settings</button>
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
            {quickActions.map((action) => {
              const feedback = actionFeedback[action.id]
              const isBusy = feedback?.status === 'busy'
              const disabled = action.disabled || isBusy
              const busyLabel = action.busyLabel || 'Working…'

              return (
                <div key={action.id} className="relative">
                  <button
                    type="button"
                    className={`action-card w-full ${
                      disabled ? 'opacity-60 cursor-not-allowed' : ''
                    }`}
                    onClick={() => handleQuickAction(action)}
                    disabled={disabled}
                    aria-busy={isBusy ? 'true' : undefined}
                  >
                    <span className="action-icon relative">
                      {isBusy ? (
                        <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                      ) : (
                        action.icon
                      )}
                    </span>
                    <span className="action-body">
                      <span className="action-title">{action.title}</span>
                      <span className="action-subtitle">{action.description}</span>
                    </span>
                    <span className="action-cta flex items-center gap-1.5">
                      {isBusy ? busyLabel : action.cta}
                    </span>
                  </button>
                  {feedback && feedback.message && feedback.status !== 'busy' && (
                    <div
                      className={`mt-2 px-3 py-2 rounded-lg text-xs flex items-center gap-2 ${
                        feedback.status === 'success'
                          ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20'
                          : 'bg-amber-500/10 text-amber-300 border border-amber-500/20'
                      }`}
                      role="status"
                      aria-live="polite"
                    >
                      {feedback.status === 'success' ? (
                        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16 6l-7.5 8L4 11" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 flex-shrink-0" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
                          <circle cx="10" cy="10" r="8" />
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10 6v4m0 4h.01" />
                        </svg>
                      )}
                      <span className="flex-1">{feedback.message}</span>
                    </div>
                  )}
                </div>
              )
            })}
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
