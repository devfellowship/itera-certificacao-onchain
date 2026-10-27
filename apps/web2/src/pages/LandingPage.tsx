import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useSession } from '../auth/session'
import { AgentAvatar, Badge, Logo, ModelAvatar } from '../tma/ui'
import './landing.css'
import { HOSTED_RUNS_ENABLED } from '../config'

// Landing v2 (route /). Port of the Claude Design "v2 — redesign (web2)" boards (V2Main, V2Phone, V2States).
// Copy: plan 20261027-testmyagent-web2-copy-repositioning v2. Where the design and the plan disagree, the plan wins.
// The sign-in stays Login with DFL (federation handoff); only the label changes (Q6 = A).
// Every card number on this page is sample data and the page says so, except the case box (our own k15 run, Q2 = A).

// Hosted LLM Infra is not live: the copy follows the HOSTED_RUNS_ENABLED switch (plan "Hosted-flag variant").
const COPY = HOSTED_RUNS_ENABLED
  ? {
      hostedBadge: false,
      step02Extra: ' Or start a hosted run on Hosted LLM Infra.',
      keysExtra: ' On Hosted LLM Infra, the run and its logs are on our servers.',
      whoPays:
        'TestMyAgent is free during early access. You pay the model with your own OpenRouter or opencode go key, or you run it on Hosted LLM Infra.',
    }
  : {
      hostedBadge: true,
      step02Extra: '',
      keysExtra: '',
      whoPays:
        'You do, with your own OpenRouter or opencode go key. TestMyAgent itself is free during early access. Hosted LLM Infra, which runs the model for you, is in early access: request access to try it.',
    }

// Q8 = A: "Request access" is a mailto link. No form, no API route.
const REQUEST_ACCESS_HREF = 'mailto:hello@devfellowship.com?subject=Hosted%20LLM%20Infra%20early%20access'
const CLI_GUIDE_HREF = 'https://github.com/devfellowship/itera-certificacao-onchain/blob/main/services/runner/README.md'

type AgentRow = { name: string; version: string; model: string; score: string; cost: string }

const AGENTS: AgentRow[] = [
  { name: 'Repo Researcher', version: 'v4', model: 'DeepSeek V4.1 Flash', score: '100', cost: '$0.02' },
  { name: 'HTML Reporter', version: 'v1', model: 'DeepSeek V4.1 Flash', score: '100', cost: '$0.03' },
  { name: 'UI Auditor', version: 'v1', model: 'DeepSeek V4.1 Flash', score: '100', cost: '$0.04' },
  { name: 'Webhook Guard', version: 'a1c9f02', model: 'Claude Haiku 4.5', score: '91', cost: '$0.08' },
  { name: 'Flaky Test Fixer', version: '7d2e4b1', model: 'Qwen3 Coder', score: '84', cost: '$0.03' },
]

const COMPARE: Array<{ model: string; passes: string; pass: boolean; score: string; cost: string; best?: boolean }> = [
  { model: 'DeepSeek V4.1 Flash', passes: '5/5 PASS', pass: true, score: '100', cost: '$0.04', best: true },
  { model: 'Claude Haiku 4.5', passes: '5/5 PASS', pass: true, score: '100', cost: '$0.11' },
  { model: 'Nemotron 3 Ultra (free)', passes: '1/5 PASS', pass: false, score: '38', cost: '$0.00' },
]

const STEP_TASKS: Array<[string, string, boolean]> = [
  ['Fix failing CI and open a PR', 'GitHub CLI', true],
  ['Null crash in API handler', 'Node.js', true],
  ['Export frames to SVG', 'OpenPencil', false],
]

const STAGES: Array<[string, string]> = [
  ['Workspace', 'public tests only'],
  ['Agent run', '4 / 4'],
  ['Hidden tests', '3 PASS · 1 FAIL'],
  ['Upload', 'numbers only'],
]

const VERSIONS: Array<{ version: string; pass: boolean; passed: number; total: number }> = [
  { version: 'v3', pass: false, passed: 12, total: 13 },
  { version: 'v4', pass: true, passed: 13, total: 13 },
]

const RANKED: Array<{ model: string; covered: number; cost: string; score: string }> = [
  { model: 'DeepSeek V4.1 Flash', covered: 2, cost: '$0.07', score: '100' },
  { model: 'Claude Haiku 4.5', covered: 2, cost: '$0.19', score: '100' },
  { model: 'Qwen3 Coder', covered: 1, cost: '$0.06', score: '72.5' },
  { model: 'Nemotron 3 Ultra (free)', covered: 1, cost: '$0.00', score: '44.0' },
  { model: 'GPT-5.6 Sol', covered: 0, cost: '', score: '' },
]

const WHY: Array<[string, string]> = [
  ['Does it actually work?', "A good demo doesn't tell you how the agent does across real tasks."],
  ['Did the last change help?', 'Without a fixed baseline, comparing models and versions is guesswork.'],
  ['Are you paying too much?', "The expensive model isn't always the better one. What counts is the cost of a task done right."],
]

const NEXT: Array<[string, string]> = [
  ['Side-by-side comparison', 'Put two versions or two models next to each other, task by task.'],
  ['Human review', "Add human judgment for tasks a test can't settle."],
  ['CI/CD evaluation gates', 'Let a release wait until the agent change passes your bar.'],
]

const FAQ: Array<[string, string]> = [
  ['Do I need to deploy my agent to TestMyAgent?', 'No. You run it on your own machine or VPS with the tma CLI and send the results.'],
  [
    'Do I have to share my API keys?',
    `No. Your model key stays on your machine. TestMyAgent only gets numbers: the score, time, tokens and cost of each run. Your code and the agent's logs stay with you.${COPY.keysExtra}`,
  ],
  [
    'What kinds of agents can I test?',
    'An agent folder with AGENTS.md, CLAUDE.md and skills, which tma runs with opencode. Or the harness you already have, through tma workspace and tma grade.',
  ],
  ['How are results graded?', 'Hidden tests that your agent never sees decide the score. Human review for tasks that need judgment is on the roadmap.'],
  [
    'Can I compare models or agent versions?',
    'Yes, run by run. Keep the tasks and the agent files the same, change one thing, and read the result of each run. A side-by-side view is on the roadmap.',
  ],
  [
    'Are my results verified?',
    "No, and the page says so. A result you ran on your machine is marked self-declared. It's there to help you decide. It isn't a certificate for anyone else.",
  ],
  ['Who pays for the model?', COPY.whoPays],
  ['Can it run in my CI/CD pipeline?', "Not yet. It's on the roadmap."],
]

const pad = (i: number) => String(i + 1).padStart(2, '0')

function Eyebrow({ children, muted }: { children: string; muted?: boolean }) {
  return <span className={muted ? 'lv3-label' : 'lv3-eyebrow'}>{children}</span>
}

/** Origin badges of the design: "Sample data" (neutral) and "Self-declared" (dashed warning). Not state words. */
function SampleData() {
  return <span className="tma-badge tma-badge--neutral tma-badge--origin">Sample data</span>
}
function SelfDeclared() {
  return <span className="tma-badge tma-badge--warning tma-badge--origin">Self-declared</span>
}

function Cmd({ children }: { children: string }) {
  return <code className="v2-cmd">{children}</code>
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true">
      <path d="M2.5 6.2 5 8.5 9.5 3.5" />
    </svg>
  )
}

function Icon({ d }: { d: string }) {
  return (
    <span className="v2-icon">
      <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={d} />
      </svg>
    </span>
  )
}

const ICON_MACHINE = 'M3 4.5h14v9H3zM7 16.5h6M10 13.5v3'
const ICON_KEY = 'M12.5 3.5a4 4 0 1 1-3.2 6.4L4 15.2V17h2.5v-1.5H8V14l1.6-1.6A4 4 0 0 1 12.5 3.5zM13.5 6.5h.01'
const ICON_HARNESS = 'M7 3.5v4M13 3.5v4M5 7.5h10v2.5a5 5 0 0 1-10 0zM10 15v2.5'
const ICON_CLOUD = 'M6 15.5h8a3.5 3.5 0 0 0 .4-6.98A5 5 0 0 0 4.7 9.6 3 3 0 0 0 6 15.5z'

function RunCard({ icon, title, children, badge, hosted }: { icon: string; title: string; children: ReactNode; badge?: ReactNode; hosted?: boolean }) {
  return (
    <div className={`lv3-card v2-runcard${hosted ? ' v2-runcard--hosted' : ''}`}>
      <div className="v2-runcard__top">
        <Icon d={icon} />
        {badge}
      </div>
      <h3 className="v2-runcard__h">{title}</h3>
      {children}
    </div>
  )
}

export function LandingPage() {
  const s = useSession()
  const navigate = useNavigate()
  const [open, setOpen] = useState(0)
  const wantApp = useRef(false)
  const connected = s.status === 'signed-in' && !!s.wallet
  const email = s.user?.email ?? s.me?.displayName ?? ''

  // Smooth anchor scroll and the sticky-header offset live on <html>, as in the design.
  useEffect(() => {
    document.documentElement.classList.add('lv3-root')
    return () => document.documentElement.classList.remove('lv3-root')
  }, [])

  // Login with DFL: redirect to DFL, come back signed in, then land on /agents.
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

  // Logged out: exactly one element carries data-testid="login-dfl" (the header CTA); the others are "login-dfl-secondary".
  // Logged in: the header CTA shows the email in data-testid="nav-user-email".
  const cta = (testId: string, className: string, header = false) => (
    <button
      type="button"
      className={`${className}${connected ? ` lv3-cta--connected${header ? ' v2-signedin' : ''}` : ''}`}
      onClick={start}
      data-testid={connected ? testId : header ? 'login-dfl' : 'login-dfl-secondary'}
    >
      {connected ? header ? <span data-testid="nav-user-email">{email}</span> : 'Open my agents' : header ? 'Sign in' : 'Start evaluating'}
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
          <div className="v2-header-right">
            <nav className="v2-navlinks" aria-label="Page sections">
              <a href="#why">Why TestMyAgent</a>
              <a href="#how">How it works</a>
              <a href="#versions">Improve</a>
              <a href="#cost">Optimize</a>
              <a href="#faq">FAQ</a>
            </nav>
            {cta('landing-header-cta', 'lv3-btn lv3-btn--nav', true)}
          </div>
        </div>
      </header>

      <main id="top">
        <section className="lv3-hero">
          <div className="lv3-hero__copy">
            <Eyebrow>AI agent evaluation infrastructure · Early access · Free</Eyebrow>
            <h1 className="lv3-h1">
              Your agents change. <span className="lv3-muted">Know if they're getting better.</span>
            </h1>
            <div className="v2-hero-lines">
              <p>Test your AI agents on real tasks, compare each version and each model, and find out where you can spend less.</p>
              <p>Run them on your own machine with your own keys. TestMyAgent keeps the grades, the results and the history in one place.</p>
            </div>
            <div className="v2-hero-actions">
              <div className="v2-hero-ctas">
                <div className="v2-cta-col">
                  {cta('landing-hero-cta', 'lv3-btn lv3-btn--hero')}
                  {!connected && <span className="v2-account">Uses your DevFellowship account</span>}
                </div>
                <a className="lv3-btn lv3-btn--hero lv3-btn--secondary" href="#how">
                  How it works
                </a>
              </div>
              <ul className="v2-chips" aria-label="What you keep">
                {['Your machine or VPS', 'Your own keys', 'Hidden tests on real tasks'].map((c) => (
                  <li className="v2-chip" key={c}>
                    <Check />
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="lv3-hero__grid">
            <div className="lv3-card v2-agents">
              <div className="v2-cardhead">
                <span className="v2-cardhead__title">Your agents</span>
                <SampleData />
              </div>
              <div className="v2-scroll" tabIndex={0} role="region" aria-label="Your agents (sample data)">
                <div className="v2-table">
                  <div className="v2-agents-cols lv3-agents__cols--head">
                    <span>#</span>
                    <span>Agent</span>
                    <span>Version</span>
                    <span>Model</span>
                    <span className="lv3-right">Score</span>
                    <span className="lv3-right">Cost/task</span>
                  </div>
                  {AGENTS.map((a, i) => (
                    <div className="v2-agents-cols lv3-agents__row" key={a.name}>
                      <span className={`lv3-rank${i < 3 ? ' lv3-rank--top' : ''}`}>{pad(i)}</span>
                      <div className="lv3-agent">
                        <AgentAvatar id={a.name} name={a.name} size={28} testId="landing-agent-avatar" />
                        <span className="lv3-agent__name lv3-ellipsis">{a.name}</span>
                      </div>
                      <span className="v2-version">{a.version}</span>
                      <span className="lv3-model">
                        <ModelAvatar label={a.model} size={18} />
                        <span className="lv3-ellipsis">{a.model}</span>
                      </span>
                      <span className="lv3-score">{a.score}</span>
                      <span className="v2-cost">{a.cost}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="v2-cardfoot">
                <span>Sample data. Your agents show up here after your first upload.</span>
              </div>
            </div>

            <div className="lv3-card v2-compare">
              <div className="v2-cardhead">
                <span className="v2-cardhead__title">Model comparison</span>
                <span className="v2-badges">
                  <SelfDeclared />
                  <SampleData />
                </span>
              </div>
              <div className="v2-compare__intro">
                <span className="v2-compare__title">UI Auditor on “UI vs design audit”</span>
                <span className="v2-compare__line">Same agent files. Only the model changes.</span>
              </div>
              <div className="v2-compare-cols lv3-agents__cols--head">
                <span>Model</span>
                <span>Passes</span>
                <span className="lv3-right">Score</span>
                <span className="lv3-right">Cost</span>
              </div>
              {COMPARE.map((m) => (
                <div className={`v2-compare-cols v2-compare__row${m.best ? ' v2-compare__row--best' : ''}`} key={m.model}>
                  <span className="v2-modelcell">
                    <ModelAvatar label={m.model} size={18} />
                    <span className="v2-modelcell__name">{m.model}</span>
                    {m.best && (
                      <Badge tone="success" dot>
                        Good enough
                      </Badge>
                    )}
                  </span>
                  <span>
                    <Badge tone={m.pass ? 'success' : 'danger'}>{m.passes}</Badge>
                  </span>
                  <span className="lv3-score">{m.score}</span>
                  <span className="v2-cost">
                    {m.cost} <span className="lv3-muted">per run</span>
                  </span>
                </div>
              ))}
              <div className="v2-cardfoot">
                <span className="lv3-label">Cheapest passing model</span>
                <span className="v2-best">
                  <ModelAvatar label="DeepSeek V4.1 Flash" size={16} />
                  DeepSeek V4.1 Flash
                </span>
              </div>
            </div>
          </div>
        </section>

        <section id="why" className="lv3-section">
          <div className="lv3-block">
            <div className="lv3-head v2-head--wide">
              <Eyebrow>The challenge</Eyebrow>
              <h2 className="lv3-h2">Every change is an experiment. Are you measuring it?</h2>
              <p className="v2-lead">
                A new model. An updated prompt. Different tools. A tweaked harness. Any of them can make your agent better, break something that used to
                work, or quietly raise your bill. Without the same tests run the same way, you can't tell which one happened.
              </p>
            </div>
            <div className="v2-grid3">
              {WHY.map(([h, p], i) => (
                <div className="lv3-card v2-qcard" key={h}>
                  <span className="v2-qcard__n">{pad(i)}</span>
                  <h3 className="v2-qcard__h">{h}</h3>
                  <p className="v2-qcard__p">{p}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="lv3-section">
          <div className="lv3-block">
            <div className="lv3-head">
              <Eyebrow>Test · How it works</Eyebrow>
              <h2 className="lv3-h2">From your agent folder to a graded run in three steps.</h2>
            </div>
            <div className="lv3-steps">
              <div className="lv3-card lv3-step">
                <div className="lv3-step__top">
                  <span className="lv3-step__n">01</span>
                  <h3 className="lv3-step__h3">Choose tasks and an agent</h3>
                  <p className="lv3-step__p">
                    Pick public tasks tagged by tool, or write your own from real work and keep them private. Add your agent: a folder with{' '}
                    <Cmd>AGENTS.md</Cmd>, <Cmd>CLAUDE.md</Cmd> and your skills, from GitHub or local.
                  </p>
                </div>
                <div className="lv3-demo">
                  {STEP_TASKS.map(([name, tag, on]) => (
                    <div className="lv3-picktask" key={name}>
                      <span className={`lv3-check${on ? ' lv3-check--on' : ''}`}>
                        <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true" style={{ opacity: on ? 1 : 0 }}>
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
                      Free <span className="lv3-muted">· your key</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="lv3-card lv3-step">
                <div className="lv3-step__top">
                  <span className="lv3-step__n">02</span>
                  <h3 className="lv3-step__h3">Run it with your own keys</h3>
                  <p className="lv3-step__p">
                    Run <Cmd>tma run</Cmd> on your machine or VPS with your OpenRouter or opencode go key. Already have a harness? <Cmd>tma workspace</Cmd> and{' '}
                    <Cmd>tma grade</Cmd> let you keep it.{COPY.step02Extra}
                  </p>
                </div>
                <div className="lv3-demo">
                  <div className="lv3-demo__row">
                    <span className="lv3-mono12 lv3-ellipsis">acme/repo-researcher</span>
                    <span className="lv3-private">local</span>
                  </div>
                  <div className="lv3-demo__row lv3-demo__row--line">
                    <span className="lv3-muted">Version</span>
                    <span className="lv3-mono12">v4</span>
                  </div>
                  <div className="lv3-demo__row lv3-demo__row--line">
                    <span className="lv3-muted">Model</span>
                    <span className="lv3-model lv3-model--sm">
                      <ModelAvatar label="DeepSeek V4.1 Flash" size={16} />
                      DeepSeek V4.1 Flash
                    </span>
                  </div>
                  <div className="lv3-demo__row lv3-demo__row--line lv3-demo__row--start">
                    <Badge tone="success" dot>
                      Ready
                    </Badge>
                    <span className="lv3-mono11 lv3-muted">via opencode go</span>
                  </div>
                </div>
              </div>

              <div className="lv3-card lv3-step">
                <div className="lv3-step__top">
                  <span className="lv3-step__n">03</span>
                  <h3 className="lv3-step__h3">Grade it and decide</h3>
                  <p className="lv3-step__p">
                    Hidden tests grade the run in a sandbox, and you see which checks passed. <Cmd>tma upload</Cmd> sends the score, time, tokens and cost to
                    TestMyAgent, so you can pick the next change.
                  </p>
                </div>
                <div className="lv3-demo">
                  {STAGES.map(([name, detail], i) => (
                    <div className={`lv3-stage${i === STAGES.length - 1 ? ' lv3-stage--last' : ''}`} key={name}>
                      <span className="lv3-stage__name">
                        <span className="lv3-stage__dot" aria-hidden="true">
                          ✓
                        </span>
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

        <section id="versions" className="lv3-section">
          <div className="lv3-block">
            <div className="lv3-head v2-head--wide">
              <Eyebrow>Improve · Agent versions</Eyebrow>
              <h2 className="lv3-h2">Change one thing. Rerun the same tasks.</h2>
              <p className="v2-lead">
                A GitHub agent is pinned to a commit. Push a new prompt or skill, pin the new commit and run the same tasks again. The agent page keeps your
                result history, so when a score drops you can see when it happened and what you changed.
              </p>
            </div>
            <div className="lv3-facts">
              <div className="lv3-fact">
                <div className="lv3-fact__pills">
                  <Badge tone="neutral">Pinned</Badge>
                </div>
                <span className="lv3-fact__text">A GitHub run names the agent commit and the model. A local run names the model, the harness and the runner version.</span>
              </div>
              <div className="lv3-fact">
                <div className="lv3-fact__pills">
                  <Badge tone="success" dot>
                    Hidden tests
                  </Badge>
                </div>
                <span className="lv3-fact__text">Your agent never sees the checks that grade it.</span>
              </div>
              <div className="lv3-fact">
                <div className="lv3-fact__pills">
                  <SelfDeclared />
                </div>
                <span className="lv3-fact__text">A result from your machine is labeled as yours. TestMyAgent doesn't certify it.</span>
              </div>
            </div>
            <div className="v2-ba-wrap">
              <div>
                <SampleData />
              </div>
              <div className="v2-beforeafter">
                {VERSIONS.map((v, idx) => (
                  <BeforeAfterCell key={v.version} arrow={idx > 0}>
                    <div className={`lv3-card lv3-taskcard${v.pass ? ' v2-taskcard--after' : ''}`}>
                      <div className="lv3-taskcard__top">
                        <span className="v2-taskmeta">
                          <span className="lv3-taskcard__name">Repo research</span>
                          <span className="tma-tag lv3-mono">{v.version}</span>
                        </span>
                        <Badge tone={v.pass ? 'success' : 'danger'}>{v.pass ? 'PASS' : 'FAIL'}</Badge>
                      </div>
                      <div className="lv3-cells" aria-hidden="true">
                        {Array.from({ length: v.total }, (_, i) => (
                          <span key={i} className={i < v.passed ? 'lv3-cell lv3-cell--pass' : 'lv3-cell lv3-cell--fail'} />
                        ))}
                      </div>
                      <div className="lv3-taskcard__foot">
                        <span className="lv3-mono12 lv3-muted">{`${v.passed} / ${v.total} checks`}</span>
                      </div>
                    </div>
                  </BeforeAfterCell>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="cost" className="lv3-section">
          <div className="lv3-block">
            <div className="v2-cost-grid">
              <div className="lv3-rank__copy">
                <Eyebrow>Optimize · Models and cost</Eyebrow>
                <h2 className="lv3-h2">Same agent, cheaper model. Does it still pass?</h2>
                <p className="lv3-rank__lead">
                  Keep the agent files as they are and swap only the model. Run each model on the same tasks a few times. If the cheap one clears your bar, move
                  the job to it and keep the difference.
                </p>
                <div className="lv3-rank__list">
                  <div>
                    <span>Cost per run</span>
                    <span className="lv3-muted">from your model route</span>
                  </div>
                  <div>
                    <span>Your bar</span>
                    <span className="lv3-muted">you decide which pass rate is good enough</span>
                  </div>
                  <div>
                    <span>Private tasks</span>
                    <span className="lv3-muted">only you see them</span>
                  </div>
                </div>
              </div>

              <div className="lv3-card">
                <div className="lv3-ranked">
                  <span className="lv3-label lv3-ranked__label">Ranked on</span>
                  <span className="lv3-ranked__chip">
                    UI vs design audit<span>PRIVATE</span>
                  </span>
                  <span className="lv3-ranked__chip">
                    HTML report from data<span>PRIVATE</span>
                  </span>
                  <span className="v2-push">
                    <SampleData />
                  </span>
                </div>
                <div className="v2-scroll" tabIndex={0} role="region" aria-label="Models ranked on your tasks (sample data)">
                  <div className="v2-ranked-table">
                    <div className="v2-ranked-cols v2-ranked-head">
                      <span>#</span>
                      <span>Model</span>
                      <span>Tasks</span>
                      <span className="lv3-right">Cost/task</span>
                      <span className="lv3-right">Score</span>
                    </div>
                    {RANKED.map((m, i) => {
                      const has = m.score !== ''
                      return (
                        <div className="v2-ranked-cols v2-ranked-row" key={m.model}>
                          <span className={`lv3-rank${has && i < 2 ? ' lv3-rank--top' : ''}`}>{has ? pad(i) : '—'}</span>
                          <span className="lv3-model">
                            <ModelAvatar label={m.model} size={18} />
                            <span className="lv3-ellipsis">{m.model}</span>
                          </span>
                          <div className="lv3-cov">
                            <div className="lv3-cov__dots" aria-hidden="true">
                              {[0, 1].map((d) => (
                                <span key={d} className={d < m.covered ? 'lv3-cov__dot lv3-cov__dot--on' : 'lv3-cov__dot'} />
                              ))}
                            </div>
                            <span className="lv3-mono11 lv3-muted">{`${m.covered} / 2`}</span>
                          </div>
                          {has ? (
                            <>
                              <span className="v2-cost">{m.cost}</span>
                              <span className="lv3-rankrow__score v2-num">{m.score}</span>
                            </>
                          ) : (
                            <span className="lv3-runbtn">
                              Free · <span className="lv3-mono">local runner</span>
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="lv3-ranked__foot">Score is the mean on the selected tasks. Cost is the sum of the runs.</div>
              </div>
            </div>

            <div className="v2-case">
              <div className="v2-case__body">
                <Eyebrow>Case</Eyebrow>
                <h3 className="v2-case__title">How we use it ourselves</h3>
                <p className="v2-case__text">
                  We turned three of our own daily jobs into tasks: repo research, an HTML report from data, and a UI vs design audit. DeepSeek V4.1 Flash
                  passed all 15 runs, five per job, at about three cents a run. So we moved our UI design audit to it.
                </p>
              </div>
              <div className="v2-case__stats">
                <div className="v2-stat">
                  <span className="v2-stat__n">15/15</span>
                  <span className="v2-stat__k">Runs passed</span>
                </div>
                <div className="v2-stat">
                  <span className="v2-stat__n">~$0.03</span>
                  <span className="v2-stat__k">Per run</span>
                </div>
                <div className="v2-stat">
                  <span className="v2-stat__n">3 × 5</span>
                  <span className="v2-stat__k">Jobs × runs</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="run" className="lv3-section">
          <div className="lv3-block">
            <div className="lv3-head v2-head--wide">
              <Eyebrow>Your infrastructure, your control</Eyebrow>
              <h2 className="lv3-h2">Run anywhere. Evaluate in one place.</h2>
              <p className="v2-lead">Keep the agents, models and machines you already have. TestMyAgent doesn't ask you to move your agents to a new runtime.</p>
            </div>
            <div className="v2-grid4">
              <RunCard icon={ICON_MACHINE} title="Your machine or VPS">
                <p className="v2-runcard__p">
                  <Cmd>tma</Cmd> runs your agent and the hidden tests in Docker on your own box. You need git, Node 22 and Docker.
                </p>
              </RunCard>
              <RunCard icon={ICON_KEY} title="Your own keys">
                <p className="v2-runcard__p">Your OpenRouter or opencode go key stays on your machine. TestMyAgent never sees it.</p>
              </RunCard>
              <RunCard icon={ICON_HARNESS} title="Your own harness">
                <p className="v2-runcard__p">
                  Keep the harness you have. <Cmd>tma workspace</Cmd> hands it the task, and <Cmd>tma grade</Cmd> scores what it did. Your agent can also add
                  agents, tasks and results through our MCP tools.
                </p>
              </RunCard>
              <RunCard
                icon={ICON_CLOUD}
                title="Hosted LLM Infra"
                hosted
                badge={
                  COPY.hostedBadge ? (
                    <Badge tone="warning" dot>
                      Early access
                    </Badge>
                  ) : undefined
                }
              >
                <p className="v2-runcard__p">
                  Rather not run anything yourself? Hosted LLM Infra runs your agent and the model on our servers, with the same hidden tests.
                </p>
                {HOSTED_RUNS_ENABLED ? (
                  <button type="button" className="v2-btn-secondary" onClick={start} data-testid="landing-hosted-start">
                    Start a hosted run
                  </button>
                ) : (
                  <a className="v2-btn-secondary" href={REQUEST_ACCESS_HREF} data-testid="landing-request-access">
                    Request access
                  </a>
                )}
              </RunCard>
            </div>
            <div className="v2-closing">
              <span className="v2-closing__text">Your machine runs the agents. TestMyAgent tells you how well they did.</span>
              <a className="v2-link" href={CLI_GUIDE_HREF} target="_blank" rel="noreferrer">
                Read the CLI guide <span aria-hidden="true">→</span>
              </a>
            </div>
          </div>
        </section>

        <section id="next" className="lv3-section">
          <div className="lv3-block">
            <div className="lv3-head v2-head--wide">
              <Eyebrow>Where we're headed</Eyebrow>
              <h2 className="lv3-h2">Make evaluations part of how you ship agents.</h2>
              <p className="v2-lead">Today you run an evaluation when you decide to. We want it to run on every change.</p>
            </div>
            <div className="v2-grid3">
              {NEXT.map(([h, p]) => (
                <div className="lv3-card v2-plan" key={h}>
                  <div>
                    <Badge tone="warning" dot>
                      Planned
                    </Badge>
                  </div>
                  <h3 className="v2-plan__h">{h}</h3>
                  <p className="v2-plan__p">{p}</p>
                </div>
              ))}
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
                  <button
                    type="button"
                    className="lv3-faq__q"
                    id={`faq-q-${i}`}
                    aria-expanded={open === i}
                    aria-controls={`faq-a-${i}`}
                    onClick={() => setOpen(open === i ? -1 : i)}
                  >
                    <span>{q}</span>
                    <span className="lv3-faq__sign" aria-hidden="true">
                      {open === i ? '−' : '+'}
                    </span>
                  </button>
                  {open === i && (
                    <p className="lv3-faq__a" id={`faq-a-${i}`} role="region" aria-labelledby={`faq-q-${i}`}>
                      {a}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="start" className="lv3-section">
          <div className="lv3-start">
            <h2 className="lv3-start__h2">Stop guessing. Start measuring.</h2>
            <p className="lv3-start__lead">
              Sign in, add an agent and upload your first result from the tma CLI. Setup takes a few minutes. The model takes as long as the task needs.
            </p>
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
          <span>Your agents, measured on your own work.</span>
        </div>
      </footer>
    </div>
  )
}

/** One cell of the before/after pair; the cells after the first get the arrow in front. */
function BeforeAfterCell({ arrow, children }: { arrow: boolean; children: ReactNode }) {
  return (
    <>
      {arrow && (
        <div className="v2-arrow" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 10h12M11 5l5 5-5 5" />
          </svg>
        </div>
      )}
      {children}
    </>
  )
}
