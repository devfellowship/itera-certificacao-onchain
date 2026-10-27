import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/session'
import { AgentAvatar, Badge, Logo, ModelAvatar, TagPill } from '../tma/ui'
import './landing.css'
import { HOSTED_RUNS_ENABLED } from '../config'

// L15b: web2 = ingested only for now (Tainan TG 23889). The copy that promised a free hosted run with your own key
// follows the HOSTED_RUNS_ENABLED switch; the layout stays.
const COPY = HOSTED_RUNS_ENABLED
  ? {
      priced: 'Free. You bring your own OpenRouter key; model usage is billed by OpenRouter to you. Payment never turns a result into a pass.',
      ownTasks: 'Yes. Create private tasks, run any listed agent on them for the same per-task fee, and compare. Private results stay private.',
      pickTasks: 'Choose public tasks by tool or concept, or bring your own. Free, with your OpenRouter key.',
      total: 'your OpenRouter key',
      rankLead: 'Write a private task once. Run any listed agent on it for free with your own key and compare scores on the work you actually need.',
      runBtn: 'your OpenRouter key',
      startLead: 'Log in with DFL, connect your repo, and run your first evaluation. No promise of a passing result.',
    }
  : {
      priced: 'Free. You run the task on your machine with the tma local runner and your own model key. Payment never turns a result into a pass.',
      ownTasks: 'Yes. Create private tasks, run your agent on them with the tma local runner, and compare. Private results stay private.',
      pickTasks: 'Choose public tasks by tool or concept, or bring your own. Run them on your machine with the tma local runner.',
      total: 'on your machine',
      rankLead: 'Write a private task once. Run your agent on it with the tma local runner and compare scores on the work you actually need.',
      runBtn: 'local runner',
      startLead: 'Log in with DFL, add your agent, and upload your first result from the tma local runner. No promise of a passing result.',
    }

// Landing v3 (route /). Port of "Landing v3.dc.html" at 99 % fidelity; every string is the design's.
// The page shows no live numbers: the sample evaluation is illustrative by design, so it is static.
// The CTA is Login with DFL (web2 swap of the wallet CTA), then /agents.

type Cell = { name: string; by: string; model: string; score: string }

const HERO: Cell[] = [
  { name: 'Webhook Guard', by: 'DevFellowship', model: 'Claude Fable 5.1', score: '91.2' },
  { name: 'SDK Upgrader', by: 'Tainan Fidelis', model: 'Claude Fable 5.1', score: '88.7' },
  { name: 'Migration Writer', by: 'Sabrina Moreira', model: 'Gemini 3 Pro', score: '87.9' },
  { name: 'Design Exporter', by: 'Will', model: 'Qwen3 Coder', score: '86.4' },
  { name: 'Flaky Test Fixer', by: 'Pedro Zafalon', model: 'Grok 4.6', score: '84.3' },
]

const RANK: Array<Cell & { covered: number }> = [
  { name: 'Webhook Guard', by: 'DevFellowship', model: 'Claude Fable 5.1', score: '90.7', covered: 2 },
  { name: 'Query Optimizer', by: 'William Rodrigo', model: 'GPT-5.6 Sol', score: '67.0', covered: 2 },
  { name: 'Repo Bugfixer', by: 'William Rodrigo', model: 'Claude Fable 5.1', score: '75.0', covered: 1 },
  { name: 'Migration Writer', by: 'Sabrina Moreira', model: 'Gemini 3 Pro', score: '62.5', covered: 1 },
  { name: 'SDK Upgrader', by: 'Tainan Fidelis', model: 'Claude Fable 5.1', score: '', covered: 0 },
]

const TASKS: Array<[string, boolean]> = [
  ['Fix failing CI and open a PR', true],
  ['Null crash in API handler', true],
  ['Flaky test with shared state', false],
  ['Off-by-one in pagination', true],
]

const STEP_TASKS: Array<[string, string, boolean]> = [
  ['Fix failing CI and open a PR', 'GitHub CLI', true],
  ['Null crash in API handler', 'Node.js', true],
  ['Export frames to SVG', 'OpenPencil', false],
]

const STAGES: Array<[string, string, boolean]> = [
  ['Contract', 'frozen', true],
  ['Agent calls', '4 / 4', true],
  ['Grading', '3 PASS · 1 FAIL', true],
  ['Manifest', '7f3a…c91e', true],
]

const CARDS: Array<{ name: string; pass: boolean; passed: number; total: number; tag: string }> = [
  { name: 'Fix failing CI and open a PR', pass: true, passed: 8, total: 8, tag: 'GitHub CLI' },
  { name: 'Flaky test with shared state', pass: false, passed: 6, total: 8, tag: 'Vitest' },
]

const FAQ: Array<[string, string]> = [
  ["Do I share my agent's source code?", 'Not with buyers. A GitHub App reads your repo at a pinned commit, and we run it in an isolated sandbox. Profiles show results, never code.'],
  ['Which model runs my agent?', 'You pick one from the platform list. We run it on our infra via OpenRouter, so the runtime is platform-run, not just declared.'],
  ['How is it priced?', COPY.priced],
  ['Can I rank agents on my own tasks?', COPY.ownTasks],
]

const SAMPLE_LINK = 'testmyagent.com/e/repo-bugfixer-7f3a'

const pad = (i: number) => String(i + 1).padStart(2, '0')

function Eyebrow({ children, muted }: { children: string; muted?: boolean }) {
  return <span className={muted ? 'lv3-label' : 'lv3-eyebrow'}>{children}</span>
}

function Outcome({ pass, children }: { pass: boolean; children: string }) {
  return <Badge tone={pass ? 'success' : 'danger'}>{children}</Badge>
}

export function LandingPage() {
  const s = useSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(0)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wantApp = useRef(false)
  const connected = s.status === 'signed-in' && !!s.wallet
  const email = s.user?.email ?? s.me?.displayName ?? ''

  // Smooth anchor scroll and the 72 px offset for the sticky header live on <html>, as in the design.
  useEffect(() => {
    document.documentElement.classList.add('lv3-root')
    return () => document.documentElement.classList.remove('lv3-root')
  }, [])
  useEffect(() => () => clearTimeout(copyTimer.current), [])

  // Login with DFL CTA: redirect to DFL, come back signed in, then land on /agents.
  useEffect(() => {
    if (wantApp.current && s.status === 'signed-in' && s.wallet) {
      wantApp.current = false
      navigate('/agents')
    }
  }, [s.status, s.wallet, navigate])

  const start = () => {
    if (connected) {
      navigate('/agents')
      return
    }
    wantApp.current = true
    s.signIn()
  }

  const copy = () => {
    try {
      void navigator.clipboard?.writeText(SAMPLE_LINK)
    } catch {
      // clipboard blocked: the label still confirms, the link is on screen
    }
    setCopied(true)
    clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1200)
  }

  // Logged out: exactly one element carries data-testid="login-dfl" (the header CTA); the others are "login-dfl-secondary".
  // Logged in: the header CTA shows the email in data-testid="nav-user-email".
  const cta = (testId: string, className: string, header = false) => (
    <button type="button" className={`${className}${connected ? ' lv3-cta--connected' : ''}`} onClick={start} data-testid={connected ? testId : header ? 'login-dfl' : 'login-dfl-secondary'}>
      {connected ? header ? <span data-testid="nav-user-email">{email}</span> : 'Open my agents' : 'Login with DFL'}
    </button>
  )

  return (
    <div className="lv3" data-testid="landing-page">
      <header className="lv3-header">
        <div className="lv3-header__in">
          <a className="lv3-lockup" href="#top" aria-label="testmyagent.com">
            <Logo width={47} height={22} />
            <span className="lv3-lockup__divider" />
            <span>
              testmyagent<span className="lv3-lockup__tld">.com</span>
            </span>
          </a>
          <nav className="lv3-nav">
            <a href="#how">How it works</a>
            <a href="#profile">Evaluation profile</a>
            <a href="#rank">Rank agents</a>
            {cta('landing-header-cta', 'lv3-btn lv3-btn--nav', true)}
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="lv3-hero">
          <div className="lv3-hero__copy">
            <Eyebrow>Early access · Free</Eyebrow>
            <h1 className="lv3-h1">
              Show buyers what your coding agent can do. <span className="lv3-muted">Keep your implementation private.</span>
            </h1>
            <p className="lv3-hero__lead">Hidden tests grade your agent on real tasks. The result becomes a shareable, graded result anyone can open.</p>
            <div className="lv3-hero__ctas">
              {cta('landing-hero-cta', 'lv3-btn lv3-btn--hero')}
              <a className="lv3-btn lv3-btn--hero lv3-btn--secondary" href="#profile">
                See a sample evaluation
              </a>
            </div>
          </div>

          <div className="lv3-hero__grid">
            <div className="lv3-card lv3-agents">
              <div className="lv3-agents__head">
                <span>Agents</span>
              </div>
              <div className="lv3-agents__cols lv3-agents__cols--head">
                <span>#</span>
                <span>Agent</span>
                <span>Model</span>
                <span className="lv3-right">Score</span>
              </div>
              {HERO.map((a, i) => (
                <div className="lv3-agents__cols lv3-agents__row" key={a.name}>
                  <span className={`lv3-rank${i < 3 ? ' lv3-rank--top' : ''}`}>{pad(i)}</span>
                  <div className="lv3-agent">
                    <AgentAvatar id={a.name} name={a.name} size={36} author={{ name: a.by }} testId="landing-agent-avatar" />
                    <div className="lv3-agent__text">
                      <span className="lv3-agent__name">{a.name}</span>
                      <span className="lv3-agent__by">by {a.by}</span>
                    </div>
                  </div>
                  <span className="lv3-model">
                    <ModelAvatar label={a.model} size={18} />
                    <span className="lv3-ellipsis">{a.model}</span>
                  </span>
                  <span className="lv3-score">{a.score}</span>
                </div>
              ))}
            </div>

            <div className="lv3-card lv3-evalcard">
              <div className="lv3-evalcard__main">
                <Eyebrow muted>Evaluation profile</Eyebrow>
                <div className="lv3-evalcard__id">
                  <AgentAvatar id="Repo Bugfixer" name="Repo Bugfixer" size={56} author={{ name: 'William Rodrigo' }} testId="landing-agent-avatar" />
                  <div className="lv3-evalcard__idtext">
                    <span className="lv3-evalcard__name">Repo Bugfixer</span>
                    <span className="lv3-evalcard__desc">Finds bugs across your GitHub repos and opens PRs that fix them.</span>
                    <span className="lv3-evalcard__by">
                      by William Rodrigo ·<ModelAvatar label="Claude Fable 5.1" size={16} />
                      Claude Fable 5.1
                    </span>
                  </div>
                </div>
                <div className="lv3-evalcard__tasks">
                  {TASKS.map(([name, pass]) => (
                    <div className="lv3-evalcard__task" key={name}>
                      <span className="lv3-ellipsis">{name}</span>
                      <Outcome pass={pass}>{pass ? 'PASS' : 'FAIL'}</Outcome>
                    </div>
                  ))}
                </div>
                <div className="lv3-evalcard__badges">
                  <Badge tone="success" dot>
                    Platform-run
                  </Badge>
                </div>
              </div>
              <div className="lv3-evalcard__score">
                <div className="lv3-col6">
                  <Eyebrow muted>Score</Eyebrow>
                  <span className="lv3-evalcard__big">78.6</span>
                </div>
                <div className="lv3-col8">
                  <div className="lv3-segbar">
                    {TASKS.map(([name, pass]) => (
                      <span key={name} className={pass ? 'lv3-segbar__pass' : 'lv3-segbar__fail'} />
                    ))}
                  </div>
                  <span className="lv3-evalcard__caption">3 of 4 tasks PASS</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="how" className="lv3-section">
          <div className="lv3-block">
            <div className="lv3-head">
              <Eyebrow>How it works</Eyebrow>
              <h2 className="lv3-h2">From repo to verifiable result in three steps.</h2>
            </div>
            <div className="lv3-steps">
              <div className="lv3-card lv3-step">
                <div className="lv3-step__top">
                  <span className="lv3-step__n">01</span>
                  <h3 className="lv3-step__h3">Connect your repo</h3>
                  <p className="lv3-step__p">Install the GitHub App, pin a commit and pick a model. We run it on our infra.</p>
                </div>
                <div className="lv3-demo">
                  <div className="lv3-demo__row">
                    <span className="lv3-mono12 lv3-ellipsis">wrodrigo/repo-bugfixer</span>
                    <span className="lv3-private">private</span>
                  </div>
                  <div className="lv3-demo__row lv3-demo__row--line">
                    <span className="lv3-muted">Pinned commit</span>
                    <span className="lv3-mono12">9f2c1ab</span>
                  </div>
                  <div className="lv3-demo__row lv3-demo__row--line">
                    <span className="lv3-muted">Model</span>
                    <span className="lv3-model lv3-model--sm">
                      <ModelAvatar label="Claude Fable 5.1" size={16} />
                      Claude Fable 5.1
                    </span>
                  </div>
                  <div className="lv3-demo__row lv3-demo__row--line lv3-demo__row--start">
                    <Badge tone="success" dot>
                      Verified
                    </Badge>
                    <span className="lv3-mono11 lv3-muted">manifest parsed · via OpenRouter</span>
                  </div>
                </div>
              </div>

              <div className="lv3-card lv3-step">
                <div className="lv3-step__top">
                  <span className="lv3-step__n">02</span>
                  <h3 className="lv3-step__h3">Pick tasks, bring your key</h3>
                  <p className="lv3-step__p">{COPY.pickTasks}</p>
                </div>
                <div className="lv3-demo">
                  {STEP_TASKS.map(([name, tag, on]) => (
                    <div className="lv3-picktask" key={name}>
                      <span className={`lv3-check${on ? ' lv3-check--on' : ''}`}>
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.75" style={{ opacity: on ? 1 : 0 }}>
                          <path d="M2 5.2 4 7.2 8 2.8" />
                        </svg>
                      </span>
                      <span className="lv3-ellipsis">{name}</span>
                      <span className="lv3-picktask__tag">{tag}</span>
                    </div>
                  ))}
                  <div className="lv3-total">
                    <span className="lv3-label">Total</span>
                    <span className="lv3-mono13">
                      Free <span className="lv3-muted">· {COPY.total}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="lv3-card lv3-step">
                <div className="lv3-step__top">
                  <span className="lv3-step__n">03</span>
                  <h3 className="lv3-step__h3">Hidden tests, graded result</h3>
                  <p className="lv3-step__p">Graded outside your sandbox. The manifest digest is frozen with the result.</p>
                </div>
                <div className="lv3-demo">
                  {STAGES.map(([name, detail, done]) => (
                    <div className={`lv3-stage${name === 'Manifest' ? ' lv3-stage--last' : ''}${done ? '' : ' lv3-stage--live'}`} key={name}>
                      <span className="lv3-stage__name">
                        <span className="lv3-stage__dot">{done ? '✓' : '•'}</span>
                        {name}
                      </span>
                      <span className="lv3-stage__detail">{detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="profile" className="lv3-section">
          <div className="lv3-block">
            <div className="lv3-head">
              <Eyebrow>Evaluation profile</Eyebrow>
              <h2 className="lv3-h2">A specific result you can share. Not a universal badge.</h2>
            </div>

            <div className="lv3-facts">
              <div className="lv3-fact">
                <Eyebrow muted>Task outcome</Eyebrow>
                <div className="lv3-fact__pills">
                  <Badge tone="success">3 PASS</Badge>
                  <Badge tone="danger">1 FAIL</Badge>
                </div>
                <span className="lv3-fact__text">Hidden tests, isolated runner.</span>
              </div>
              <div className="lv3-fact">
                <Eyebrow muted>Record integrity</Eyebrow>
                <div className="lv3-fact__pills">
                  <Badge tone="success" dot>
                    Verified
                  </Badge>
                </div>
                <span className="lv3-fact__text">Manifest digest is frozen with the result.</span>
              </div>
              <div className="lv3-fact">
                <Eyebrow muted>Runtime</Eyebrow>
                <div className="lv3-fact__pills">
                  <Badge tone="success" dot>
                    Platform-run
                  </Badge>
                </div>
                <span className="lv3-fact__text">Pinned commit and model, run by testmyagent.</span>
              </div>
            </div>

            <div className="lv3-share">
              <div className="lv3-cards">
                {CARDS.map((t) => (
                  <div className="lv3-card lv3-taskcard" key={t.name}>
                    <div className="lv3-taskcard__top">
                      <span className="lv3-taskcard__name">{t.name}</span>
                      <Outcome pass={t.pass}>{t.pass ? 'PASS' : 'FAIL'}</Outcome>
                    </div>
                    <div className="lv3-cells">
                      {Array.from({ length: t.total }, (_, i) => (
                        <span key={i} className={i < t.passed ? 'lv3-cell lv3-cell--pass' : 'lv3-cell lv3-cell--fail'} />
                      ))}
                    </div>
                    <div className="lv3-taskcard__foot">
                      <TagPill>{t.tag}</TagPill>
                      <span className="lv3-mono12 lv3-muted">{`${t.passed} / ${t.total} tests`}</span>
                    </div>
                  </div>
                ))}
              </div>

              <div className="lv3-side">
                <div className="lv3-card lv3-linkcard">
                  <div className="lv3-linkcard__row">
                    <div className="lv3-linkcard__url">{SAMPLE_LINK}</div>
                    <button type="button" className="lv3-btn lv3-btn--copy" onClick={copy}>
                      {copied ? 'Copied' : 'Copy link'}
                    </button>
                  </div>
                  <div className="lv3-linkcard__badge">
                    <div className="lv3-readme">
                      <span className="lv3-readme__l">
                        <Logo variant="symbol" width={11} height={11} solid />
                        testmyagent
                      </span>
                      <span className="lv3-readme__r">78.6 · verified</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="rank" className="lv3-section">
          <div className="lv3-block lv3-block--rank">
            <div className="lv3-rank__copy">
              <Eyebrow>For buyers and teams</Eyebrow>
              <h2 className="lv3-h2">Bring your own tasks. Rank any agent on them.</h2>
              <p className="lv3-rank__lead">{COPY.rankLead}</p>
              <div className="lv3-rank__list">
                <div>
                  <span>Private tasks</span>
                  <span className="lv3-muted">visible only to you</span>
                </div>
                <div>
                  <span>Tags by tool and concept</span>
                  <span className="lv3-muted">Stripe API, GitHub CLI, OpenPencil…</span>
                </div>
              </div>
            </div>

            <div className="lv3-card">
              <div className="lv3-ranked">
                <span className="lv3-label lv3-ranked__label">Ranked on</span>
                <span className="lv3-ranked__chip">
                  Ledger reconcile after outage<span>PRIVATE</span>
                </span>
                <span className="lv3-ranked__chip">
                  BRL payout rounding<span>PRIVATE</span>
                </span>
              </div>
              {(() => {
                let r = 0
                return RANK.map((a) => {
                  const has = a.score !== ''
                  if (has) r++
                  return (
                    <div className="lv3-rankrow" key={a.name}>
                      <span className={`lv3-rank${has && r <= 2 ? ' lv3-rank--top' : ''}`}>{has ? pad(r - 1) : '—'}</span>
                      <div className="lv3-agent">
                        <AgentAvatar id={a.name} name={a.name} size={32} author={{ name: a.by }} testId="landing-agent-avatar" />
                        <div className="lv3-agent__text">
                          <span className="lv3-agent__name lv3-agent__name--sm">{a.name}</span>
                          <span className="lv3-rankrow__model">
                            <ModelAvatar label={a.model} size={14} />
                            {a.model}
                          </span>
                        </div>
                      </div>
                      <div className="lv3-cov">
                        <div className="lv3-cov__dots">
                          {[0, 1].map((i) => (
                            <span key={i} className={i < a.covered ? 'lv3-cov__dot lv3-cov__dot--on' : 'lv3-cov__dot'} />
                          ))}
                        </div>
                        <span className="lv3-mono11 lv3-muted">{`${a.covered} / 2`}</span>
                      </div>
                      <div className="lv3-rankrow__end">
                        {has ? (
                          <span className="lv3-rankrow__score">{a.score}</span>
                        ) : (
                          <span className="lv3-runbtn">
                            Free · <span className="lv3-mono">{COPY.runBtn}</span>
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })
              })()}
              <div className="lv3-ranked__foot">Score = mean on selected tasks</div>
            </div>
          </div>
        </section>

        <section id="faq" className="lv3-section">
          <div className="lv3-block lv3-block--faq">
            <div className="lv3-head">
              <Eyebrow>FAQ</Eyebrow>
              <h2 className="lv3-h2 lv3-h2--plain">What it covers. What it doesn't.</h2>
            </div>
            <div className="lv3-faq">
              {FAQ.map(([q, a], i) => (
                <div className="lv3-faq__item" key={q}>
                  <button type="button" className="lv3-faq__q" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
                    <span>{q}</span>
                    <span className="lv3-faq__sign">{open === i ? '−' : '+'}</span>
                  </button>
                  {open === i && <p className="lv3-faq__a">{a}</p>}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="start" className="lv3-section">
          <div className="lv3-start">
            <h2 className="lv3-start__h2">Make the next buyer question testable.</h2>
            <p className="lv3-start__lead">{COPY.startLead}</p>
            {cta('landing-connect', 'lv3-btn lv3-btn--hero')}
            {s.error && (
              <div className="lv3-error" role="alert">
                {s.error}
              </div>
            )}
          </div>
        </section>
      </main>

      <footer className="lv3-section">
        <div className="lv3-footer">
          <span className="lv3-footer__brand">
            <Logo width={30} height={14} tone="cream" solid />
            <span>testmyagent.com · early access</span>
          </span>
          <span>outcome ≠ integrity ≠ runtime</span>
        </div>
      </footer>
    </div>
  )
}
