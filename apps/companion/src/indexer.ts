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
  serverOnline?: boolean // soft signal; undefined = unknown
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
   requested: number
   succeeded: number
   failed: number
   queueDepth: number
   lastUpdated: number
    chunksProcessed: number
  } | null
  lastUpload?: {
    at: number
    upserted: number
    requested: number
    embeddedSuccess: number
    embeddedFailed: number
    embedErrors: SyncErrorItem[]
    readErrors: SyncErrorItem[]
    queueDepth: number
    chunksProcessed: number
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
  queueDepth: number
  chunksProcessed: number
}

const uploadQueue: any[] = []
let uploadWorkerActive = false
let totalPlanned = 0
let sentCount = 0
let processedBatches = 0
let aggregateTotals: UploadAggregate = resetAggregate()

// ---- Connectivity gating ----
let lastOnlineCheck = 0
let cachedOnline: boolean | null = null
const ONLINE_CACHE_MS = 12_000 // re-evaluate at most every 12s
const OFFLINE_BACKOFF_MS = 5_000

async function checkServerOnline(base: string): Promise<boolean> {
  const now = Date.now()
  if (cachedOnline !== null && (now - lastOnlineCheck) < ONLINE_CACHE_MS) {
    return cachedOnline
  }
  lastOnlineCheck = now
  // Normalize base
  const url = base.replace(/\/$/, '')
  const hasUser = !!(currentConfig.userId && currentConfig.userId.trim())
  const probes = hasUser ? [ '/healthz', '/stats', '/' ] : [ '/healthz', '/' ]
  for (const p of probes) {
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), 2500)
      const resp = await fetch(url + p, { method: 'GET', mode: 'cors', signal: controller.signal })
      clearTimeout(t)
      if (resp.ok) {
        cachedOnline = true
        indexerStore.patch({ serverOnline: true })
        return true
      }
    } catch { /* swallow */ }
  }
  cachedOnline = false
  indexerStore.patch({ serverOnline: false })
  return false
}

function resetAggregate(): UploadAggregate {
  return {
    upserted: 0,
    requested: 0,
    embeddedSuccess: 0,
    embeddedFailed: 0,
    embedErrors: [],
    readErrors: [],
    queueDepth: 0,
    chunksProcessed: 0,
  }
}

function applyUploadSnapshot() {
  const snapshot = {
    queued: totalPlanned,
    sent: sentCount,
    batches: processedBatches,
    requested: aggregateTotals.requested,
    succeeded: aggregateTotals.embeddedSuccess,
    failed: aggregateTotals.embeddedFailed,
    queueDepth: aggregateTotals.queueDepth,
    chunksProcessed: aggregateTotals.chunksProcessed,
    lastUpdated: Date.now(),
  }

  indexerStore.patchNested((s) => {
    s.phase = 'uploading'
    if (!s.upload) {
      s.upload = { ...snapshot }
    } else {
      s.upload.queued = snapshot.queued
      s.upload.sent = snapshot.sent
      s.upload.batches = snapshot.batches
      s.upload.requested = snapshot.requested
      s.upload.succeeded = snapshot.succeeded
      s.upload.failed = snapshot.failed
      s.upload.queueDepth = snapshot.queueDepth
      s.upload.chunksProcessed = snapshot.chunksProcessed
      s.upload.lastUpdated = snapshot.lastUpdated
    }
    s.lastUpload = undefined
  })
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

  applyUploadSnapshot()

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
      // Peek chunk (don't splice until we know we're online and have server URL)
      const nextChunkSize = Math.min(STREAM_CHUNK_SIZE, uploadQueue.length)
      const previewChunk = uploadQueue.slice(0, nextChunkSize)
      const serverUrlRaw = (currentConfig.serverUrl || '').trim().replace(/\/$/, '')
      if (!serverUrlRaw) {
        aggregateTotals.embedErrors.push({ uri: 'batch', error: 'server URL missing' })
        aggregateTotals.embeddedFailed += previewChunk.length
        aggregateTotals.requested += previewChunk.length
        aggregateTotals.queueDepth = uploadQueue.length
        sentCount += previewChunk.length
        processedBatches += 1
        aggregateTotals.chunksProcessed += 1
        // Drop these items since we cannot send them meaningfully; user can re-scan after setting server.
        uploadQueue.splice(0, nextChunkSize)
        applyUploadSnapshot()
        continue
      }

      // Check connectivity BEFORE we spend time reading files or removing from queue.
      const online = await checkServerOnline(serverUrlRaw)
      if (!online) {
        // Soft pause: don't dequeue yet, just wait and retry later.
        // Provide a gentle pulse update so UI can reflect paused state without an error.
        indexerStore.patchNested(s => { if (s.phase === 'uploading') { /* keep uploading label */ } })
        await delay(OFFLINE_BACKOFF_MS)
        continue
      }

  const chunk = uploadQueue.splice(0, STREAM_CHUNK_SIZE)
      const { payloadItems, localReadErrors } = await prepareStreamPayload(chunk)

      let result: SyncResult | null = null
      if (payloadItems.length) {
        try {
          result = await sendStreamChunk(serverUrlRaw, payloadItems)
        } catch (err) {
          // If we get a network-style failure, mark offline & requeue once rather than cascading errors.
          if (err instanceof Error && (err.message.includes('Network') || err.message.includes('fetch') || err.message.includes('ECONN') || err.message.includes('Failed to fetch'))) {
            cachedOnline = false
            indexerStore.patch({ serverOnline: false })
            // Requeue the chunk (if not already retried too many times)
            let requeued = false
            for (const item of chunk) {
              const retries = ((item as any).__retry ?? 0) + 1
              ;(item as any).__retry = retries
              if (retries <= STREAM_REQUEUE_LIMIT) requeued = true
            }
            if (requeued) {
              uploadQueue.unshift(...chunk)
              await delay(OFFLINE_BACKOFF_MS)
              continue
            }
          } else {
            console.warn('stream chunk failed', err)
          }
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
      aggregateTotals.chunksProcessed += 1

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
        aggregateTotals.queueDepth =
          typeof result.embed_queue_depth === 'number'
            ? result.embed_queue_depth
            : uploadQueue.length
      } else if (payloadItems.length) {
        aggregateTotals.requested += payloadItems.length
      }

      if (localReadErrors.length) {
        aggregateTotals.readErrors.push(...localReadErrors)
        aggregateTotals.embeddedFailed += localReadErrors.length
        aggregateTotals.requested += localReadErrors.length
      }

      sentCount += chunk.length
      applyUploadSnapshot()

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
    upserted: aggregateTotals.upserted,
    requested: aggregateTotals.requested,
    embeddedSuccess: aggregateTotals.embeddedSuccess,
    embeddedFailed: aggregateTotals.embeddedFailed,
    embedErrors: [...aggregateTotals.embedErrors],
    readErrors: [...aggregateTotals.readErrors],
    queueDepth: aggregateTotals.queueDepth,
    chunksProcessed: aggregateTotals.chunksProcessed,
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
      queueDepth: summary.queueDepth,
      chunksProcessed: summary.chunksProcessed,
    }
    if (summary.embeddedFailed > 0 || summary.readErrors.length > 0) {
      // Only surface if online; if offline we keep silent experience.
      if (s.serverOnline !== false) {
        s.error = `Sync incomplete: ${summary.embeddedFailed} embed failures, ${summary.readErrors.length} read errors`
      }
    } else if (s.error && s.error.startsWith('Sync incomplete')) {
      s.error = undefined
    }
  })

  aggregateTotals = resetAggregate()
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

export function useIndexer<T>(selector: (state: IndexerState) => T): T {
  const getSnapshot = useCallback(() => selector(indexerStore.get()), [selector])
  const subscribe = useCallback((onChange: () => void) => indexerStore.subscribe(() => onChange()), [])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
