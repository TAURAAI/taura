import { useState } from 'react'
import { loginWithGoogle, useAuth } from '../state/auth'

const CLIENT_ID_KEY = 'TAURA_GOOGLE_CLIENT_ID'

export function GoogleSignInButton() {
  const { loading } = useAuth()
  const [err, setErr] = useState<string | null>(null)
  const clientId = import.meta.env?.[`VITE_${CLIENT_ID_KEY}`] || (window as any)[CLIENT_ID_KEY] || ''
  const clientSecret = (import.meta as any).env?.VITE_TAURA_GOOGLE_CLIENT_SECRET || (window as any).TAURA_GOOGLE_CLIENT_SECRET || ''

  async function handle() {
    setErr(null)
    try {
      if (!clientId) throw new Error('Google Client ID not configured')
      await loginWithGoogle(String(clientId))
    } catch(e:any){
      console.error('google auth failed', e)
      setErr(String(e))
    }
  }

  return (
    <div className="w-full flex flex-col items-center">
  <button onClick={handle} disabled={loading || !clientId || !clientSecret} className="inline-flex items-center gap-3 px-5 py-3 rounded-md border border-white/20 hover:border-white/40 bg-white/5 hover:bg-white/10 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus:ring-2 focus:ring-white/40">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.35 11.1H12v2.9h5.3c-.23 1.5-1.6 4.4-5.3 4.4a6.1 6.1 0 1 1 0-12.2c1.7 0 2.9.7 3.6 1.3l2.4-2.3C16.7 3.8 14.6 3 12 3a9 9 0 1 0 0 18c5.2 0 8.6 3.6 9.1-8.5Z"/></svg>
        <span>{loading ? 'Signing in…' : 'Sign in with Google'}</span>
      </button>
  {(!clientId) && <p className="text-[11px] text-amber-300 mt-2">Missing Google Client ID (set VITE_{CLIENT_ID_KEY}).</p>}
  {clientId && !clientSecret && <p className="text-[11px] text-amber-300 mt-1">Missing Google Client Secret (set VITE_TAURA_GOOGLE_CLIENT_SECRET).</p>}
      {err && <p className="text-[11px] text-red-400 mt-2 max-w-xs text-center">{err}</p>}
    </div>
  )
}
