import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { indexerStore, setRootPath, startFullScan, stopScan } from '../indexer'
import { AppShell } from '../components/AppShell'
import { useAppConfig, updateConfig } from '../state/config'
import { useAuthContext } from '../state/AuthContext'

export const Route = createFileRoute('/settings')({
  component: SettingsApp,
})

type PrivacyMode = 'hybrid' | 'strict-local'

function useIndexerState() {
  return useSyncExternalStore(
    (onChange) => indexerStore.subscribe(() => onChange()),
    () => indexerStore.get(),
  )
}

function SettingsApp() {
  const idx = useIndexerState()
  const config = useAppConfig()
  const auth = useAuthContext()
  const [configDraft, setConfigDraft] = useState<{ serverUrl: string; userId: string; privacyMode: PrivacyMode }>({
    serverUrl: config.serverUrl,
    userId: (config.userId || auth.session?.sub || auth.session?.email || ""),
    privacyMode: (config.privacyMode as PrivacyMode) ?? 'hybrid',
  })

  const initialThrottle = useMemo(
    () => Number(localStorage.getItem('taura.scan.throttle.ms') || '0'),
    [],
  )
  const [throttleMs, setThrottleMs] = useState(initialThrottle)

  useEffect(() => {
    if (idx.rootPath) return
    void (async () => {
      try {
        const defaultPath = await invoke<string | null>('get_default_folder')
        if (defaultPath) {
          await setRootPath(defaultPath)
        }
      } catch (err) {
        console.error('Failed to load default folder:', err)
      }
    })()
  }, [idx.rootPath])

  useEffect(() => {
    setConfigDraft({
      serverUrl: config.serverUrl,
      userId: (config.userId || auth.session?.sub || auth.session?.email || ""),
      privacyMode: (config.privacyMode as PrivacyMode) ?? 'hybrid',
    })
  }, [config.serverUrl, config.userId, config.privacyMode])

  const scanningActive = idx.phase === 'scanning'
  const scanIndeterminate = scanningActive && (!idx.scan || idx.scan.total === 0)
  const scanPct =
    !scanIndeterminate && idx.scan && idx.scan.total > 0
      ? Math.min(100, (idx.scan.processed / idx.scan.total) * 100)
      : 0

  const streaming = Boolean(idx.upload)
  const uploadState = idx.upload
  const lastUpload = idx.lastUpload

  const queueDepth = streaming
    ? uploadState!.queueDepth
    : lastUpload?.queueDepth ?? 0
  const requested = streaming
    ? uploadState!.requested
    : lastUpload?.requested ?? 0
  const succeeded = streaming
    ? uploadState!.succeeded
    : lastUpload?.embeddedSuccess ?? 0
  const failed = streaming
    ? uploadState!.failed
    : lastUpload?.embeddedFailed ?? 0
  const chunksProcessed = streaming
    ? uploadState!.chunksProcessed
    : lastUpload?.chunksProcessed ?? 0
  const queuedTotal = streaming
    ? uploadState!.queued
    : lastUpload?.requested ?? 0
  const sentSoFar = streaming
    ? uploadState!.sent
    : queuedTotal
  const uploadPct = queuedTotal > 0 ? Math.min(100, (sentSoFar / queuedTotal) * 100) : 0
  const streamLabel = streaming
    ? `${uploadState!.sent}/${uploadState!.queued}`
    : lastUpload
    ? `${lastUpload.embeddedSuccess}/${lastUpload.requested}`
    : '0/0'
  const streamStatus = streaming
    ? (idx.serverOnline === false ? 'Paused (offline)' : 'Streaming to embedder')
    : queueDepth
    ? (idx.serverOnline === false ? 'Holding queue (offline)' : 'Awaiting GPU capacity')
    : (idx.serverOnline === false ? 'Idle (offline)' : 'Queue idle')
  const streamDetail = streaming
    ? `Chunks processed: ${chunksProcessed}`
    : lastUpload
    ? `Last run processed ${chunksProcessed} chunk${chunksProcessed === 1 ? '' : 's'}`
    : 'No uploads yet'
  const uploadHasFailures = streaming
    ? uploadState!.failed > 0
    : !!lastUpload && (lastUpload.embeddedFailed > 0 || lastUpload.readErrors.length > 0 || lastUpload.embedErrors.length > 0)
  const lastUpdated = streaming ? uploadState!.lastUpdated : lastUpload?.at ?? Date.now()

  const mostRecentErrors = useMemo(() => {
    if (streaming || !lastUpload) return []
    return [...lastUpload.embedErrors, ...lastUpload.readErrors].slice(0, 3)
  }, [streaming, lastUpload])

  async function handlePickFolder() {
    try {
      const result = await invoke<string | null>('pick_folder')
      if (result) {
        await setRootPath(result)
      }
    } catch (err) {
      console.error('Failed to pick folder:', err)
    }
  }

  //commented because unused
  // async function handleShowOverlay() {
  //   if (!auth.session) {
  //     console.warn('Overlay requires authentication')
  //     return
  //   }
  //   try {
  //     await invoke('toggle_overlay')
  //   } catch (err) {
  //     console.error('Failed to show overlay:', err)
  //   }
  // }

  async function updateThrottle(value: number) {
    const clamped = Math.max(0, Math.round(value))
    setThrottleMs(clamped)
    localStorage.setItem('taura.scan.throttle.ms', String(clamped))
    try {
      await invoke('set_default_throttle', { ms: clamped })
    } catch (err) {
      console.warn('failed set_default_throttle', err)
    }
  }

  const handlePrivacyChange = (mode: PrivacyMode) => {
    setConfigDraft((prev) => ({ ...prev, privacyMode: mode }))
    updateConfig({ privacyMode: mode })
  }

  const handleServerBlur = () => updateConfig({ serverUrl: configDraft.serverUrl })
  const handleUserBlur = () => updateConfig({ userId: configDraft.userId })

  return (
    <AppShell>
      <header className="mb-8">
        <h1 className="text-3xl font-semibold text-white">Settings</h1>
        <p className="text-sm text-slate-400">Fine-tune indexing, privacy, and the GPU stream.</p>
      </header>

      <section className="grid gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/30">
          <div className="mb-4 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-white">Library folder</h2>
              <p className="text-xs text-slate-400">Taura indexes this path silently in the background.</p>
            </div>
            {idx.pendingRoot && idx.pendingRoot !== idx.rootPath && (
              <span className="inline-flex items-center rounded-full bg-indigo-500/20 px-3 py-1 text-[10px] uppercase tracking-wide text-indigo-200">
                Switching…
              </span>
            )}
          </div>

          <div className="rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-xs text-slate-200">
            <div className="truncate font-mono text-xs">
              {idx.rootPath || 'Not selected yet'}
            </div>
            {idx.pendingRoot && idx.pendingRoot !== idx.rootPath && (
              <div className="mt-1 text-[11px] text-slate-400">Next: {idx.pendingRoot}</div>
            )}
          </div>

          <div className="mt-4 space-y-3 text-xs text-slate-300">
            <div className="flex justify-between">
              <span>Scan progress</span>
              <span>{scanIndeterminate ? 'Exploring…' : `${idx.scan?.processed ?? 0} files`}</span>
            </div>
            <div className={`relative h-2 overflow-hidden rounded-full bg-slate-800 ${scanIndeterminate ? 'animate-pulse' : ''}`}>
              {scanIndeterminate ? (
                <div className="absolute inset-0 animate-[shimmer_1.8s_linear_infinite] bg-gradient-to-r from-transparent via-white/30 to-transparent" />
              ) : (
                <div className="h-full rounded-full bg-gradient-to-r from-indigo-400 to-fuchsia-500 transition-all" style={{ width: `${scanPct}%` }} />
              )}
            </div>

            <div className="flex justify-between pt-2">
              <span>Embed stream</span>
              <span>{streamLabel}</span>
            </div>
            <div className="relative h-2 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-400 transition-all" style={{ width: `${uploadPct}%` }} />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span>{streamStatus}</span>
              <span>•</span>
              <span>{streamDetail}</span>
              {queueDepth ? (
                <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-emerald-200">Queue: {queueDepth}</span>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button className="btn-primary" onClick={handlePickFolder}>
              Choose folder
            </button>
            <button className="btn-outline" onClick={() => startFullScan().catch(() => {})}>
              Rescan now
            </button>
            {scanningActive && (
              <button className="btn-ghost" onClick={() => stopScan().catch(() => {})}>
                Stop scan
              </button>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/30">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-white">Embed stream details</h2>
            <p className="text-xs text-slate-400">Live stats from the GPU queue.</p>
          </div>

          <dl className="grid gap-3 text-sm text-slate-200">
            <div className="flex items-baseline justify-between">
              <dt className="text-[11px] uppercase tracking-wide text-slate-400">Requested</dt>
              <dd>{requested.toLocaleString()}</dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-[11px] uppercase tracking-wide text-slate-400">Succeeded</dt>
              <dd>{succeeded.toLocaleString()}</dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-[11px] uppercase tracking-wide text-slate-400">Failures</dt>
              <dd className={failed ? 'text-amber-300' : ''}>{failed.toLocaleString()}</dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-[11px] uppercase tracking-wide text-slate-400">Queue depth</dt>
              <dd>{queueDepth.toLocaleString()}</dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-[11px] uppercase tracking-wide text-slate-400">Chunks processed</dt>
              <dd>{chunksProcessed.toLocaleString()}</dd>
            </div>
            <div className="flex items-baseline justify-between">
              <dt className="text-[11px] uppercase tracking-wide text-slate-400">Last updated</dt>
              <dd>{new Date(lastUpdated).toLocaleTimeString()}</dd>
            </div>
          </dl>

          <div className="mt-4 rounded-xl border border-slate-800/50 bg-slate-950/70 p-3 text-xs">
            {uploadHasFailures ? (
              <div className="space-y-2">
                <p className="font-medium text-amber-300">Issues detected</p>
                {mostRecentErrors.length > 0 ? (
                  <ul className="space-y-1">
                    {mostRecentErrors.map((err, idx) => (
                      <li key={idx} className="flex flex-col gap-0.5">
                        <span className="truncate font-mono text-[11px] text-slate-300" title={err.uri}>
                          {err.uri}
                        </span>
                        <span className="text-[11px] text-rose-300">{err.error}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-slate-400">Waiting for retry results…</p>
                )}
              </div>
            ) : (
              <p className="text-slate-400">All recent uploads succeeded.</p>
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/30 md:col-span-2">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-white">Server & privacy</h2>
            <p className="text-xs text-slate-400">Adjust connection settings and scan pacing.{idx.serverOnline === false && ' (offline – syncing will resume silently)'}</p>
                  {auth.session?.email && (
                    <p className="mt-2 text-xs text-indigo-200">Signed in as <span className="font-medium text-white">{auth.session.email}</span></p>
                  )}
          </div>

          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-1">
              <label className="text-[11px] uppercase tracking-wide text-slate-400">Scan throttle</label>
              <select
                value={throttleMs}
                onChange={(e) => updateThrottle(Number(e.target.value))}
                className="mt-1 w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                {[0, 10, 25, 50, 100, 250].map((value) => (
                  <option key={value} value={value}>
                    {value === 0 ? 'Off' : `${value} ms`}
                  </option>
                ))}
              </select>
              <p className="mt-2 text-[11px] text-slate-400">Higher values slow the scanner to stay unobtrusive.</p>
            </div>
            <form className="md:col-span-2 grid gap-4 md:grid-cols-2" onSubmit={(e) => e.preventDefault()}>
              <label className="flex flex-col gap-2 text-xs text-slate-300">
                <span className="text-[11px] uppercase tracking-wide text-slate-400">Server URL</span>
                <input
                  type="text"
                  value={configDraft.serverUrl}
                  onChange={(e) => setConfigDraft((prev) => ({ ...prev, serverUrl: e.target.value }))}
                  onBlur={handleServerBlur}
                  placeholder="https://api.taura.app"
                  autoComplete="off"
                  className="w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-400"
                />
              </label>
              <label className="flex flex-col gap-2 text-xs text-slate-300">
                <span className="text-[11px] uppercase tracking-wide text-slate-400">User ID / email</span>
                <input
                  type="text"
                  value={configDraft.userId}
                  onChange={(e) => setConfigDraft((prev) => ({ ...prev, userId: e.target.value }))}
                  onBlur={handleUserBlur}
                  placeholder="you@example.com"
                  autoComplete="off"
                  disabled={!!auth.session}
                  className={`w-full rounded-lg border border-white/10 bg-slate-950/70 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-400 ${auth.session ? 'opacity-60 cursor-not-allowed' : ''}`}
                />
                {auth.session && <span className="text-[10px] text-slate-500">Managed from your OAuth identity; logout to change manually.</span>}
              </label>
            </form>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="text-[11px] uppercase tracking-wide text-slate-400">Privacy mode</span>
            <button
              type="button"
              onClick={() => handlePrivacyChange('strict-local')}
              className={`rounded-full px-3 py-1 text-xs transition ${
                configDraft.privacyMode === 'strict-local'
                  ? 'bg-indigo-500/80 text-white shadow-lg shadow-indigo-500/30'
                  : 'bg-slate-800/60 text-slate-300'
              }`}
            >
              Strict local
            </button>
            <button
              type="button"
              onClick={() => handlePrivacyChange('hybrid')}
              className={`rounded-full px-3 py-1 text-xs transition ${
                configDraft.privacyMode === 'hybrid'
                  ? 'bg-indigo-500/80 text-white shadow-lg shadow-indigo-500/30'
                  : 'bg-slate-800/60 text-slate-300'
              }`}
            >
              Hybrid
            </button>
          </div>
        </div>
      </section>
    </AppShell>
  )
}
