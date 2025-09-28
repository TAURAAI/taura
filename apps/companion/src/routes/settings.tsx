import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { indexerStore, setRootPath, startFullScan, stopScan } from '../indexer'
import { AppShell } from '../components/AppShell'
import { useAppConfig, updateConfig } from '../state/config'

export const Route = createFileRoute('/settings')({
  component: SettingsApp,
})


function SettingsApp() {
  const [, forceRerender] = useState(0)
  const config = useAppConfig()
  const [configDraft, setConfigDraft] = useState({ serverUrl: config.serverUrl, userId: config.userId, privacyMode: config.privacyMode })

  useEffect(() => {
    void (async () => {
      try {
        const defaultPath = await invoke<string | null>('get_default_folder')
        if (defaultPath && !indexerStore.get().rootPath) {
          await setRootPath(defaultPath)
        }
      } catch (e) {
        console.error('Failed to load default folder:', e)
      }
    })()
  }, [])

  useEffect(() => {
    setConfigDraft({ serverUrl: config.serverUrl, userId: config.userId, privacyMode: config.privacyMode })
  }, [config.serverUrl, config.userId, config.privacyMode])

  async function handlePickFolder() {
    try {
      console.debug('[Settings] invoking pick_folder')
      const result = await invoke<string | null>('pick_folder')
      console.debug('[Settings] pick_folder result:', result)
      if (result) {
        await setRootPath(result)
        console.debug('[Settings] after setRootPath, store rootPath=', indexerStore.get().rootPath, 'pendingRoot=', indexerStore.get().pendingRoot)
        await new Promise((res) => setTimeout(res, 150))
        const nowRoot = indexerStore.get().rootPath
        const nowPending = indexerStore.get().pendingRoot
        if (nowRoot !== result && nowPending !== result) {
          try {
            localStorage.setItem('taura.root', result)
            indexerStore.patch({ rootPath: result, pendingRoot: null })
            forceRerender(x => x + 1)
          } catch (e) {
            console.warn('fallback persist failed', e)
          }
        }
      }
    } catch (e) {
      console.error('Failed to pick folder:', e)
    }
  }

  // manual scan/index removed; automatic background system handles enumeration + syncing

  async function handleShowOverlay() {
    try {
      await invoke('toggle_overlay')
    } catch (e) {
      console.error('Failed to show overlay:', e)
    }
  }

  // subscribe to indexer store for live updates
  useEffect(() => {
    const unsub = indexerStore.subscribe(() => forceRerender(x => x + 1))
    return () => { unsub() }
  }, [])

  const idx = indexerStore.get()
  const scanIndeterminate = idx.scan && idx.scan.total === 0 && idx.phase === 'scanning'
  const scanPct = !scanIndeterminate && idx.scan && idx.scan.total > 0 ? Math.min(100, (idx.scan.processed / idx.scan.total) * 100) : 0
  const throttleMs = Number(localStorage.getItem('taura.scan.throttle.ms') || '0')

  async function updateThrottle(v: number) {
    localStorage.setItem('taura.scan.throttle.ms', String(v))
    try { await invoke('set_default_throttle', { ms: v }) } catch (e) { console.warn('failed set_default_throttle', e) }
    forceRerender(x => x + 1)
  }
  const uploadPct = idx.upload && idx.upload.queued > 0 ? Math.min(100, (idx.upload.sent / idx.upload.queued) * 100) : 0

  return (
    <AppShell>
      <header className="mb-8">
        <h1 className="heading-xl mb-2">Settings</h1>
        <p className="muted text-sm">Manage indexing, server, and overlay behavior</p>
      </header>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Folder & Indexing */}
        <div className="glass-card p-6 flex flex-col gap-5 md:col-span-2">
          <div className="flex flex-col gap-2">
            <h2 className="text-base font-semibold text-white">Folder & Indexing</h2>
            <div className="text-xs text-white/50">Choose a root folder and Taura will gently, continuously index it in the background.</div>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-[11px] uppercase tracking-wide text-white/40">Current Folder</label>
            <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-mono text-white/80 break-all flex items-center justify-between gap-4">
              <div className="min-w-0 truncate">
                {idx.pendingRoot && idx.pendingRoot !== idx.rootPath ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="text-white/40 line-through max-w-[360px] truncate">{idx.rootPath || '—'}</span>
                    <svg className="w-3 h-3 text-white/35" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2}><path d="M5 10h10M12 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    <span>{idx.pendingRoot}</span>
                    <span className="ml-1 px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] border border-amber-400/30">switching…</span>
                  </span>
                ) : (
                  <span>{idx.rootPath || 'No folder selected'}</span>
                )}
              </div>

              <div className="flex shrink-0 gap-2">
                <button onClick={handlePickFolder} className="btn-outline h-8 px-3 text-xs">{idx.pendingRoot && idx.pendingRoot !== idx.rootPath ? 'Changing…' : (idx.rootPath ? 'Change' : 'Choose')}</button>
                <button onClick={() => startFullScan()} disabled={!idx.rootPath || idx.phase === 'scanning'} className="btn-outline h-8 px-3 text-xs disabled:opacity-40 disabled:cursor-not-allowed">{idx.phase === 'scanning' ? 'Scanning…' : 'Rescan'}</button>
                {idx.phase === 'scanning' && <button onClick={() => stopScan()} className="btn-outline h-8 px-3 text-xs">Stop</button>}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 text-[11px] text-white/60">
            <span className="px-2 py-1 rounded bg-white/5 border border-white/10">Phase: {idx.phase}</span>
            {idx.scan && <span className="px-2 py-1 rounded bg-white/5 border border-white/10">Scan {idx.scan.processed}/{idx.scan.total || '∞'}</span>}
            {idx.upload && <span className="px-2 py-1 rounded bg-white/5 border border-white/10">Upload {idx.upload.sent}/{idx.upload.queued}</span>}
            {idx.lastScanTime && <span className="px-2 py-1 rounded bg-white/5 border border-white/10">Last {new Date(idx.lastScanTime).toLocaleTimeString()}</span>}
            <span className="px-2 py-1 rounded bg-white/5 border border-white/10">Throttle {throttleMs}ms</span>
          </div>

          <div className="flex flex-col gap-3">
            {(idx.phase === 'scanning') && (
              <div className="w-full h-2 rounded bg-white/10 overflow-hidden relative">
                {scanIndeterminate ? (
                  <div className="absolute inset-0 animate-shimmer bg-[linear-gradient(110deg,rgba(255,255,255,0.08)_10%,rgba(255,255,255,0.35)_18%,rgba(255,255,255,0.08)_33%)] bg-[length:200%_100%]" />
                ) : (
                  <div className="h-full bg-gradient-to-r from-indigo-500 to-fuchsia-500 transition-all" style={{ width: `${scanPct}%` }} />
                )}
              </div>
            )}

            {(idx.phase === 'uploading' || uploadPct > 0) && (
              <div className="w-full h-2 rounded bg-white/10 overflow-hidden">
                <div className="h-full bg-gradient-to-r from-green-500 to-emerald-400 transition-all" style={{ width: `${uploadPct}%` }} />
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap text-[11px] text-white/50">
              <span>Adjust Throttle</span>
              <select value={throttleMs} onChange={e => updateThrottle(Number(e.target.value))} className="bg-white/5 border border-white/10 rounded px-2 py-1 focus:outline-none">
                <option value={0}>Off</option>
                <option value={10}>10ms</option>
                <option value={25}>25ms</option>
                <option value={50}>50ms</option>
                <option value={100}>100ms</option>
                <option value={250}>250ms</option>
              </select>
              <span className="text-white/30">Higher = gentler disk usage</span>
            </div>
          </div>

          {idx.error && <div className="text-xs text-red-400">Error: {idx.error}</div>}
        </div>

        {/* Overlay Control */}
        <div className="glass-card p-6 flex flex-col gap-4">
          <h2 className="text-base font-semibold text-white">Overlay Control</h2>
          <div className="text-xs text-white/50">Toggle the search overlay (or use Ctrl+Shift+K).</div>
          <button onClick={handleShowOverlay} className="btn-outline w-fit">Toggle Overlay</button>
        </div>

        {/* Advanced */}
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
              <input type="text" defaultValue="https://unipool.acm.today" className="bg-white/5 border border-white/10 rounded-md px-2 py-1.5 text-white/80 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-indigo-500" />
            </div>
          </div>
        </div>

        {/* Server & Account */}
        <div className="glass-card p-6 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-white">Server & Account</h2>
              <p className="text-xs text-white/45 mt-1 max-w-md">Configure the Taura backend and user identifier used for syncing and search. Changes apply immediately.</p>
            </div>
          </div>

          <form className="grid gap-4 md:grid-cols-2" onSubmit={(e) => e.preventDefault()}>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <label className="text-[11px] uppercase tracking-wide text-white/40" htmlFor="server-url">Server URL</label>
              <input
                id="server-url"
                className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                value={configDraft.serverUrl}
                onChange={(e) => setConfigDraft((prev) => ({ ...prev, serverUrl: e.target.value }))}
                onBlur={() => updateConfig({ serverUrl: configDraft.serverUrl })}
                placeholder="https://api.taura.app"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-wide text-white/40" htmlFor="user-id">User ID / Email</label>
              <input
                id="user-id"
                className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-sm text-white/80 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                value={configDraft.userId}
                onChange={(e) => setConfigDraft((prev) => ({ ...prev, userId: e.target.value }))}
                onBlur={() => updateConfig({ userId: configDraft.userId })}
                placeholder="you@example.com"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-[11px] uppercase tracking-wide text-white/40">Privacy Mode</span>
              <div className="flex gap-3 text-xs">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="privacy-mode"
                    className="accent-indigo-500"
                    checked={configDraft.privacyMode === 'hybrid'}
                    onChange={() => {
                      setConfigDraft((prev) => ({ ...prev, privacyMode: 'hybrid' }))
                      updateConfig({ privacyMode: 'hybrid' })
                    }}
                  />
                  <span className="text-white/70">Hybrid (GPU embeddings)</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="radio"
                    name="privacy-mode"
                    className="accent-indigo-500"
                    checked={configDraft.privacyMode === 'strict-local'}
                    onChange={() => {
                      setConfigDraft((prev) => ({ ...prev, privacyMode: 'strict-local' }))
                      updateConfig({ privacyMode: 'strict-local' })
                    }}
                  />
                  <span className="text-white/70">Strict-Local</span>
                </label>
              </div>
            </div>
          </form>
        </div>
      </div>
    </AppShell>
  )
}
