import { useState } from 'react'
import {
  Avatar,
  Badge,
  Breadcrumb,
  Button,
  Card,
  CardHeader,
  Checkbox,
  Chip,
  CodePanel,
  EventLogRow,
  Field,
  Input,
  KeyValue,
  Logo,
  Modal,
  RadioCard,
  RemovableChip,
  SearchInput,
  Segmented,
  Select,
  STATUS_WORDS,
  StatusChip,
  Stepper,
  Table,
  TableEmpty,
  Tabs,
  TagPill,
  Textarea,
} from '../tma/ui'
import { AccountMenu } from '../tma/nav/AppNav'

const SWATCHES = [
  ['Background', '--tma-bg'],
  ['Surface', '--tma-surface'],
  ['Surface raised', '--tma-surface-raised'],
  ['Surface code', '--tma-surface-code'],
  ['Line', '--tma-line'],
  ['Line strong', '--tma-line-strong'],
  ['Text', '--tma-text'],
  ['Text muted', '--tma-text-muted'],
  ['Primary', '--tma-primary'],
  ['Primary hover · facet', '--tma-primary-hover'],
  ['Primary soft', '--tma-primary-soft'],
  ['On primary', '--tma-on-primary'],
]

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card data-testid="primitive-section">
      <CardHeader title={title} />
      <div className="tma-card__body" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        {children}
      </div>
    </Card>
  )
}

/** Dev route /design/primitives: renders every primitive once (plan P0 exit criteria). */
export function DesignPrimitivesPage() {
  const [model, setModel] = useState<string | null>('anthropic/claude-sonnet-4.5')
  const [release, setRelease] = useState<string | null>('2025-09-29')
  const [checked, setChecked] = useState(true)
  const [vis, setVis] = useState<'listed' | 'private'>('listed')
  const [tab, setTab] = useState<'all' | 'mine'>('all')
  const [seg, setSeg] = useState<'all' | 'public' | 'mine'>('all')
  const [chip, setChip] = useState(true)
  const [modal, setModal] = useState(false)
  return (
    <main className="tma-page" data-testid="design-primitives">
      <Breadcrumb items={[{ label: 'Design', to: '/design/primitives' }, { label: 'Primitives' }]} />
      <h1 className="tma-h1">Primitives</h1>

      <Section title="Tokens">
        {SWATCHES.map(([name, v]) => (
          <div key={v} style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 120 }}>
            <span style={{ height: 40, borderRadius: 8, background: `var(${v})`, border: '1px solid var(--tma-line)' }} />
            <span className="tma-body-sm">{name}</span>
            <span className="tma-label">{v}</span>
          </div>
        ))}
      </Section>

      <Section title="Buttons">
        <Button variant="primary">Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="inverse">Inverse</Button>
        <Button variant="text">Text button</Button>
        <Button variant="muted">Muted button</Button>
        <Button variant="primary" size={36}>
          h36
        </Button>
        <Button variant="secondary" size={32}>
          h32
        </Button>
        <Button variant="secondary-dark" size={30}>
          Run · 0.00092 SOL
        </Button>
        <Button variant="primary" disabled>
          Disabled
        </Button>
      </Section>

      <Section title="Inputs">
        <div style={{ width: 280 }}>
          <Field label="Name" hint="Up to 60 characters.">
            <Input placeholder="settlewise" />
          </Field>
        </div>
        <SearchInput placeholder="Search agents" />
        <div style={{ width: 280 }}>
          <Field label="Model">
            <Select
              value={model}
              onChange={setModel}
              options={[
                { value: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', meta: 'anthropic/claude-sonnet-4.5' },
                { value: 'openai/gpt-5', label: 'GPT-5', meta: 'openai/gpt-5' },
              ]}
            />
          </Field>
        </div>
        <div style={{ width: 200 }}>
          <Field label="Release">
            <Select value={release} onChange={setRelease} menuCompact options={[{ value: '2025-09-29', label: '2025-09-29', note: 'latest' }, { value: '2025-05-14', label: '2025-05-14' }]} />
          </Field>
        </div>
        <div style={{ width: 360 }}>
          <Textarea mono placeholder="Instruction (Markdown)" />
        </div>
        <Checkbox checked={checked} onChange={setChecked} label="Webhook ledger" />
        <div style={{ display: 'flex', gap: 12, width: 640 }}>
          <RadioCard checked={vis === 'listed'} onSelect={() => setVis('listed')} title="Listed" description="Appears in Agents after a verified evaluation." />
          <RadioCard checked={vis === 'private'} onSelect={() => setVis('private')} title="Private" description="Visible only to you." />
        </div>
      </Section>

      <Section title="Status chips (every run / evaluation state)">
        {Object.keys(STATUS_WORDS).map((w) => (
          <StatusChip key={w} status={w} />
        ))}
        <Badge tone="success" dot>
          Verified
        </Badge>
        <Badge tone="warning" dot>
          Pending
        </Badge>
        <Badge tone="danger" dot>
          FAIL
        </Badge>
        <Badge tone="neutral" dot>
          Draft
        </Badge>
      </Section>

      <Section title="Pills and chips">
        <TagPill>vitest</TagPill>
        <TagPill large>idempotency</TagPill>
        <TagPill count={4}>webhooks</TagPill>
        <Chip selected={chip} onToggle={() => setChip(!chip)} count={3}>
          typescript
        </Chip>
        <Chip selected={false} onToggle={() => undefined} count={2}>
          postgres
        </Chip>
        <RemovableChip onRemove={() => undefined}>Webhook ledger</RemovableChip>
      </Section>

      <Section title="Navigation">
        <div style={{ width: 400 }}>
          <Tabs items={[{ id: 'all', label: 'All', count: 12 }, { id: 'mine', label: 'Mine', count: 2 }]} value={tab} onChange={setTab} />
        </div>
        <Segmented items={[{ id: 'all', label: 'All', count: 9 }, { id: 'public', label: 'Public', count: 9 }, { id: 'mine', label: 'My tasks', count: 0 }]} value={seg} onChange={setSeg} />
        <Stepper steps={['Connect repo', 'Select tasks', 'Run']} current={1} />
      </Section>

      <Section title="Avatars and logo">
        {([80, 72, 44, 40, 28] as const).map((s) => (
          <Avatar key={s} name="Bruno Lima" size={s} />
        ))}
        <Logo width={47} height={22} />
        <Logo variant="symbol" width={32} height={32} />
        <Logo tone="cream" width={60} height={28} />
        <Logo variant="symbol" solid width={16} height={16} />
      </Section>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <Card>
          <CardHeader title="Summary" meta="webhook-ledger@1" />
          <KeyValue
            rows={[
              { key: 'Agent', value: 'settlewise' },
              { key: 'Tasks', value: '3' },
              { key: 'Fee', value: 'US$0.10 × 3' },
              { key: 'Record', value: <StatusChip status="confirmed" dot /> },
            ]}
          />
        </Card>
        <CodePanel title="manifest.json" meta="itera-evidence/v1">
          {'{\n  '}
          <span className="k">"outcome"</span>
          {': '}
          <span className="s">"PASS"</span>
          {',\n  '}
          <span className="k">"is_simulated"</span>
          {': '}
          <span className="b">false</span>
          {',\n  '}
          <span className="k">"cost"</span>
          {': '}
          <span className="n">null</span>
          {'\n}'}
        </CodePanel>
      </div>

      <div className="tma-code">
        <div className="tma-code__header">
          <span className="tma-label">Event log</span>
          <span className="tma-label tma-subtle">UTC</span>
        </div>
        <EventLogRow time="00:00" tone="ok" label="Payment confirmed" detail="0.00092 SOL" />
        <EventLogRow time="00:04" tone="live" label="Agent running" detail="1 of 3 returned" />
        <EventLogRow time="00:41" tone="bad" label="Task timed out" detail="webhook-ledger" />
        <EventLogRow time="—" tone="idle" label="Attestation" detail="waiting" />
      </div>

      <Table
        testId="primitives-table"
        columns={[
          { key: 'task', header: 'Task', width: 'minmax(0,2fr)', render: (r: { task: string; outcome: string; score: number }) => r.task },
          { key: 'outcome', header: 'Outcome', width: '120px', render: (r) => <StatusChip status={r.outcome} /> },
          { key: 'score', header: 'Score', width: '80px', align: 'right', render: (r) => r.score.toFixed(1) },
        ]}
        rows={[
          { task: 'Duplicate settlement webhook', outcome: 'PASS', score: 92.5 },
          { task: 'Idempotent refund', outcome: 'FAIL', score: 41 },
        ]}
        rowKey={(r) => r.task}
        onRowClick={() => undefined}
      />
      <Table columns={[{ key: 'x', header: 'Evaluation', width: '1fr', render: () => null }]} rows={[]} rowKey={() => 'x'} empty={<TableEmpty title="No evaluations yet"><Button variant="text">Choose tasks</Button></TableEmpty>} />

      <Section title="Modal and account menu">
        <Button variant="secondary" onClick={() => setModal(true)}>
          Open modal
        </Button>
        <AccountMenu />
      </Section>
      <Modal open={modal} onClose={() => setModal(false)} title="Filter tasks" width={560} footer={<Button variant="primary" onClick={() => setModal(false)}>Apply</Button>}>
        <p className="tma-muted">Modal body.</p>
      </Modal>
    </main>
  )
}
