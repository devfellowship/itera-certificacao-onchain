import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <main className="w2-shell">
      <h1>Page not found</h1>
      <p className="w2-lead">
        <Link to="/">Back to the start</Link>
      </p>
    </main>
  )
}
