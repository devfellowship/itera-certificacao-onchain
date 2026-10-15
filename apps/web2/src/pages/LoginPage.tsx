import { Navigate } from 'react-router-dom'
import { useSession } from '../auth/session'
import { LoginButton } from './LoginButton'

export function LoginPage() {
  const { user } = useSession()
  if (user) return <Navigate to="/" replace />
  return (
    <main className="w2-shell">
      <h1>Sign in</h1>
      <p className="w2-lead">Use your DFL account to run evaluations.</p>
      <LoginButton />
    </main>
  )
}
