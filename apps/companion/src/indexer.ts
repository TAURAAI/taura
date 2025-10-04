import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { readFile } from '@tauri-apps/plugin-fs'
import { useCallback, useSyncExternalStore } from 'react'
import { getConfig, subscribeConfig } from './state/config'

// ---- Types ----
export type IndexerPhase = 'idle' | 'scanning' | 'uploading' | 'error'

export interface SyncErrorItem {
  uri: string
  error: string
}

export interface SyncResult {
  upserted: number
  embedded_images?: number
  embedded_success?: number
  embedded_failed?: number
  requested_embeds?: number
  queued_embeds?: number
  embed_queue_depth?: number
  embed_errors?: SyncErrorItem[]
  read_errors?: SyncErrorItem[]
}

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
  lastUpload?: {
    at: number
    upserted: number
    requested: number
    embeddedSuccess: number
    embeddedFailed: number
    embedErrors: SyncErrorItem[]
    readErrors: SyncErrorItem[]
  }
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
const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024 // 8MB safety to avoid ballooning JSON
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
    try {
      localStorage.setItem('taura.root', p)
    } catch (e) {
      console.warn('failed to persist pending root to localStorage', e)
    }
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

function toBase64(data: Uint8Array): string {
  if (data.length === 0) return ''
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(i + chunkSize, data.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function batchUpload(items: any[]) {
  if (!items.length) return
  uploading = true
  indexerStore.patchNested(s => {
    s.phase = 'uploading'
    s.upload = { queued: items.length, sent: 0, batches: 0 }
    s.lastUpload = undefined
  })
  const serverUrl = currentConfig.serverUrl.replace(/\/$/, '')
  const aggregate = {
    upserted: 0,
    requested: 0,
    embeddedSuccess: 0,
    embeddedFailed: 0,
    embedErrors: [] as SyncErrorItem[],
    readErrors: [] as SyncErrorItem[],
  }
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE)
    const localReadErrors: SyncErrorItem[] = []
    const shouldInlineBytes = currentConfig.privacyMode === 'hybrid'
    const payloadItems = []
    for (const m of batch) {
      const base: any = {
        user_id: currentConfig.userId,
        modality: m.modality,
        uri: m.path,
        ts: m.modified,
        lat: m.lat,
        lon: m.lon,
      }
      if (shouldInlineBytes && typeof m.path === 'string' && m.path && (m.modality === 'image' || m.modality === 'pdf_page')) {
        try {
          const bytes = await readFile(m.path)
          if (bytes.length === 0) {
            localReadErrors.push({ uri: m.path, error: 'file empty' })
          } else if (bytes.length > MAX_INLINE_FILE_BYTES) {
            localReadErrors.push({ uri: m.path, error: `file too large (${(bytes.length / (1024 * 1024)).toFixed(1)}MB)` })
          } else {
            base.bytes_b64 = toBase64(bytes)
          }
        } catch (err: any) {
          localReadErrors.push({ uri: m.path, error: err?.message || 'read failed' })
        }
      }
      payloadItems.push(base)
    }
    try {
      const result = await invoke<SyncResult>('sync_index', { serverUrl, payload: { items: payloadItems } })
      aggregate.upserted += result.upserted ?? 0
      aggregate.requested += result.requested_embeds ?? payloadItems.length
      const successCount = result.embedded_success ?? result.embedded_images ?? 0
      aggregate.embeddedSuccess += successCount
      aggregate.embeddedFailed += result.embedded_failed ?? 0
      if (Array.isArray(result.embed_errors)) aggregate.embedErrors.push(...result.embed_errors)
      if (Array.isArray(result.read_errors)) aggregate.readErrors.push(...result.read_errors)
      if (localReadErrors.length) aggregate.readErrors.push(...localReadErrors)
    } catch (e) {
      console.warn('batch upload failed', e)
      aggregate.requested += batch.length
      aggregate.embeddedFailed += batch.length
      aggregate.embedErrors.push({ uri: 'batch', error: String(e) })
      if (localReadErrors.length) aggregate.readErrors.push(...localReadErrors)
    }
    indexerStore.patchNested(s => { if (s.upload) { s.upload.sent += batch.length; s.upload.batches += 1 } })
  }
  uploading = false
  indexerStore.patchNested(s => {
    if (s.phase === 'uploading') s.phase = 'idle'
    s.lastUpload = {
      at: Date.now(),
      upserted: aggregate.upserted,
      requested: aggregate.requested,
      embeddedSuccess: aggregate.embeddedSuccess,
      embeddedFailed: aggregate.embeddedFailed,
      embedErrors: aggregate.embedErrors,
      readErrors: aggregate.readErrors,
    }
    if (aggregate.embeddedFailed > 0 || aggregate.readErrors.length > 0) {
      s.error = `Sync incomplete: ${aggregate.embeddedFailed} embed failures, ${aggregate.readErrors.length} read errors`
    } else if (s.error && s.error.startsWith('Sync incomplete')) {
      s.error = undefined
    }
  })
}

export function useIndexer<T>(selector: (s: IndexerState) => T): T {
  const getSnapshot = useCallback(() => selector(indexerStore.get()), [selector])
  const subscribe = useCallback(
    (onStoreChange: () => void) => indexerStore.subscribe((_state) => onStoreChange()),
    [],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
