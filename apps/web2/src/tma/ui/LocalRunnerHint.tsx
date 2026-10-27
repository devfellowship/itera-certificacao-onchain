/**
 * The local-runner hint (plan TMA L15b). web2 = ingested only for now (Tainan TG 23889): a Login with DFL
 * session gets no hosted run, so every surface that started one shows this card instead.
 * With a LOCAL agent: its own `tma` steps. Else: the generic steps and a link to "New local agent".
 * The `<pre>` lines scroll inside themselves, so the card fits a 375 px screen.
 */
import { ButtonLink } from './Button'
import { Card } from './Card'
import { isLocalAgent } from './Origin'
import { TmaCliSteps, type TmaCliAgent } from './TmaCliSteps'

export const LOCAL_RUNNER_HINT_ID = 'local-runner'
export const LOCAL_RUNNER_HINT_HASH = `#${LOCAL_RUNNER_HINT_ID}`
export const NEW_LOCAL_AGENT_PATH = '/agents/new?source=local'
export const LOCAL_RUNNER_HINT_TITLE = 'Run it on your machine'
export const LOCAL_RUNNER_HINT_TEXT =
  'Hosted runs are not available for a DFL login for now. Run the task with the tma local runner and upload the result. It shows as self-declared, visible only to you.'

/** An id of the `8-4-4-4-12` shape (a catalog id; test fixtures are not always hex). A slug never has this shape. */
const UUID_RE = /^[0-9a-z]{8}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{12}$/i

/**
 * The first task of a `?tasks=a,b` selection as a slug: resolved through the catalog when one is given,
 * else the entry itself when it is not a UUID (a task profile links by slug). Null when nothing fits.
 */
export function firstTaskSlugOf(param: string | null | undefined, tasks?: ReadonlyArray<{ id: string; slug?: string | null }> | null): string | null {
  const first = (param ?? '').split(',').map((s) => s.trim()).find(Boolean)
  if (!first) return null
  const found = tasks?.find((t) => t.id === first || t.slug === first)
  if (found) return found.slug || null
  return UUID_RE.test(first) ? null : first
}

export interface LocalRunnerHintProps {
  /** The agent in view, when one is known. Only a local agent (`connector: 'local'`) fills the commands. */
  agent?: (TmaCliAgent & { connector?: unknown }) | null
  /** The task in view, when one is known: goes into `tma run --task <slug>`. */
  taskSlug?: string | null
  className?: string
  /** Element id of the card, so a link on the same page can point to it. Default: `local-runner`. */
  id?: string
}

export function LocalRunnerHint({ agent, taskSlug, className, id = LOCAL_RUNNER_HINT_ID }: LocalRunnerHintProps) {
  const local = isLocalAgent(agent) ? agent : null
  return (
    <Card id={id} className={['tma-local-hint', className].filter(Boolean).join(' ')} data-testid="local-runner-hint" data-agent={local ? 'local' : 'generic'}>
      <span className="tma-local-hint__title">{LOCAL_RUNNER_HINT_TITLE}</span>
      <span className="tma-local-hint__text">{LOCAL_RUNNER_HINT_TEXT}</span>
      <TmaCliSteps agent={local} taskSlug={taskSlug} />
      {!local && (
        <div className="tma-local-hint__actions">
          <ButtonLink variant="primary" size={36} href={NEW_LOCAL_AGENT_PATH} data-testid="local-runner-hint-new-agent">
            New local agent
          </ButtonLink>
        </div>
      )}
    </Card>
  )
}
