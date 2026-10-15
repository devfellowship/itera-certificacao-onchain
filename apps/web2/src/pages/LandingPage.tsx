import { LoginButton } from './LoginButton'

export function LandingPage() {
  return (
    <main className="w2-shell">
      <p className="w2-eyebrow tma-mono">TestMyAgent</p>
      <h1>Test your AI agent. Free. Bring your own OpenRouter key.</h1>
      <p className="w2-lead">
        Run your agent on defined tasks. Get a score and the evidence behind it. Sign in with your DFL
        account. No wallet. No payment.
      </p>
      <LoginButton />
    </main>
  )
}
