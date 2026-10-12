import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/session'
import { Logo } from '../tma/ui'
import './landing.css'

// Owner: lane U3 (Landing v2). Port of "Landing v2.dc.html" at 99 % fidelity. Only the strings that
// ADR-10 of plan 20261012-itera-testmyagent-ui-refactor lists are changed; the rest is word for word.
// The page shows no live numbers: the sample credential is illustrative by design, so it is static.

type Tone = 'success' | 'warning' | 'danger' | 'neutral'

const FAQ: Array<[string, string]> = [
  ["Do I share my agent's source code?", 'We read your agent files from the repos you pick, pinned to a commit. Buyers see results, never your files.'], // ADR-10 #4
  ['What does a credential cover?', "One task, a declared release, the conditions, observed results and the issuer's record. Not a general endorsement or future guarantee."],
  ["Can you test my customer's task?", 'Through a guided pilot, after agreeing permissions, criteria, reference behavior and visibility.'],
  ['Can a buyer verify without a wallet?', 'Yes, for public records. Restricted evidence requires authorization.'],
  ['Does Solana prove the score is correct?', 'No. It verifies the issued record and evidence digest. Result quality depends on the evaluation method and issuer.'],
  ['Do you prove which model runs?', 'Not initially. Declared release is shown apart from what the evaluator observed.'],
  ['Are failed results visible?', 'Publication needs authorization. Published campaigns state scope, attempts, failures and timeouts. Paying never turns a result into a pass.'],
  ['How is it priced?', 'US$0.10 per task-run, paid in SOL before the run. Verification is never the paid outcome.'], // ADR-10 #5
]

const CHECKS = ['Valid event → one ledger credit', 'Duplicate delivery → no second credit', 'Unrelated entries → unchanged']

const TRAIL = [
  { time: 'T+00', label: 'Task contract frozen', detail: 'fixture · criteria · budget' },
  { time: 'T+01', label: 'Task request sent', detail: 'allowlisted endpoint · digest recorded' },
  { time: 'T+42', label: 'Patch received', detail: 'artifact bytes frozen' },
  { time: 'T+47', label: 'External checks evaluated', detail: '3/3 · outside supplier endpoint' },
  { time: 'T+49', label: 'Redacted result prepared', detail: 'scope reviewed before digest' },
]

const FIELDS: Array<{ k: string; v: string; badge?: { text: string; tone: Tone } }> = [
  { k: 'Agent', v: 'Demo Studio · Coding Agent' },
  { k: 'Release', v: 'demo-release-01', badge: { text: 'DECLARED', tone: 'neutral' } },
  { k: 'Task', v: 'webhook-ledger@0.1' },
  { k: 'Interaction', v: 'Request → patch → checks' },
  { k: 'Criteria', v: '3 / 3', badge: { text: 'PASS', tone: 'success' } },
  { k: 'Attempts', v: '1' },
  { k: 'Time & cost', v: 'Unavailable', badge: { text: 'UNVERIFIED', tone: 'warning' } },
  { k: 'Issuer', v: 'testmyagent · proposed' },
  { k: 'Record', v: 'No transaction', badge: { text: 'NOT ISSUED', tone: 'warning' } },
  { k: 'Limits', v: 'This task only. Not general competence.' },
]

function Badge({ tone, dot, sm, children }: { tone: Tone; dot?: boolean; sm?: boolean; children: ReactNode }) {
  return (
    <span className={`lv2-badge lv2-badge--${tone}${sm ? ' lv2-badge--sm' : ''}`}>
      {dot && <span className="lv2-badge__dot" />}
      {children}
    </span>
  )
}

export function LandingPage() {
  const s = useSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(0)
  const wantApp = useRef(false)
  const busy = s.status === 'connecting' || s.status === 'signing'

  // Smooth anchor scroll and the 72 px offset for the sticky header live on <html>, as in the design.
  useEffect(() => {
    document.documentElement.classList.add('lv2-root')
    return () => document.documentElement.classList.remove('lv2-root')
  }, [])

  // "Evaluate your agent" / "Connect wallet": sign in with the wallet (SIWS), then land on /agents.
  useEffect(() => {
    if (wantApp.current && s.status === 'signed-in' && s.wallet) {
      wantApp.current = false
      navigate('/agents')
    }
  }, [s.status, s.wallet, navigate])

  const start = () => {
    if (s.status === 'signed-in' && s.wallet) {
      navigate('/agents')
      return
    }
    wantApp.current = true
    s.signIn()
  }

  return (
    <div className="lv2" data-testid="landing-page">
      <header className="lv2-header">
        <div className="lv2-wrap lv2-header__in">
          <a className="lv2-lockup" href="#top" aria-label="testmyagent.com">
            <Logo width={47} height={22} />
            <span className="lv2-lockup__divider" />
            <span>
              testmyagent<span className="lv2-lockup__tld">.com</span>
            </span>
          </a>
          <nav className="lv2-header__nav">
            <a className="lv2-btn lv2-btn--primary lv2-header__cta" href="#request">
              Request an evaluation
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="lv2-wrap lv2-hero">
          <div className="lv2-hero__copy">
            <h1 className="lv2-h1">
              Show buyers what your coding agent can do. <span className="lv2-muted">Keep your implementation private.</span>
            </h1>
            <p className="lv2-hero__lead">Verifiable task results. No source code shared.</p>
            <div className="lv2-hero__ctas">
              <button type="button" className="lv2-btn lv2-btn--primary" onClick={start} disabled={busy} data-testid="landing-hero-cta">
                Evaluate your agent
              </button>
              <a className="lv2-btn lv2-btn--secondary" href="#evidence">
                Explore a sample credential
              </a>
            </div>
          </div>

          <div className="lv2-card">
            <div className="lv2-cred__head">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div className="lv2-cred__title">Duplicate settlement webhook</div>
                <div className="lv2-cred__sub">Demo Studio · Coding Agent</div>
              </div>
              <div className="lv2-cred__id">webhook-ledger@0.1</div>
            </div>
            <div className="lv2-facts">
              <div className="lv2-fact">
                <div className="lv2-label">Outcome</div>
                <div>
                  <Badge tone="success" dot>
                    PASS
                  </Badge>
                </div>
              </div>
              <div className="lv2-fact">
                <div className="lv2-label">Record</div>
                <div>
                  <Badge tone="warning" dot>
                    NOT ISSUED
                  </Badge>
                </div>
              </div>
              <div className="lv2-fact">
                <div className="lv2-label">Runtime</div>
                <div>
                  <Badge tone="neutral" dot>
                    DECLARED
                  </Badge>
                </div>
              </div>
            </div>
            <div>
              <div className="lv2-checks__head">
                <span>Check</span>
                <span>Result</span>
              </div>
              {CHECKS.map((c) => (
                <div className="lv2-check" key={c}>
                  <span>{c}</span>
                  <span className="lv2-check__res">PASS</span>
                </div>
              ))}
            </div>
            <div className="lv2-cred__foot">
              <span>digest —</span>
              <span>1 attempt · cost unavailable</span>
            </div>
          </div>
        </section>

        <section id="proof" className="lv2-section">
          <div className="lv2-wrap lv2-block">
            <div className="lv2-head">
              <div className="lv2-head__text">
                <div className="lv2-eyebrow">What the proof means</div>
                <h2 className="lv2-h2">
                  Three facts. Never merged.
                </h2>
              </div>
            </div>
            <div className="lv2-facts3">
              <div className="lv2-fact3">
                <div className="lv2-fact3__n">01</div>
                <h3 className="lv2-h3">Task outcome</h3>
                <p>PASS, FAIL or INVALID for one task and release.</p>
                <div className="lv2-fact3__badges">
                  <Badge tone="success">PASS</Badge>
                  <Badge tone="danger">FAIL</Badge>
                  <Badge tone="neutral">INVALID</Badge>
                </div>
              </div>
              <div className="lv2-fact3">
                <div className="lv2-fact3__n">02</div>
                <h3 className="lv2-h3">Record integrity</h3>
                <p>Issuer, schema and digest match the manifest.</p>
                <div className="lv2-fact3__badges">
                  <Badge tone="success">VERIFIED</Badge>
                  <Badge tone="danger">MISMATCH</Badge>
                  <Badge tone="warning">UNAVAILABLE</Badge>
                </div>
              </div>
              <div className="lv2-fact3">
                <div className="lv2-fact3__n">03</div>
                <h3 className="lv2-h3">Runtime identity</h3>
                <p>Declared release. Not independently verified.</p>
                <div className="lv2-fact3__badges">
                  <Badge tone="neutral">DECLARED</Badge>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="how" className="lv2-section">
          <div className="lv2-wrap lv2-cols">
            <div className="lv2-col">
              <div className="lv2-head__text">
                <div className="lv2-eyebrow">How it works</div>
                <h2 className="lv2-h2 lv2-h2--balance">A task in. An artifact out. A separate evaluator.</h2>
              </div>
              <div className="lv2-steps">
                <div className="lv2-step">
                  <div className="lv2-step__n">01</div>
                  <div className="lv2-step__body">
                    <h3 className="lv2-h3">Choose the task</h3>
                    <p>Criteria, release and conditions agreed before the run.</p>
                  </div>
                </div>
                <div className="lv2-step">
                  <div className="lv2-step__n">02</div>
                  <div className="lv2-step__body">
                    <h3 className="lv2-h3">Evaluate the response</h3>
                    {/* ADR-10 #2 */}
                    <p>We run your agent from your repo in a sandbox. A separate evaluator tests the patch.</p>
                  </div>
                </div>
                <div className="lv2-step">
                  <div className="lv2-step__n">03</div>
                  <div className="lv2-step__body">
                    <h3 className="lv2-h3">Share verifiable evidence</h3>
                    <p>Publish the authorized result. Buyers verify issuer and digest.</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="lv2-code">
              <div className="lv2-code__head">
                <span>observation trail</span>
              </div>
              {TRAIL.map((t) => (
                <div className="lv2-trail" key={t.time}>
                  <span className="lv2-trail__time">{t.time}</span>
                  <span className="lv2-trail__dot" />
                  <span className="lv2-trail__text">
                    <span className="lv2-trail__label">{t.label}</span>
                    <span className="lv2-trail__detail">{t.detail}</span>
                  </span>
                </div>
              ))}
              <div className="lv2-code__foot">
                <span>outcome</span>
                <b>PASS</b>
              </div>
            </div>
          </div>
        </section>

        <section id="evidence" className="lv2-section">
          <div className="lv2-wrap lv2-block lv2-block--80">
            <div className="lv2-head">
              <div className="lv2-head__text">
                <div className="lv2-eyebrow">Sample credential</div>
                <h2 className="lv2-h2">
                  A specific result. Not a universal badge.
                </h2>
              </div>
              <a href="#evidence" style={{ fontSize: 14, fontWeight: 500 }}>
                Inspect the sample →
              </a>
            </div>
            <div className="lv2-evidence">
              <div className="lv2-card">
                <div className="lv2-strip">Illustrative · no agent run or onchain transaction</div>
                {FIELDS.map((f) => (
                  <div className="lv2-field" key={f.k}>
                    <span className="lv2-label">{f.k}</span>
                    <span className="lv2-field__v">
                      {f.v}
                      {f.badge && (
                        <Badge tone={f.badge.tone} sm>
                          {f.badge.text}
                        </Badge>
                      )}
                    </span>
                  </div>
                ))}
              </div>
              <div className="lv2-code" style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="lv2-code__head">
                  <span>manifest.json</span>
                  <span>proposed-0.1</span>
                </div>
                <pre className="lv2-json">
                  {'{\n  '}
                  <span className="k">"schema_version"</span>: <span className="s">"proposed-0.1"</span>,{'\n  '}
                  <span className="k">"is_simulated"</span>: <span className="t">true</span>,{'\n  '}
                  <span className="k">"subject"</span>: {'{\n    '}
                  <span className="k">"supplier"</span>: <span className="s">"Demo Studio (fictional)"</span>,{'\n    '}
                  <span className="k">"declared_release"</span>: <span className="s">"demo-release-01"</span>
                  {'\n  },\n  '}
                  <span className="k">"task"</span>: {'{ '}
                  <span className="k">"id"</span>: <span className="s">"webhook-ledger"</span>, <span className="k">"version"</span>: <span className="s">"0.1"</span>
                  {' },\n  '}
                  <span className="k">"outcome"</span>: <span className="s">"PASS"</span>,{'\n  '}
                  <span className="k">"checks"</span>: <span className="s">3</span>,{'\n  '}
                  <span className="k">"attempts"</span>: <span className="s">1</span>,{'\n  '}
                  <span className="k">"cost"</span>: <span className="n">null</span>,{'\n  '}
                  <span className="k">"attestation"</span>: <span className="n">null</span>
                  {'\n}'}
                </pre>
              </div>
            </div>
          </div>
        </section>

        <section className="lv2-section">
          <div className="lv2-wrap lv2-cols">
            <div className="lv2-col lv2-col--12">
              <div className="lv2-eyebrow">Tasks</div>
              <h2 className="lv2-h2 lv2-h2--balance">Start with a known task. Bring your client's task to a pilot.</h2>
            </div>
            <div className="lv2-tasks">
              <div className="lv2-card">
                <a className="lv2-taskrow" href="#request">
                  <span className="lv2-taskrow__text">
                    <span className="lv2-taskrow__title">Use a supported task pack</span>
                    <span className="lv2-taskrow__sub">Public tasks. Fixed criteria.</span>
                  </span>
                  <Badge tone="success">AVAILABLE</Badge>
                </a>
                <a className="lv2-taskrow" href="#request">
                  <span className="lv2-taskrow__text">
                    <span className="lv2-taskrow__title">Discuss a client-specific task</span>
                    <span className="lv2-taskrow__sub">Criteria, permissions and visibility agreed first.</span>
                  </span>
                  <Badge tone="warning">REVIEW</Badge>
                </a>
              </div>
              <div className="lv2-note">No source code, API keys or customer data in the request form.</div>
            </div>
          </div>
        </section>

        <section className="lv2-section">
          <div className="lv2-wrap lv2-aud">
            <div className="lv2-card lv2-aud__card">
              <div className="lv2-label">Vendors &amp; studios</div>
              <h3 className="lv2-aud__h3">Bring evidence to the buyer conversation.</h3>
              <p className="lv2-aud__lead">Use a scoped result in proposals, release reviews and client deliveries.</p>
              <div className="lv2-aud__rows">
                <div className="lv2-aud__row">Explain the claim</div>
                <div className="lv2-aud__row">Preserve your implementation</div>
                <div className="lv2-aud__row">Re-evaluate on change</div>
              </div>
              <div className="lv2-aud__actions" style={{ display: 'block' }}>
                <a className="lv2-btn lv2-btn--inverse" href="#request">
                  Request an evaluation
                </a>
              </div>
            </div>
            <div id="marketplaces" className="lv2-card lv2-aud__card">
              <div className="lv2-label">Marketplaces &amp; protocols</div>
              <h3 className="lv2-aud__h3">Add task evidence to agent listings.</h3>
              <p className="lv2-aud__lead">Read the same scoped record buyers see. Apply your own policy — no evaluator to rebuild.</p>
              <div className="lv2-aud__rows">
                <div className="lv2-aud__row">
                  <span>Task · release · issuer · validity</span>
                  <span>read</span>
                </div>
                <div className="lv2-aud__row">
                  <span>Listing approval</span>
                  <span>your policy</span>
                </div>
                <div className="lv2-aud__row">
                  <span>Payment release</span>
                  <span>never automatic</span>
                </div>
              </div>
              <div className="lv2-aud__actions">
                <a className="lv2-btn lv2-btn--secondary" href="#request" style={{ fontSize: 14 }}>
                  Request an evaluation
                </a>
                <a href="#evidence">Credential format →</a>
              </div>
            </div>
          </div>
        </section>

        <section className="lv2-section">
          <div className="lv2-wrap lv2-cols">
            <div className="lv2-col lv2-col--12">
              <div className="lv2-eyebrow">FAQ</div>
              <h2 className="lv2-h2">
                What it covers. What it doesn't.
              </h2>
            </div>
            <div className="lv2-faq">
              {FAQ.map(([q, a], i) => (
                <div className="lv2-faq__item" key={q}>
                  <button type="button" className="lv2-faq__q" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
                    <span>{q}</span>
                    <span className="lv2-faq__sign">{open === i ? '−' : '+'}</span>
                  </button>
                  {open === i && <p className="lv2-faq__a">{a}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="request" className="lv2-section">
          <div className="lv2-wrap lv2-request">
            <div className="lv2-request__copy">
              <h2 className="lv2-request__h2">Make the next buyer question testable.</h2>
              <p className="lv2-request__lead">One agent. One task. The person who needs the evidence. We scope the first evaluation together.</p>
              <div className="lv2-request__early">Early access · No promise of a passing result</div>
            </div>
            <div className="lv2-request__card">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {/* ADR-10 #3 */}
                <div className="lv2-request__title">Evaluate your agent</div>
                <div className="lv2-request__sub">Connect a wallet to start.</div>
              </div>
              <button type="button" className="lv2-btn lv2-btn--primary lv2-request__btn" onClick={start} disabled={busy} data-testid="landing-connect">
                {s.status === 'signing' ? 'Sign in your wallet…' : 'Connect wallet'}
              </button>
              {s.error && (
                <div className="lv2-request__error" role="alert">
                  {s.error}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="lv2-section">
        <div className="lv2-wrap lv2-footer__in">
          <span className="lv2-footer__brand">
            <Logo width={30} height={14} tone="cream" solid />
            <span>testmyagent.com · early access</span>
          </span>
          <span>outcome ≠ integrity ≠ identity</span>
        </div>
      </footer>
    </div>
  )
}
