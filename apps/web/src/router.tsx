/**
 * Route table of plan 20261012-itera-testmyagent-ui-refactor, "Screen → route → endpoint".
 * Each screen lives in its own file under pages/ so lanes do not edit the same file.
 */
import { lazy, Suspense } from 'react'
import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom'
import { RequireSession } from './auth/RequireSession'
import { Lockup } from './tma/ui'
import { AppNav } from './tma/nav/AppNav'
import { LandingPage } from './pages/LandingPage'
import { AgentsPage } from './pages/AgentsPage'
import { AddAgentPage } from './pages/AddAgentPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { SelectTasksPage } from './pages/SelectTasksPage'
import { RunningEvaluationPage } from './pages/RunningEvaluationPage'
import { MyEvaluationsPage } from './pages/MyEvaluationsPage'
import { PublicProfilePage } from './pages/PublicProfilePage'
import { TaskProfilePage } from './pages/TaskProfilePage'
import { MyTasksPage } from './pages/MyTasksPage'
import { TaskEditorPage } from './pages/TaskEditorPage'
import { DesignPrimitivesPage } from './pages/DesignPrimitivesPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { GithubCallbackPage } from './pages/GithubCallbackPage'

// The verifier pulls @solana/kit + SAS; load it only on /verify.
const VerifyPage = lazy(() => import('./VerifyPage').then((m) => ({ default: m.VerifyPage })))

/** App routes: App Nav + session gate. */
function AppLayout() {
  return (
    <div className="tma-app">
      <AppNav />
      <RequireSession>
        <Outlet />
      </RequireSession>
    </div>
  )
}

/** App Nav, no session gate: dev routes and the GitHub install return (its signed state names the wallet). */
function DevLayout() {
  return (
    <div className="tma-app">
      <AppNav />
      <Outlet />
    </div>
  )
}

/** App Nav without the session gate: the agent profile of 08 reads logged out (shared link, README badge). */
function OpenAppLayout() {
  return (
    <div className="tma-app">
      <AppNav />
      <Outlet />
    </div>
  )
}

/** Public pages that have no design header of their own (verify, 404). */
function PublicLayout() {
  return (
    <div className="tma-app">
      <header className="tma-nav">
        <Lockup />
      </header>
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </div>
  )
}

/** Legacy /observe/:id and /credentials/:id redirect; their flows moved to evaluations and /verify. */
function LegacyRedirect({ to }: { to: string }) {
  const { search } = useLocation()
  return <Navigate to={`${to}${search}`} replace />
}

export const routes = [
  { path: '/', element: <LandingPage /> },
  { path: '/e/:slugOrHash', element: <PublicProfilePage /> },
  // U30: public task profile (ADR-11). The editor moved to /tasks/:id/edit; the owner of a private task who opens its slug is sent there.
  { path: '/tasks/:slug', element: <TaskProfilePage /> },
  {
    element: <AppLayout />,
    children: [
      { path: '/agents', element: <AgentsPage /> },
      { path: '/agents/new', element: <AddAgentPage /> },
      { path: '/agents/:aid/evaluate', element: <SelectTasksPage /> },
      { path: '/evaluations', element: <MyEvaluationsPage /> },
      { path: '/evaluations/:eid', element: <RunningEvaluationPage /> },
      { path: '/tasks', element: <MyTasksPage /> },
      { path: '/tasks/new', element: <TaskEditorPage /> },
      { path: '/tasks/:id/edit', element: <TaskEditorPage /> },
    ],
  },
  { element: <OpenAppLayout />, children: [{ path: '/agents/:aid', element: <AgentDetailPage /> }] },
  {
    element: <DevLayout />,
    children: [
      { path: '/design/primitives', element: <DesignPrimitivesPage /> },
      // GitHub App install return (U10): forwards installation_id, code and state to the API.
      { path: '/connect/github/callback', element: <GithubCallbackPage /> },
    ],
  },
  {
    element: <PublicLayout />,
    children: [
      { path: '/verify', element: <VerifyPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
  { path: '/prepare', element: <LegacyRedirect to="/agents/new" /> },
  { path: '/observe/:id', element: <LegacyRedirect to="/evaluations" /> },
  { path: '/credentials/:id', element: <LegacyRedirect to="/verify" /> },
]

export function createRouter() {
  return createBrowserRouter(routes)
}
