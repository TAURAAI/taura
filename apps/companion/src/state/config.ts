import { useSyncExternalStore } from 'react'

export type PrivacyMode = 'hybrid' | 'strict-local'

export interface AppConfig {
  serverUrl: string
  userId: string
  privacyMode: PrivacyMode
}

const STORAGE_KEY = 'taura.config.v1'

const DEFAULT_CONFIG: AppConfig = {
  serverUrl: 'http://localhost:8080',
  userId: 'user',
  privacyMode: 'hybrid',
}

let currentConfig: AppConfig = loadFromStorage()
const listeners = new Set<() => void>()

function loadFromStorage(): AppConfig {
  if (typeof window === 'undefined') {
    return { ...DEFAULT_CONFIG }
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw)
    return sanitizeConfig(parsed)
  } catch (err) {
    console.warn('failed to read config, resetting', err)
    return { ...DEFAULT_CONFIG }
  }
}

function sanitizeConfig(value: Partial<AppConfig>): AppConfig {
  const serverUrl = (value.serverUrl || DEFAULT_CONFIG.serverUrl).trim()
  const userId = (value.userId || DEFAULT_CONFIG.userId).trim() || DEFAULT_CONFIG.userId
  const privacyMode = value.privacyMode === 'strict-local' ? 'strict-local' : 'hybrid'
  return {
    serverUrl: serverUrl.replace(/\/$/, ''),
    userId,
    privacyMode,
  }
}

function persistConfig(cfg: AppConfig) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg))
  } catch (err) {
    console.warn('failed to persist config', err)
  }
}

function emit() {
  listeners.forEach((cb) => {
    try { cb() } catch (err) { console.warn('config listener error', err) }
  })
}

export function getConfig(): AppConfig {
  return currentConfig
}

export function updateConfig(patch: Partial<AppConfig>): AppConfig {
  currentConfig = sanitizeConfig({ ...currentConfig, ...patch })
  persistConfig(currentConfig)
  emit()
  return currentConfig
}

export function subscribeConfig(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAppConfig(): AppConfig {
  return useSyncExternalStore(subscribeConfig, getConfig)
}

export function getApiBase(): string {
  return getConfig().serverUrl.replace(/\/$/, '')
}

export function getUserId(): string {
  return getConfig().userId
}

