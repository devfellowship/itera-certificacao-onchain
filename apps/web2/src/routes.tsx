import type { RouteObject } from 'react-router-dom'
import { DflCallbackPage } from './pages/DflCallbackPage'
import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { NotFoundPage } from './pages/NotFoundPage'

export const routes: RouteObject[] = [
  { path: '/', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/auth/dfl/callback', element: <DflCallbackPage /> },
  { path: '*', element: <NotFoundPage /> },
]
