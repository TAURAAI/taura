import { useEffect, useState } from 'react'

export default function Splash() {
  const [hidden, setHidden] = useState(false)
  const [progress, setProgress] = useState(0)
  useEffect(() => {
    const readyHandler = () => requestAnimationFrame(() => setHidden(true))
    const progressHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail || typeof detail.p !== 'number') return
      setProgress((prev) => {
        // Never go backwards
        return detail.p > prev ? detail.p : prev
      })
    }
    window.addEventListener('app-ready', readyHandler as any, { once: true })
    window.addEventListener('app-progress', progressHandler as any)
    return () => {
      window.removeEventListener('app-ready', readyHandler as any)
      window.removeEventListener('app-progress', progressHandler as any)
    }
  }, [])

  return (
    <div
      aria-hidden
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'radial-gradient(circle at 30% 20%, rgba(120,70,255,0.35), rgba(12,12,20,0.94))',
        backdropFilter: 'blur(18px) saturate(140%)',
        WebkitBackdropFilter: 'blur(18px) saturate(140%)',
        pointerEvents: hidden ? 'none' : 'auto',
        opacity: hidden ? 0 : 1,
        transition: 'opacity 420ms cubic-bezier(.4,.16,.2,1)',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.1rem' }}>
        <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-0.01em', color: 'rgba(255,255,255,0.92)' }}>Starting Taura… {Math.round(progress * 100)}%</div>
        <div style={{ width: 200, height: 6, borderRadius: 6, background: 'rgba(255,255,255,0.08)', overflow: 'hidden', boxShadow: '0 2px 6px -2px rgba(0,0,0,0.5) inset' }}>
          <div style={{
            width: `${Math.min(1, progress) * 100}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #6d5bff, #4f2aff)',
            transition: 'width 320ms cubic-bezier(.55,.3,.2,1)',
            boxShadow: '0 0 0 1px rgba(255,255,255,0.15) inset, 0 2px 8px -2px rgba(70,40,160,0.8)'
          }} />
        </div>
      </div>
    </div>
  )
}

const styleId = '__splash_kf__'
if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
  const el = document.createElement('style')
  el.id = styleId
  el.textContent = ``
  document.head.appendChild(el)
}
