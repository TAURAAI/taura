import { Link, useRouterState } from '@tanstack/react-router'
import { PropsWithChildren, ReactNode } from 'react'

export type NavItem = { label: string; to: string; icon?: ReactNode }

const nav: NavItem[] = [
  { label: 'Home', to: '/' },
  { label: 'Settings', to: '/settings' },
]

export function AppShell({ children, footer }: PropsWithChildren<{ footer?: ReactNode }>) {
  const location = useRouterState({ select: s => s.location.pathname })
  const navClass = (path: string) => `nav-item ${location === path ? 'active' : ''}`

  return (
    <div className="layout-shell">
      <aside className="sidebar" aria-label="Primary">
        <div className="px-4 py-4 flex items-center gap-2 text-white/80 font-semibold tracking-tight select-none">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center shadow-inner">
            <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z" /></svg>
          </div>
          Taura
        </div>
        <nav className="mt-1 px-2 space-y-0.5" aria-label="Navigation">
          {nav.map(n => (
            <Link key={n.to} to={n.to} className={navClass(n.to)}>{n.label}</Link>
          ))}
        </nav>
        <div className="mt-auto p-4 text-[11px] text-white/35 flex items-center justify-between gap-3">
          <span>v0.1.0</span>
          {footer}
        </div>
      </aside>
      <main className="content-area" role="main">{children}</main>
    </div>
  )
}
