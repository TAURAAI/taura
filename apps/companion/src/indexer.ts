import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { getConfig, subscribeConfig } from './state/config'

// ---- Types ----
export type IndexerPhase = 'idle' | 'scanning' | 'uploading' | 'error'

export interface ScanProgressEvent {
  path: string
  processed: number
  total: number
  matched: number
  done?: boolean
  cancelled?: boolean
}

export interface IndexerState {
  rootPath: string | null
  phase: IndexerPhase
  pendingRoot?: string | null
  scan: {
    processed: number
    total: number
    matched: number
    startedAt?: number
    finishedAt?: number
  } | null
  upload: {
    queued: number
    sent: number
    batches: number
  } | null
  lastScanTime?: string
  error?: string
}

type Listener = (s: IndexerState) => void

// ---- Store (simple observable) ----
class Store {
  private state: IndexerState = {
    rootPath: null,
    phase: 'idle',
    scan: null,
    upload: null,
  }
  private listeners: Set<Listener> = new Set()

  get() { return this.state }
  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private emit() { for (const l of this.listeners) l(this.state) }
  patch(p: Partial<IndexerState>) { this.state = { ...this.state, ...p }; this.emit() }
  patchNested(fn: (draft: IndexerState) => void) { const copy = { ...this.state, scan: this.state.scan && { ...this.state.scan }, upload: this.state.upload && { ...this.state.upload } }; fn(copy); this.state = copy; this.emit() }
}

export const indexerStore = new Store()

// Expose for dev debugging
// @ts-ignore
window.__TAURA_INDEXER = indexerStore

// ---- Config ----
const SCAN_INTERVAL_MIN = Number(localStorage.getItem('taura.scan.interval.min') || '30') // minutes
const DEFAULT_THROTTLE_MS = 40 // built-in gentle default
const BATCH_SIZE = 96
const RESCAN_ON_START = true

let scanning = false
let uploading = false
let pendingRoot: string | null = null
let currentConfig = getConfig()

subscribeConfig(() => {
  currentConfig = getConfig()
})

// ---- Event wiring ----
export async function initIndexer() {
  // restore root path if persisted
  const savedRoot = localStorage.getItem('taura.root')
  if (savedRoot) indexerStore.patch({ rootPath: savedRoot })

  // Initialize backend default throttle
  if (!localStorage.getItem('taura.scan.throttle.ms')) {
    localStorage.setItem('taura.scan.throttle.ms', String(DEFAULT_THROTTLE_MS))
    try { await invoke('set_default_throttle', { ms: DEFAULT_THROTTLE_MS }) } catch {}
  } else {
    const v = Number(localStorage.getItem('taura.scan.throttle.ms'))
    try { await invoke('set_default_throttle', { ms: v }) } catch {}
  }

  await listen<ScanProgressEvent>('scan_progress', (ev) => {
    const d = ev.payload
    indexerStore.patchNested(st => {
      if (st.phase !== 'scanning') st.phase = 'scanning'
      if (!st.scan) st.scan = { processed: 0, total: d.total || 0, matched: 0, startedAt: Date.now() }
      st.scan.processed = d.processed
      st.scan.total = d.total
      st.scan.matched = d.matched
      if (d.done) {
        st.scan.finishedAt = Date.now()
        st.lastScanTime = new Date().toISOString()
        if (d.cancelled) {
          st.phase = 'idle'
          // apply pending root if user changed during scan
          if (pendingRoot) {
            const newRoot = pendingRoot
            pendingRoot = null
            localStorage.setItem('taura.root', newRoot)
            st.rootPath = newRoot
            // start new scan (async)
            setTimeout(() => { void startFullScan() }, 50)
          }
        }
      }
    })
  })

  if (RESCAN_ON_START && savedRoot) {
    void startFullScan()
  }

  // periodic schedule
  setInterval(() => {
    const st = indexerStore.get()
    if (!st.rootPath) return
    if (scanning || uploading) return
    const last = st.lastScanTime ? Date.parse(st.lastScanTime) : 0
    if (Date.now() - last > SCAN_INTERVAL_MIN * 60 * 1000) {
      void startFullScan()
    }
  }, 60 * 1000)
}

export async function setRootPath(p: string) {
  const st = indexerStore.get()
  if (st.rootPath === p) return
  if (scanning) {
    pendingRoot = p
    indexerStore.patch({ pendingRoot: p })
    try { await invoke('stop_scan') } catch {}
    return
  }
  localStorage.setItem('taura.root', p)
  indexerStore.patch({ rootPath: p, pendingRoot: null })
  void startFullScan()
}

export async function startFullScan() {
  const st = indexerStore.get()
  if (!st.rootPath || scanning) return
  scanning = true
  indexerStore.patch({ phase: 'scanning', scan: { processed: 0, total: 0, matched: 0, startedAt: Date.now() } })
  try {
    const throttlePref = Number(localStorage.getItem('taura.scan.throttle.ms') || String(DEFAULT_THROTTLE_MS))
    const res: any = await invoke('scan_folder', { path: st.rootPath, maxSamples: 50000, throttleMs: throttlePref })
    // res.items contains enumerated media; batch upload
    await batchUpload(res.items as any[])
  } catch (e: any) {
    indexerStore.patch({ phase: 'error', error: String(e) })
  } finally {
    scanning = false
    if (!uploading) indexerStore.patchNested(s => { if (s.phase === 'scanning') s.phase = 'idle' })
  }
}

export async function stopScan() {
  if (!scanning) return
  try { await invoke('stop_scan') } catch {}
}

async function batchUpload(items: any[]) {
  if (!items.length) return
  uploading = true
  indexerStore.patchNested(s => { s.phase = 'uploading'; s.upload = { queued: items.length, sent: 0, batches: 0 } })
  const serverUrl = currentConfig.serverUrl.replace(/\/$/, '')
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE)
    try {
      await invoke('sync_index', { serverUrl, payload: { items: batch.map(m => ({
        user_id: currentConfig.userId,
        modality: m.modality,
        uri: m.path,
        ts: m.modified,
        lat: m.lat,
        lon: m.lon
      })) } })
    } catch (e) {
      console.warn('batch upload failed', e)
    }
    indexerStore.patchNested(s => { if (s.upload) { s.upload.sent += batch.length; s.upload.batches += 1 } })
  }
  uploading = false
  indexerStore.patchNested(s => { if (s.phase === 'uploading') s.phase = 'idle'; })
}

export function useIndexer(selector: (s: IndexerState) => any) {
  const [snap, setSnap] = (window as any).React?.useState(() => selector(indexerStore.get())) || [selector(indexerStore.get()), () => {}]
  useEffectCompat(() => indexerStore.subscribe(s => setSnap(selector(s))), [selector])
  return snap
}

function useEffectCompat(fn: () => any, deps: any[]) {
  // dynamic import to avoid circular requiring React here if tests stub
  // @ts-ignore
  const React = window.React || require('react')
  React.useEffect(fn, deps)
}
