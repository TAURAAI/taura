import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { routeTree } from './routeTree.gen'
import { AuthProvider, bootstrapAuthSession } from './state/AuthContext'
import { getConfig } from './state/config'

import './styles.css'
import { initIndexer } from './indexer'
import reportWebVitals from './reportWebVitals.ts'

const router = createRouter({
  routeTree,
  context: {},
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultStructuralSharing: true,
  defaultPreloadStaleTime: 0,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

async function getInitialRoute() {
  try {
    const currentWindow = getCurrentWebviewWindow()
    const windowLabel = currentWindow.label
    
    if (windowLabel === 'overlay') {
      return '/overlay'
    } else {
      return '/'
    }
  } catch (e) {
    console.warn('Could not detect window label, defaulting to main route')
    return '/'
  }
}

async function initApp() {
  const progress = (p: number) => {
    window.dispatchEvent(new CustomEvent('app-progress', { detail: { p } }))
  }
  progress(0.05) // start
  const session = await bootstrapAuthSession()
  progress(0.25)
  const configState = getConfig()
  const identity = session?.sub || session?.email || configState.userId
  const hasIdentity = Boolean(identity)
  const routeForLabel = await getInitialRoute()
  progress(0.4)
  const isOverlay = routeForLabel === '/overlay'
  const initialRoute = isOverlay ? '/overlay' : (hasIdentity ? routeForLabel : '/onboarding/welcome')
  if (!isOverlay && identity) {
    initIndexer().catch(err => console.warn('indexer init failed', err))
  }

  await router.navigate({ to: initialRoute })
  progress(0.55)

  const rootElement = document.getElementById('app')
  if (rootElement && !rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement)
    root.render(
      <StrictMode>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </StrictMode>,
    )
  }
  progress(0.7)

  try {
    const manifestRes = await fetch('/sequence/manifest.json', { cache: 'no-store' })
    if (manifestRes.ok) {
      const m = await manifestRes.json()
      const first = `${(m.dir || '/sequence').replace(/\/$/, '')}/${m.base || 'aurora-'}${String(1).padStart(m.pad || 3, '0')}${m.ext || '.jpg'}`
      const img = new Image()
      img.src = first
    }
  } catch (e) {
    /* ignore */
  }
  progress(0.9)

  requestAnimationFrame(() => {
    progress(1)
    window.dispatchEvent(new CustomEvent('app-ready'))
  })
}

initApp().catch(console.error)
reportWebVitals()
