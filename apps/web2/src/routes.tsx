import type { RouteObject } from 'react-router-dom'
import { AppLayout } from './pages/AppLayout'
import { DflCallbackPage } from './pages/DflCallbackPage'
import { EvaluationPage } from './pages/EvaluationPage'
import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { MyEvaluationsPage } from './pages/MyEvaluationsPage'
import { NewEvaluationPage } from './pages/NewEvaluationPage'
import { NotFoundPage } from './pages/NotFoundPage'

export const routes: RouteObject[] = [
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/login', element: <LoginPage /> },
      { path: '/auth/dfl/callback', element: <DflCallbackPage /> },
      { path: '/evaluate', element: <NewEvaluationPage /> },
      { path: '/evaluations', element: <MyEvaluationsPage /> },
      { path: '/evaluations/:id', element: <EvaluationPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]
