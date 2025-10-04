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

export async function loadSession() {
  try {
    const sess = await invoke<Session | null>('get_session')
    setState({ session: sess, loading: false, error: null })
  } catch (e: any) {
    setState({ session: null, loading: false, error: String(e) })
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
    // Persist / upsert user in gateway
    try {
      const base = getApiBase()
      const email = res.session.email || res.session.sub || 'user'
      const upRes = await fetch(`${base}/users/upsert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, name: res.session.name, picture: res.session.picture }) })
      if (upRes.ok) {
        const data = await upRes.json() as { id: string }
        // Update config with real user UUID so searches use it
        updateConfig({ userId: data.id })
      }
    } catch (e) {
      console.warn('user upsert failed', e)
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
}

// Auto-load session when imported (main.tsx will await loadSession before routing)
// (main will explicitly call loadSession to control timing)