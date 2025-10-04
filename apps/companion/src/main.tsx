import { StrictMode } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider, createRouter } from '@tanstack/react-router'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

import { routeTree } from './routeTree.gen'
import { loadSession } from './state/auth'
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
  const session = await loadSession()
  const configState = getConfig()
  const identity = session?.sub || session?.email || configState.userId
  const hasIdentity = Boolean(identity)
  const initialRoute = hasIdentity ? await getInitialRoute() : '/onboarding/welcome'
  if (identity) {
    initIndexer().catch(err => console.warn('indexer init failed', err))
  }

  await router.navigate({ to: initialRoute })

  const rootElement = document.getElementById('app')
  if (rootElement && !rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement)
    root.render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    )
  }
}

initApp().catch(console.error)
reportWebVitals()
