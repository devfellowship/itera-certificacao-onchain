/**
 * Copy commands of the studio (plan 20261112-tma-c5-studio-area-web2, C5-T3; umbrella ADR-5, ADR-30, ADR-31).
 * Studio v1 is read only: a test run happens on the user's host with the `tma eval` kit, then `tma eval upload`
 * sends the numbers. These builders write the exact commands of services/runner/src/cli/commands/eval.ts:
 *
 *   tma eval case   --case <case.json> --dest <dir> [--recorded <patch>]
 *   tma eval run    --case <case dir> --variant <variant.json> [--repeat 1-10]
 *   tma eval grade  --case <case dir>                            (trace_review: grades the recorded output)
 *   tma eval upload --case <case dir> --variant-dir <dir> --agent <agent id>
 *
 * No other flag is used. The local files that only the user has (the case manifest from the eval repo, the
 * variant file, the recorded patch) are placeholders in angle brackets, as the CLI's own `next:` lines write them.
 * The variant folder is <case dir>/runs/<variant sha256[:12]> (CASE_RUNS_DIR), and runs/recorded for a
 * trace_review case. For the base agent unchanged (change_kind none) the uploaded digest is the sha256 of the
 * empty diff, not the folder name, so that folder stays a placeholder.
 */
export type CommandCase = { caseKey: string; useCaseKey: string; mode: string }
export type CommandVariant = { label: string; changeKind: string; variantSha256: string } | null

export const AGENT_PLACEHOLDER = '<agent id>'
export const VARIANT_FILE_PLACEHOLDER = '<variant.json>'
export const DEFAULT_REPEAT = 3

/** The case folder that `tma eval case --dest` writes, relative to the user's working directory. */
export const caseDir = (caseKey: string) => `eval/${caseKey}`

/** The manifest path in the eval repo layout: cases/<type>/<subtype>/<key>/case.json. */
export const caseManifest = (c: CommandCase) => `cases/${c.useCaseKey}/${c.caseKey}/case.json`

function variantFolder(c: CommandCase, v: CommandVariant): string {
  if (c.mode === 'trace_review') return `${caseDir(c.caseKey)}/runs/recorded`
  if (!v || v.changeKind === 'none') return `${caseDir(c.caseKey)}/runs/<variant folder>`
  return `${caseDir(c.caseKey)}/runs/${v.variantSha256.slice(0, 12)}`
}

/** The commands of one case: build the case folder, run (or grade) the variant, upload its runs. */
export function caseCommands(c: CommandCase, opts: { agentId?: string | null; variant?: CommandVariant; repeat?: number } = {}): string[] {
  const dir = caseDir(c.caseKey)
  const agent = opts.agentId || AGENT_PLACEHOLDER
  const repeat = opts.repeat ?? DEFAULT_REPEAT
  const lines: string[] = []
  if (c.mode === 'trace_review') {
    lines.push(`tma eval case --case ${caseManifest(c)} --dest ${dir} --recorded <recorded.patch>`)
    lines.push(`tma eval grade --case ${dir}`)
  } else {
    lines.push(`tma eval case --case ${caseManifest(c)} --dest ${dir}`)
    lines.push(`tma eval run --case ${dir} --variant ${VARIANT_FILE_PLACEHOLDER} --repeat ${repeat}`)
  }
  lines.push(`tma eval upload --case ${dir} --variant-dir ${variantFolder(c, opts.variant ?? null)} --agent ${agent}`)
  return lines
}

/** The script of an experiment: one base agent, one variant, a dataset of cases. */
export function experimentScript(input: { cases: CommandCase[]; agentId?: string | null; variant?: CommandVariant; repeat?: number }): string {
  const v = input.variant ?? null
  const head = v
    ? `# variant: ${v.label} (${v.changeKind}${v.changeKind === 'none' ? ', the base agent unchanged' : `, ${v.variantSha256.slice(0, 12)}`}); ${VARIANT_FILE_PLACEHOLDER} is its tma-variant/1 file`
    : `# variant: your tma-variant/1 file (${VARIANT_FILE_PLACEHOLDER})`
  if (!input.cases.length) return `${head}\n# pick at least one test case for the dataset`
  const blocks = input.cases.map((c) => [`# case ${c.caseKey} (${c.useCaseKey}, ${c.mode})`, ...caseCommands(c, { agentId: input.agentId, variant: v, repeat: input.repeat })].join('\n'))
  return [head, ...blocks].join('\n\n')
}
