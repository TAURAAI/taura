import { Link, useRouterState } from '@tanstack/react-router'
import { PropsWithChildren, ReactNode, useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type NavItem = { label: string; to: string; icon: ReactNode }

const nav: NavItem[] = [
  { label: 'Home', to: '/', icon: (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v9a2 2 0 002 2h10a2 2 0 002-2v-9" />
    </svg>) },
  { label: 'Settings', to: '/settings', icon: (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.983 19.75a7.75 7.75 0 110-15.5 7.75 7.75 0 010 15.5z" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>) },
]

export function AppShell({ children, footer }: PropsWithChildren<{ footer?: ReactNode }>) {
  const location = useRouterState({ select: (s) => s.location.pathname })
  const isActive = (path: string) => location === path
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('taura.sidebar.collapsed') === '1' } catch { return false }
  })

  // Auto collapse on narrow widths; expand back only if user hasn't explicitly set preference.
  const [autoCollapsed, setAutoCollapsed] = useState(false)
  const handleResize = useCallback(() => {
    const w = window.innerWidth
    if (w < 980 && !collapsed) { setAutoCollapsed(true); setCollapsed(true) }
    if (w >= 1080 && autoCollapsed) { setAutoCollapsed(false); setCollapsed(false) }
  }, [collapsed, autoCollapsed])

  useEffect(() => {
    window.addEventListener('resize', handleResize)
    handleResize()
    return () => window.removeEventListener('resize', handleResize)
  }, [handleResize])

  // Persist manual toggle (not when auto collapsing purely by width event)
  function toggleSidebar() {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem('taura.sidebar.collapsed', next ? '1' : '0') } catch {}
    if (!next) setAutoCollapsed(false) // user forced expand
  }

  return (
    <div className={`layout-shell${collapsed ? ' sidebar-collapsed' : ''}`}> 
      <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`} aria-label="Primary">
        <div className="sidebar-brand shadow-md">
          <button className="sidebar-logo" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={toggleSidebar}>
            <svg className="w-5 h-5" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <circle cx="16" cy="16" r="10" stroke="url(#g1)" />
              <path d="M11.5 16.2l3.2 3.4 5.8-7.3" strokeLinecap="round" strokeLinejoin="round" />
              <defs>
                <linearGradient id="g1" x1="6" y1="6" x2="26" y2="26" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#6366f1" />
                  <stop offset="1" stopColor="#a855f7" />
                </linearGradient>
              </defs>
            </svg>
          </button>
          <div className="sidebar-brand-text">
            <span className="block text-sm font-semibold text-white tracking-tight select-none">Taura</span>
            <span className="block text-[11px] text-white/45 leading-snug select-none">Multimodal Recall</span>
          </div>
        </div>
        <nav className="sidebar-nav" aria-label="Navigation">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`nav-item ${isActive(item.to) ? 'active' : ''}`}
              title={collapsed ? item.label : undefined}
              aria-current={isActive(item.to) ? 'page' : undefined}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="nav-text flex-1 block text-sm font-medium text-white/90 nav-label">{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button
            type="button"
            className="footer-command"
            onClick={() => invoke('toggle_overlay').catch(() => {})}
            aria-label="Open Command Palette"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18m9-9H3" />
            </svg>
            <span className="hidden sm:inline">Command</span>
          </button>
          <div className="text-[11px] text-white/40 ml-auto">v0.1.0</div>
          {footer}
        </div>
      </aside>
      <main className="content-area" role="main">{children}</main>
    </div>
  )
}
