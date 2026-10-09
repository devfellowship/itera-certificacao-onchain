import { Buffer } from 'buffer'
import { createRoot } from 'react-dom/client'
import './style.css'

// @solana/web3.js (pulled in by @solana/wallet-adapter-react) expects Node's Buffer global at
// module scope. Vite doesn't polyfill it, so without this the app throws a cryptic
// "Cannot read properties of undefined (reading 'hasOwnProperty')" on load with a blank page.
window.Buffer = window.Buffer ?? Buffer
import '@solana/wallet-adapter-react-ui/styles.css'
import { WalletContextProvider, WalletMultiButton } from './wallet'
import { StartRun } from './StartRun'

const stages = [
  { number: '01', title: 'Run', body: 'Give coding agents the same repository and task.' },
  { number: '02', title: 'Evaluate', body: 'Capture patches, tests, logs, and a scored evidence manifest.' },
  { number: '03', title: 'Prove', body: 'Anchor the manifest proof on Solana for independent verification.' },
]

function App() {
  return (
    <main className="shell" data-testid="app-ready">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Itera home">
          <span className="brand-mark">i<span>·</span></span>
          <span>ITERA <strong>/ AGENT CREDENTIALS</strong></span>
        </a>
        <div className="topbar-actions">
          <span className="status"><span className="status-dot" /> Planning preview</span>
          <WalletMultiButton />
          <StartRun />
        </div>
      </header>

      <section className="hero">
        <div className="eyebrow"><span>PROOF OF CAPABILITY</span><span className="line" /></div>
        <h1>Trust the work.<br /><em>Verify the proof.</em></h1>
        <p className="intro">A coding agent earns a credential through a reproducible task, objective checks, and evidence anchored on Solana.</p>
        <div className="hero-actions">
          <a className="primary" href="https://plans.devfellowship.com/20261006-itera-certificacao-onchain-hackathon-colosseum" target="_blank" rel="noreferrer">Explore the plan <span aria-hidden="true">↗</span></a>
          <a className="secondary" href="https://github.com/devfellowship/itera-certificacao-onchain" target="_blank" rel="noreferrer">View source <span aria-hidden="true">↗</span></a>
        </div>
      </section>

      <section className="process" aria-label="Proposed evaluation flow">
        <div className="process-head"><span>THE PROPOSED FLOW</span><span>01 — 03</span></div>
        <div className="cards">
          {stages.map((stage) => (
            <article className="card" key={stage.number}>
              <span className="card-number">{stage.number}</span>
              <h2>{stage.title}</h2>
              <p>{stage.body}</p>
            </article>
          ))}
        </div>
      </section>

      <footer><span>Itera × DevFellowship</span><span>Architecture in progress · Colosseum 2026</span></footer>
    </main>
  )
}

// No StrictMode here on purpose: its deliberate double-mount races Phantom's connect
// handshake and throws "disconnected port" — same issue hit and fixed in ChainOil.
createRoot(document.getElementById('root')!).render(
  <WalletContextProvider><App /></WalletContextProvider>,
)
