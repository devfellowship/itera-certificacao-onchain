import { useMemo } from 'react'
import type { Model } from '../../lib/api'
import { Button, Card, Field, ModelLabel, Select, type SelectOption } from '../../tma/ui'
import type { Load } from './useLoad'
import { describeError } from './errors'

const fmtDate = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

export function releaseOptions(model: Model | undefined): SelectOption[] {
  return (model?.releases ?? []).map((r, i) => {
    const date = fmtDate(r.releasedAt)
    const note = [r.isLatest || i === 0 ? 'latest' : null, date || null].filter(Boolean).join(' · ')
    return { value: r.id, label: <span className="ta-mono13">{r.id}</span>, note: note || undefined }
  })
}

/** Model + Release selects from GET /models (enabled models of the DB, with release dates). */
export function ModelCard({
  models,
  modelId,
  releaseId,
  onModel,
  onRelease,
}: {
  models: Load<{ models: Model[] }>
  modelId: string | null
  releaseId: string | null
  onModel: (id: string) => void
  onRelease: (id: string) => void
}) {
  const list = useMemo(() => models.data?.models.filter((m) => m.enabled) ?? [], [models.data])
  const model = list.find((m) => m.id === modelId)
  const modelOptions: SelectOption[] = list.map((m) => ({ value: m.id, label: <ModelLabel model={m.id} provider={m.provider} label={m.label} size={20} />, meta: m.id }))
  const loading = models.status === 'loading' && !models.data
  const failed = models.status === 'error' && !models.data

  return (
    <Card className="ta-card" data-testid="model-card">
      <div className="ta-card__top">
        <span className="tma-label">Model · via OpenRouter</span>
        <span className="tma-badge tma-badge--neutral">Platform-run</span>
      </div>
      {failed ? (
        <div className="ta-stack" data-testid="models-error">
          <span className="ta-error" role="alert">{describeError(models.error, 'Could not load the models. Try again.')}</span>
          <div>
            <Button variant="secondary" size={32} onClick={models.reload}>
              Try again
            </Button>
          </div>
        </div>
      ) : (
        <div className="ta-pair ta-pair--even">
          <Field label="Model" htmlFor="ta-model">
            <Select
              id="ta-model"
              value={modelId}
              options={modelOptions}
              onChange={onModel}
              disabled={loading}
              placeholder={loading ? 'Loading…' : 'No models available'}
              aria-label="Model"
            />
          </Field>
          <Field label="Release" htmlFor="ta-release">
            <Select
              id="ta-release"
              value={releaseId}
              options={releaseOptions(model)}
              onChange={onRelease}
              disabled={loading || !model || (model.releases?.length ?? 0) === 0}
              placeholder="—"
              aria-label="Release"
            />
          </Field>
        </div>
      )}
      <span className="ta-help">Injected at runtime on testmyagent infra. Your agent needs no API key of its own.</span>
    </Card>
  )
}
