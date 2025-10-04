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
const MAX_INLINE_FILE_BYTES = 8 * 1024 * 1024 // 8MB safety to avoid ballooning JSON
const STREAM_CHUNK_SIZE = 8
const STREAM_REQUEUE_LIMIT = 2
const STREAM_RETRY_DELAY_MS = 1200
const RESCAN_ON_START = true

type UploadPayloadItem = {
  user_id: string
  modality: string
  uri: string
  ts?: string
  lat?: number | null
  lon?: number | null
  bytes_b64?: string
}

type UploadAggregate = {
  upserted: number
  requested: number
  embeddedSuccess: number
  embeddedFailed: number
  embedErrors: SyncErrorItem[]
  readErrors: SyncErrorItem[]
}

const uploadQueue: any[] = []
let uploadWorkerActive = false
let totalPlanned = 0
let sentCount = 0
let processedBatches = 0
let aggregateTotals: UploadAggregate = resetAggregate()

function resetAggregate(): UploadAggregate {
  return {
    upserted: 0,
    requested: 0,
    embeddedSuccess: 0,
    embeddedFailed: 0,
    embedErrors: [],
    readErrors: [],
  }
}

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
  enqueueUploads(items)
}

function enqueueUploads(items: any[]) {
  if (!items.length) return
  uploadQueue.push(...items)
  totalPlanned += items.length

  indexerStore.patchNested((s) => {
    s.phase = 'uploading'
    if (!s.upload) {
      s.upload = { queued: totalPlanned, sent: sentCount, batches: processedBatches }
    } else {
      s.upload.queued = totalPlanned
    }
    s.lastUpload = undefined
  })

  if (!uploadWorkerActive) {
    aggregateTotals = resetAggregate()
    uploadWorkerActive = true
    void uploadWorkerLoop()
  }
}

async function uploadWorkerLoop(): Promise<void> {
  uploading = true
  try {
    while (uploadQueue.length) {
      const chunk = uploadQueue.splice(0, STREAM_CHUNK_SIZE)
      const { payloadItems, localReadErrors } = await prepareStreamPayload(chunk)

      const serverUrlRaw = (currentConfig.serverUrl || '').trim().replace(/\/$/, '')
      if (!serverUrlRaw) {
        aggregateTotals.embedErrors.push({ uri: 'batch', error: 'server URL missing' })
        aggregateTotals.embeddedFailed += chunk.length
        sentCount += chunk.length
        processedBatches += 1
        indexerStore.patchNested((s) => {
          if (!s.upload) {
            s.upload = { queued: totalPlanned, sent: sentCount, batches: processedBatches }
          } else {
            s.upload.sent = sentCount
            s.upload.batches = processedBatches
            s.upload.queued = totalPlanned
          }
        })
        continue
      }

      let result: SyncResult | null = null
      if (payloadItems.length) {
        try {
          result = await sendStreamChunk(serverUrlRaw, payloadItems)
        } catch (err) {
          console.warn('stream chunk failed', err)
          let requeued = false
          for (const item of chunk) {
            const retries = ((item as any).__retry ?? 0) + 1
            ;(item as any).__retry = retries
            if (retries <= STREAM_REQUEUE_LIMIT) {
              requeued = true
            }
          }
          if (requeued) {
            uploadQueue.unshift(...chunk)
            await delay(STREAM_RETRY_DELAY_MS)
            continue
          }
          aggregateTotals.embedErrors.push({ uri: 'batch', error: err instanceof Error ? err.message : String(err) })
          aggregateTotals.embeddedFailed += payloadItems.length
        }
      }

      processedBatches += 1

      if (result) {
        const requested = result.requested_embeds ?? payloadItems.length
        const successCount = result.embedded_success ?? result.embedded_images ?? result.queued_embeds ?? 0
        const failed = result.embedded_failed ?? Math.max(0, requested - successCount)
        aggregateTotals.upserted += result.upserted ?? 0
        aggregateTotals.requested += requested
        aggregateTotals.embeddedSuccess += successCount
        aggregateTotals.embeddedFailed += failed
        if (Array.isArray(result.embed_errors)) aggregateTotals.embedErrors.push(...result.embed_errors)
        if (Array.isArray(result.read_errors)) aggregateTotals.readErrors.push(...result.read_errors)
      } else if (payloadItems.length) {
        aggregateTotals.requested += payloadItems.length
      }

      if (localReadErrors.length) {
        aggregateTotals.readErrors.push(...localReadErrors)
        aggregateTotals.embeddedFailed += localReadErrors.length
      }

      sentCount += chunk.length

      indexerStore.patchNested((s) => {
        if (!s.upload) {
          s.upload = { queued: totalPlanned, sent: sentCount, batches: processedBatches }
        } else {
          s.upload.sent = sentCount
          s.upload.batches = processedBatches
          s.upload.queued = totalPlanned
        }
      })

      for (const item of chunk) {
        if ((item as any).__retry !== undefined) {
          delete (item as any).__retry
        }
      }
    }
  } finally {
    uploading = false
    uploadWorkerActive = false
    finalizeUploadAggregate()
    totalPlanned = 0
    sentCount = 0
    processedBatches = 0
  }
}

async function prepareStreamPayload(items: any[]): Promise<{ payloadItems: UploadPayloadItem[]; localReadErrors: SyncErrorItem[] }> {
  const payloadItems: UploadPayloadItem[] = []
  const localReadErrors: SyncErrorItem[] = []
  const userId = (currentConfig.userId || '').trim()
  const shouldInlineBytes = currentConfig.privacyMode === 'hybrid'

  for (const m of items) {
    const uri = typeof m.path === 'string' ? m.path : ''
    const modality = m.modality as string | undefined
    if (!userId || !uri || !modality) {
      localReadErrors.push({ uri: uri || 'unknown', error: 'missing metadata' })
      continue
    }

    const base: UploadPayloadItem = {
      user_id: userId,
      modality,
      uri,
      ts: m.modified,
      lat: m.lat,
      lon: m.lon,
    }

    if (shouldInlineBytes && (modality === 'image' || modality === 'pdf_page')) {
      try {
        const raw = await readFile(uri)
        const bytes = raw instanceof Uint8Array ? raw : Uint8Array.from(raw as unknown as number[])
        if (bytes.length === 0) {
          localReadErrors.push({ uri, error: 'file empty' })
          continue
        }
        if (bytes.length > MAX_INLINE_FILE_BYTES) {
          localReadErrors.push({ uri, error: `file too large (${(bytes.length / (1024 * 1024)).toFixed(1)}MB)` })
          continue
        }
        base.bytes_b64 = toBase64(bytes)
      } catch (err: any) {
        localReadErrors.push({ uri, error: err?.message || 'read failed' })
        continue
      }
    }

    payloadItems.push(base)
  }

  return { payloadItems, localReadErrors }
}

async function sendStreamChunk(serverUrl: string, payloadItems: UploadPayloadItem[]): Promise<SyncResult | null> {
  if (!payloadItems.length) return null
  return invoke<SyncResult>('sync_index', { serverUrl, payload: { items: payloadItems } })
}

function finalizeUploadAggregate() {
  const summary = {
    ...aggregateTotals,
    embeddedFailed: aggregateTotals.embeddedFailed,
  }

  indexerStore.patchNested((s) => {
    if (uploadQueue.length === 0 && s.phase === 'uploading') {
      s.phase = 'idle'
    }
    s.upload = null
    s.lastUpload = {
      at: Date.now(),
      upserted: summary.upserted,
      requested: summary.requested,
      embeddedSuccess: summary.embeddedSuccess,
      embeddedFailed: summary.embeddedFailed,
      embedErrors: summary.embedErrors,
      readErrors: summary.readErrors,
    }
    if (summary.embeddedFailed > 0 || summary.readErrors.length > 0) {
      s.error = `Sync incomplete: ${summary.embeddedFailed} embed failures, ${summary.readErrors.length} read errors`
    } else if (s.error && s.error.startsWith('Sync incomplete')) {
      s.error = undefined
    }
  })

  aggregateTotals = resetAggregate()
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function useIndexer<T>(selector: (s: IndexerState) => T): T {
  const getSnapshot = useCallback(() => selector(indexerStore.get()), [selector])
  const subscribe = useCallback(
    (onStoreChange: () => void) => indexerStore.subscribe((_state) => onStoreChange()),
    [],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
