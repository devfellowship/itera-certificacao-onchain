/**
 * Fixture mode entry (VITE_FIXTURE_MODE=design). Starts the MSW service worker with the design
 * fixtures. The worker script is served by the `msw-worker` plugin in vite.config.ts, only in
 * fixture mode, so the production build ships neither MSW nor the fixtures.
 */
export async function startFixtures(): Promise<void> {
  const [{ setupWorker }, { handlers }] = await Promise.all([import('msw/browser'), import('./handlers')])
  await setupWorker(...handlers).start({ onUnhandledRequest: 'bypass', quiet: true })
  document.documentElement.dataset.fixtureMode = 'design'
}
