import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react'
import { WalletModalProvider, WalletMultiButton } from '@solana/wallet-adapter-react-ui'
import type { ReactNode } from 'react'

// Devnet for now — this is a planning/preview build, no mainnet funds involved.
const ENDPOINT = 'https://api.devnet.solana.com'

export { WalletMultiButton }

export function WalletContextProvider({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider endpoint={ENDPOINT}>
      {/* wallets=[] on purpose: modern Phantom/Solflare register themselves via the Wallet
          Standard, no explicit adapter needed. autoConnect=false avoids the "disconnected
          port" error Phantom throws when a React remount (e.g. StrictMode) races its connect
          handshake — same gotcha hit and fixed in the ChainOil hackathon project. */}
      <WalletProvider wallets={[]} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  )
}
