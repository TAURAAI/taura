import { Outlet, createRootRoute } from '@tanstack/react-router'
import Splash from '../components/Splash'

export const Route = createRootRoute({
  component: () => (
    <>
      <Outlet />
      <Splash />
    </>
  ),
})
