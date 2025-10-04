import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { getApiBase, updateConfig } from './config'
import { initIndexer } from '../indexer'

export interface Session {
  access_token: string
  refresh_token?: string | null
  expires_at?: number | null
  id_token?: string | null
  email?: string | null
  name?: string | null
  picture?: string | null
  sub?: string | null
}

interface AuthState {
  session: Session | null
  loading: boolean
  error?: string | null
}

let state: AuthState = { session: null, loading: true }
const listeners = new Set<() => void>()

function setState(patch: Partial<AuthState>) {
  state = { ...state, ...patch }
  listeners.forEach(l => { try { l() } catch {} })
}

export function subscribeAuth(cb: () => void) { listeners.add(cb); return () => listeners.delete(cb) }
export function getAuthState() { return state }
export function useAuth() { return useSyncExternalStore(subscribeAuth, getAuthState) }

export async function loadSession(): Promise<Session | null> {
  try {
    const sess = await invoke<Session | null>('get_session')
    setState({ session: sess, loading: false, error: null })
    syncConfigWithSession(sess)
    if (sess) scheduleRefresh(sess)
    return sess
  } catch (e: any) {
    setState({ session: null, loading: false, error: String(e) })
    return null
  }
}

export async function loginWithGoogle(clientId: string) {
  setState({ loading: true, error: null })
  try {
    // Pass camelCase; Rust has serde alias to accept clientId/client_id
    const secret = (import.meta as any).env?.VITE_TAURA_GOOGLE_CLIENT_SECRET || (window as any).TAURA_GOOGLE_CLIENT_SECRET
    if (!secret) throw new Error('Google Client Secret missing (VITE_TAURA_GOOGLE_CLIENT_SECRET)')
    const cfg: any = { clientId }
    if (secret) cfg.clientSecret = secret
    const res = await invoke<{ session: Session }>('google_auth_start', { cfg })
    setState({ session: res.session, loading: false })
    syncConfigWithSession(res.session)
  scheduleRefresh(res.session)
    // Integrated auth flow: send id_token to gateway for verify+upsert
    try {
      const base = getApiBase()
      const id_token = res.session.id_token
      if (id_token) {
        const authResp = await fetch(`${base}/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token, email: res.session.email, name: res.session.name, picture: res.session.picture }) })
        if (authResp.ok) {
          const data = await authResp.json() as { user_id: string }
            ;(data.user_id) && updateConfig({ userId: data.user_id })
        } else {
          console.warn('gateway auth/google failed', authResp.status)
        }
      } else {
        console.warn('no id_token present to verify with gateway')
      }
    } catch (e) {
      console.warn('gateway auth/google error', e)
    }
    // Start indexer now that we have a real user (if not already started)
    try { initIndexer() } catch {}
    return res.session
  } catch (e: any) {
    setState({ error: String(e), loading: false })
    throw e
  }
}

export async function logout() {
  try { await invoke('logout'); } catch {}
  setState({ session: null })
  updateConfig({ userId: '' })
  clearRefreshTimer()
}

// ----------------- Refresh Handling -----------------
let refreshTimer: any = null

function clearRefreshTimer() {
  if (refreshTimer) {
    clearTimeout(refreshTimer)
    refreshTimer = null
  }
}

function scheduleRefresh(sess: Session) {
  clearRefreshTimer()
  if (!sess.expires_at) return
  const now = Date.now() / 1000
  const lead = 45 // seconds before expiry to trigger ensure_fresh_session
  let delaySec = sess.expires_at - now - lead
  if (delaySec < 5) delaySec = 5
  const delayMs = delaySec * 1000
  refreshTimer = setTimeout(async () => {
    try {
      const updated = await invoke<Session>('ensure_fresh_session')
      setState({ session: updated })
      scheduleRefresh(updated)
    } catch (e) {
      console.warn('refresh failed', e)
    }
  }, delayMs)
}

export async function manualRefresh() {
  try {
    const updated = await invoke<Session>('refresh_session')
    setState({ session: updated })
    syncConfigWithSession(updated)
    scheduleRefresh(updated)
    return updated
  } catch (e) {
    setState({ error: String(e) })
    throw e
  }
}

// Auto-load session when imported (main.tsx will await loadSession before routing)
// (main will explicitly call loadSession to control timing)

function syncConfigWithSession(sess: Session | null) {
  if (!sess) return
  const current = getConfig()
  const candidate = sess.sub || sess.email
  if (candidate && current.userId !== candidate) {
    updateConfig({ userId: candidate })
  }
}
