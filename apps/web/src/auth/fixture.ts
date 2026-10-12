/**
 * Fixture mode (U2): VITE_FIXTURE_MODE=design serves the design's mock data through MSW and signs
 * in as the design user. The production build never sets it, so this branch is dead code there.
 */
export const FIXTURE_MODE = import.meta.env.VITE_FIXTURE_MODE === 'design'

/** The user of the design mocks (App Nav.dc.html). */
export const FIXTURE_USER = {
  wallet: '7Tma4kEXAMPLEwa11etAddre55DesignFixturen9QvA',
  displayName: 'Bruno Lima',
  handle: 'brunolima',
  initials: 'BL',
  balanceSol: 4.218,
}
