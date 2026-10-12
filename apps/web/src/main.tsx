import { Buffer } from 'buffer'
import { createRoot } from 'react-dom/client'

// @solana/web3.js (pulled in by @solana/wallet-adapter-react) expects Node's Buffer global at
// module scope. Vite doesn't polyfill it, so without this the app throws a cryptic
// "Cannot read properties of undefined (reading 'hasOwnProperty')" on load with a blank page.
window.Buffer = window.Buffer ?? Buffer

import '@solana/wallet-adapter-react-ui/styles.css'
import './tma/tokens.css'
import './tma/ui'
import './tma/wallet-modal.css'
import { RouterProvider } from 'react-router-dom'
import { WalletContextProvider } from './wallet'
import { SessionProvider } from './auth/session'
import { createRouter } from './router'

async function boot() {
  // Fixture mode (U2) starts the MSW worker before the first request. The production build never
  // sets VITE_FIXTURE_MODE, so Vite drops this branch and the fixtures from the bundle.
  if (import.meta.env.VITE_FIXTURE_MODE === 'design') {
    const { startFixtures } = await import('./fixtures/start')
    await startFixtures()
  }
  const router = createRouter()
  // No StrictMode here on purpose: its deliberate double-mount races Phantom's connect
  // handshake and throws "disconnected port" — same issue hit and fixed in ChainOil.
  createRoot(document.getElementById('root')!).render(
    <WalletContextProvider>
      <SessionProvider>
        <RouterProvider router={router} />
      </SessionProvider>
    </WalletContextProvider>,
  )
}

void boot()
