import { Link, useRouterState } from '@tanstack/react-router'
import { PropsWithChildren, ReactNode, useEffect, useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'

export type NavItem = { label: string; to: string; icon?: ReactNode; description?: string }

const nav: NavItem[] = [
  {
    label: 'Home',
    to: '/',
    description: 'Overview & quick actions',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l9-9 9 9M5 10v9a2 2 0 002 2h10a2 2 0 002-2v-9" />
      </svg>
    ),
  },
  {
    label: 'Settings',
    to: '/settings',
    description: 'Folders, server, privacy',
    icon: (
      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M11.983 19.75a7.75 7.75 0 110-15.5 7.75 7.75 0 010 15.5z" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    ),
  },
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
          <div className="sidebar-logo">
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" />
            </svg>
          </div>
          <div className="sidebar-brand-text">
            <span className="block text-sm font-semibold text-white tracking-tight select-none">Taura</span>
            <span className="block text-[11px] text-white/45 leading-snug select-none">Multimodal Recall</span>
          </div>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            className="sidebar-toggle"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
              {collapsed ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 12h16M10 6l-6 6 6 6" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4m10 6l6-6-6-6" />
              )}
            </svg>
          </button>
          <button
            type="button"
            className="nav-palette" onClick={() => invoke('toggle_overlay').catch(() => {})}
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v18m9-9H3" />
            </svg>
            <span>Open Command</span>
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="Navigation">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`nav-item ${isActive(item.to) ? 'active' : ''}`}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-text flex-1">
                <span className="block text-sm font-medium text-white/90 nav-label">{item.label}</span>
                {item.description && (
                  <span className="block text-[11px] text-white/40 mt-[2px] nav-desc">{item.description}</span>
                )}
              </span>
              <svg className="w-3 h-3 text-white/25 nav-caret" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 5l5 5-5 5" />
              </svg>
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="text-[11px] text-white/40">v0.1.0</div>
          {footer}
        </div>
      </aside>
      <main className="content-area" role="main">{children}</main>
    </div>
  )
}
