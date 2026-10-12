import { useEffect, useState } from 'react'
import { ApiError, createEvaluation, getTaskPacks, submitAgentEndpointManifest, type RunResponse, type TaskPack } from './api'

/**
 * Doc "1 · Preparar avaliação" (03_produto_mvp_72h.pdf section 2). Self-serve, vendor/studio
 * side — no login system exists yet, so this is public like the rest of the product for the
 * hackathon phase (see api.ts). A commercial or DFL-internal version gates this behind real
 * login+password instead.
 */
export function PreparePage() {
  const [vendorName, setVendorName] = useState('')
  const [agentName, setAgentName] = useState('')
  const [endpointFile, setEndpointFile] = useState<File | null>(null)
  const [endpointUrl, setEndpointUrl] = useState<string | null>(null)
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [uploadingEndpoint, setUploadingEndpoint] = useState(false)
  const [releaseRef, setReleaseRef] = useState('')
  const [taskPacks, setTaskPacks] = useState<TaskPack[]>([])
  const [selectedTask, setSelectedTask] = useState<string>('')
  const [idempotencyKey] = useState(() => crypto.randomUUID())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [run, setRun] = useState<RunResponse | null>(null)

  useEffect(() => {
    getTaskPacks()
      .then((packs) => {
        setTaskPacks(packs)
        if (packs.length > 0) setSelectedTask(`${packs[0].id}::${packs[0].version}`)
      })
      .catch(() => setTaskPacks([]))
  }, [])

  // The "Controlled endpoint" field is a file upload, not a typed URL: the vendor uploads a small
  // JSON file ({"endpointUrl": "https://..."}), which we commit to the public manifests repo for
  // an audit trail (apps/api agent-endpoint-manifests-router.ts) and read the endpoint back from.
  async function handleEndpointFile(file: File) {
    setEndpointFile(file)
    setEndpointUrl(null)
    setEndpointError(null)
    setUploadingEndpoint(true)
    try {
      const content = await file.text()
      const result = await submitAgentEndpointManifest({
        vendorName: vendorName || 'unnamed-vendor',
        agentName: agentName || 'unnamed-agent',
        fileName: file.name,
        content,
      })
      setEndpointUrl(result.endpointUrl)
    } catch (e) {
      setEndpointError(e instanceof ApiError ? e.message : 'Could not read or submit the endpoint file.')
    } finally {
      setUploadingEndpoint(false)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!endpointUrl) {
      setError('Upload a valid endpoint file first.')
      return
    }
    const [taskId, taskVersion] = selectedTask.split('::')
    setLoading(true)
    setError(null)
    try {
      const result = await createEvaluation({
        idempotencyKey,
        vendor: { displayName: vendorName },
        agent: { name: agentName, endpointUrl },
        release: { releaseRef },
        task: { id: taskId, version: taskVersion },
      })
      setRun(result)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not reach the API.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="verify-page">
      <h1>Prepare an evaluation</h1>
      <p className="intro">
        Keep your agent's implementation private. Declare the release and the HTTPS endpoint we'll dispatch the task
        to — your buyer never sees the repo, prompts, or internal tools.
      </p>

      <form onSubmit={submit} className="prepare-form">
        <label className="field">
          <span>Vendor / studio name</span>
          <input value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Demo Studio" required />
        </label>
        <label className="field">
          <span>Agent name</span>
          <input value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="Coding Agent" required />
        </label>
        <label className="field">
          <span>Controlled endpoint config (.json file with an "endpointUrl" field)</span>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void handleEndpointFile(file)
            }}
            required
          />
          {uploadingEndpoint && <p className="small">Uploading & committing to the manifests repo…</p>}
          {endpointFile && endpointUrl && !uploadingEndpoint && (
            <p className="small">Endpoint: <code>{endpointUrl}</code></p>
          )}
          {endpointError && <p className="run-result-error">{endpointError}</p>}
        </label>
        <label className="field">
          <span>Declared release</span>
          <input value={releaseRef} onChange={(e) => setReleaseRef(e.target.value)} placeholder="demo-release-01" required />
        </label>
        <label className="field">
          <span>Task</span>
          <select value={selectedTask} onChange={(e) => setSelectedTask(e.target.value)} required disabled={taskPacks.length === 0}>
            {taskPacks.length === 0 && <option value="">No task packs available</option>}
            {taskPacks.map((pack) => (
              <option key={`${pack.id}::${pack.version}`} value={`${pack.id}::${pack.version}`}>
                {pack.id} · v{pack.version}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary" disabled={loading || uploadingEndpoint || !endpointUrl}>
          {loading ? 'Preparing…' : 'Prepare test'}
        </button>
      </form>

      {error && <p className="run-result-error">{error}</p>}

      {run && (
        <div className="prepare-result">
          <h3>Run created</h3>
          <p>
            Status: <code>{run.status}</code> · Run ID: <code>{run.runId}</code>
          </p>
          <p className="small">
            Use the run ID on the Observe page to dispatch the challenge to the endpoint and run the real grader.
          </p>
          <a className="secondary" href={`/observe/${run.runId}`}>
            Go to Observe & publish →
          </a>
        </div>
      )}
    </main>
  )
}
