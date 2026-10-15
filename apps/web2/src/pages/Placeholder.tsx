import type { ReactNode } from 'react'
import { Card } from '../tma/ui'

/** Placeholder of a screen that a later lane fills. Lanes replace the page file, not this one. */
export function Placeholder({ screen, lane, route, children }: { screen: string; lane: string; route: string; children?: ReactNode }) {
  return (
    <main className="tma-page" data-testid="placeholder-page">
      <h1 className="tma-h1">{screen}</h1>
      <Card pad style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="tma-label">Coming in {lane}</span>
        <span className="tma-body-sm tma-muted">
          Route <span className="tma-mono">{route}</span>. Plan 20261012-itera-testmyagent-ui-refactor.
        </span>
        {children}
      </Card>
    </main>
  )
}
