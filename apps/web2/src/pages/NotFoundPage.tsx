import { ButtonLink } from '../tma/ui'

export function NotFoundPage() {
  return (
    <main className="tma-page" data-testid="not-found">
      <h1 className="tma-h1">Page not found</h1>
      <p className="tma-muted">This page does not exist, or it is private.</p>
      <div>
        <ButtonLink href="/" variant="secondary">
          Go to testmyagent.com
        </ButtonLink>
      </div>
    </main>
  )
}
