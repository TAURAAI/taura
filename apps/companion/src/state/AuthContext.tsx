import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { updateConfig, getConfig, getApiBase } from './config'
import { initIndexer } from '../indexer'

// ---------------------- Types ----------------------
export interface Session {
  access_token: string
  refresh_token?: string | null
  expires_at?: number | null
  id_token?: string | null
  email?: string | null
  name?: string | null
  picture?: string | null
  sub?: string | null
  client_id?: string | null
  client_secret?: string | null
}

interface InternalState {
  session: Session | null
  loading: boolean
  error?: string | null
}

/**
 * Contract exposed to the rest of the React tree. (We keep the underlying external-store impl
 * for now to avoid a wide refactor; this context is a typed, future‑proof surface.)
 */
export interface AuthContextValue {
  session: Session | null
  userId: string | null
  loading: boolean
  error?: string | null
  loginWithGoogle: (clientId: string) => Promise<Session | null>
  logout: () => Promise<void>
  ensureFresh: () => Promise<Session | null>
  getAccessToken: (opts?: { forceRefresh?: boolean }) => Promise<string | null>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<InternalState>(() => ({ session: preloadedSession, loading: !preloadedSession }))
  const refreshTimer = useRef<any>(null)

  // Initial load if not preloaded
  useEffect(() => {
    if (preloadedSession) return
    let cancelled = false
    ;(async () => {
      try {
        const sess = await invoke<Session | null>('get_session')
        if (cancelled) return
        if (sess) {
          syncConfig(sess)
          scheduleRefresh(sess)
          setState({ session: sess, loading: false })
          initIndexer().catch(() => {})
        } else {
          setState({ session: null, loading: false })
        }
      } catch (e: any) {
        if (!cancelled) setState({ session: null, loading: false, error: String(e) })
      }
    })()
    return () => { cancelled = true }
  }, [])

  function scheduleRefresh(sess: Session) {
    if (!sess.expires_at) return
    clearTimer()
    const now = Date.now() / 1000
    const lead = 45
    let delaySec = sess.expires_at - now - lead
    if (delaySec < 5) delaySec = 5
    refreshTimer.current = setTimeout(async () => {
      try {
        const fresh = await invoke<Session>('ensure_fresh_session')
        syncConfig(fresh)
        setState(s => ({ ...s, session: fresh }))
        scheduleRefresh(fresh)
      } catch (e) {
        // soft fail
        // optionally surface error state
      }
    }, delaySec * 1000)
  }

  function clearTimer() {
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null }
  }

  useEffect(() => () => clearTimer(), [])

  // Derive a stable user identity (sub > email > config.userId)
  const userId = state.session?.sub || state.session?.email || getConfig().userId || null

  async function loginWithGoogle(clientId: string) {
    setState(s => ({ ...s, loading: true, error: null }))
    try {
      const secret = (import.meta as any).env?.VITE_TAURA_GOOGLE_CLIENT_SECRET || (window as any).TAURA_GOOGLE_CLIENT_SECRET
      if (!secret) throw new Error('Google Client Secret missing (VITE_TAURA_GOOGLE_CLIENT_SECRET)')
      const cfg: any = { clientId, clientSecret: secret }
      const res = await invoke<{ session: Session }>('google_auth_start', { cfg })
      const sess = res.session
      syncConfig(sess)
      scheduleRefresh(sess)
      setState({ session: sess, loading: false })
      // Gateway verify + upsert
      try {
        if (sess.id_token) {
          const base = getApiBase()
            ;(await fetch(`${base}/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: sess.id_token, email: sess.email, name: sess.name, picture: sess.picture }) }))
              .ok || console.warn('gateway auth/google failed')
        }
      } catch (e) { console.warn('gateway auth/google error', e) }
      initIndexer().catch(() => {})
      return sess
    } catch (e: any) {
      setState(s => ({ ...s, loading: false, error: String(e) }))
      throw e
    }
  }

  async function logout() {
    try { await invoke('logout') } catch {}
    clearTimer()
    setState({ session: null, loading: false })
    updateConfig({ userId: '' })
  }

  async function ensureFresh() {
    if (!state.session) return null
    try {
      const fresh = await invoke<Session>('refresh_session')
      syncConfig(fresh)
      scheduleRefresh(fresh)
      setState(s => ({ ...s, session: fresh }))
      return fresh
    } catch (e) {
      setState(s => ({ ...s, error: String(e) }))
      return state.session
    }
  }

  async function getAccessToken(opts?: { forceRefresh?: boolean }) {
    if (!state.session) return null
    if (opts?.forceRefresh) {
      const fresh = await ensureFresh()
      return fresh?.access_token || null
    }
    const now = Date.now() / 1000
    if (state.session.expires_at && state.session.expires_at - now < 60) {
      const fresh = await ensureFresh()
      return fresh?.access_token || state.session.access_token
    }
    return state.session.access_token
  }

  const value: AuthContextValue = useMemo(() => ({
    session: state.session,
    userId,
    loading: state.loading,
    error: state.error,
    loginWithGoogle,
    logout,
    ensureFresh,
    getAccessToken,
  }), [state.session, state.loading, state.error, userId])

  // Keep config.userId in sync (legacy consumers); only write when it changes.
  useEffect(() => {
    if (!userId) return
    const cfg = getConfig()
    if (cfg.userId !== userId) updateConfig({ userId })
  }, [userId])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuthContext must be used within <AuthProvider>')
  return ctx
}

// Convenience hook mirroring existing naming (future: migrate components to useAuthContext)
export const useAuthSafe = useAuthContext

// ---------------------- Bootstrap (pre-render) ----------------------
let preloadedSession: Session | null = null
export async function bootstrapAuthSession() {
  try {
    preloadedSession = await invoke<Session | null>('get_session')
    if (preloadedSession) syncConfig(preloadedSession)
  } catch {
    preloadedSession = null
  }
  return preloadedSession
}

function syncConfig(sess: Session) {
  if (!sess) return
  const candidate = sess.sub || sess.email
  if (candidate && getConfig().userId !== candidate) updateConfig({ userId: candidate })
}
