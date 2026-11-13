/**
 * Route table of apps/web2 (plan 20261015-testmyagent-web2-client, "UI copy"): the structure of
 * apps/web/src/router.tsx, without the web3 routes (/verify, /design/primitives, /prepare,
 * /observe, /credentials). Each screen lives in its own file under pages/ so lanes do not edit
 * the same file. The session provider lives in the root route, so a test can mount `routes`.
 */
import { Outlet, type RouteObject } from 'react-router-dom'
import { RequireSession } from './auth/RequireSession'
import { SessionProvider } from './auth/session'
import { AppNav } from './tma/nav/AppNav'
import { Lockup } from './tma/ui'
import { AddAgentPage } from './pages/AddAgentPage'
import { AgentDetailPage } from './pages/AgentDetailPage'
import { AgentsPage } from './pages/AgentsPage'
import { CliLoginPage } from './pages/CliLoginPage'
import { DflCallbackPage } from './pages/DflCallbackPage'
import { GithubCallbackPage } from './pages/GithubCallbackPage'
import { LandingPage } from './pages/LandingPage'
import { LoginPage } from './pages/LoginPage'
import { MyEvaluationsPage } from './pages/MyEvaluationsPage'
import { NewEvaluationPage } from './pages/NewEvaluationPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { ProfileSettingsPage } from './pages/ProfileSettingsPage'
import { PublicProfilePage } from './pages/PublicProfilePage'
import { RunArtifactsPage } from './pages/RunArtifactsPage'
import { RunningEvaluationPage } from './pages/RunningEvaluationPage'
import { SelectTasksPage } from './pages/SelectTasksPage'
import { TaskEditorPage } from './pages/TaskEditorPage'
import { TaskProfilePage } from './pages/TaskProfilePage'
import { TasksPage } from './pages/TasksPage'
import { UserPage } from './pages/UserPage'
import { GraderDetailPage } from './studio/GraderDetailPage'
import { GraderLibraryPage } from './studio/GraderLibraryPage'
import { StudioCasePage } from './studio/StudioCasePage'
import { StudioExperimentPage } from './studio/StudioExperimentPage'
import { StudioHomePage } from './studio/StudioHomePage'

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

/** App Nav without the session gate: shared links read logged out, and the login pages. */
function OpenAppLayout() {
  return (
    <div className="tma-app">
      <AppNav />
      <Outlet />
    </div>
  )
}

/** Public pages that have no design header of their own (404). */
function PublicLayout() {
  return (
    <div className="tma-app">
      <header className="tma-nav">
        <Lockup />
      </header>
      <Outlet />
    </div>
  )
}

export const routes: RouteObject[] = [
  {
    element: (
      <SessionProvider>
        <Outlet />
      </SessionProvider>
    ),
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/e/:slugOrHash', element: <PublicProfilePage /> },
      { path: '/tasks/:slug', element: <TaskProfilePage /> },
      {
        element: <AppLayout />,
        children: [
          { path: '/agents', element: <AgentsPage /> },
          { path: '/agents/new', element: <AddAgentPage /> },
          { path: '/agents/:aid/evaluate', element: <SelectTasksPage /> },
          { path: '/evaluations', element: <MyEvaluationsPage /> },
          { path: '/evaluations/:eid', element: <RunningEvaluationPage /> },
          { path: '/evaluations/:eid/runs/:runId', element: <RunArtifactsPage /> },
          { path: '/tasks', element: <TasksPage /> },
          { path: '/tasks/new', element: <TaskEditorPage /> },
          { path: '/tasks/:id/edit', element: <TaskEditorPage /> },
          { path: '/settings/profile', element: <ProfileSettingsPage /> },
          { path: '/cli', element: <CliLoginPage /> },
          // Studio area (plan 20261112-tma-c5-studio-area-web2, ADR-1): new routes only, no existing route is touched.
          { path: '/studio', element: <StudioHomePage /> },
          { path: '/studio/graders', element: <GraderLibraryPage /> },
          { path: '/studio/graders/:id', element: <GraderDetailPage /> },
          // C5-T3: S4 test case (the list at /studio/cases, ?task=<slug>) and S5 experiment builder. Read only (ADR-5).
          { path: '/studio/cases', element: <StudioHomePage /> },
          { path: '/studio/cases/:caseId', element: <StudioCasePage /> },
          { path: '/studio/experiments/new', element: <StudioExperimentPage /> },
        ],
      },
      {
        element: <OpenAppLayout />,
        children: [
          { path: '/agents/:aid', element: <AgentDetailPage /> },
          { path: '/u/:username', element: <UserPage /> },
          { path: '/connect/github/callback', element: <GithubCallbackPage /> },
          { path: '/evaluate', element: <NewEvaluationPage /> },
          { path: '/login', element: <LoginPage /> },
          { path: '/auth/dfl/callback', element: <DflCallbackPage /> },
        ],
      },
      {
        element: <PublicLayout />,
        children: [{ path: '*', element: <NotFoundPage /> }],
      },
    ],
  },
]
