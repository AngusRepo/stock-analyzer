import { Hono } from 'hono'
import type { Bindings, Variables } from '../types'
import { authMiddleware, adminMiddleware } from '../lib/auth'
import { analyzeCurrentState } from '../strategy-discovery/currentState'
import { StrategyDiscoveryRepository } from '../strategy-discovery/repositories'
import { StrategyDiscoveryArtifacts } from '../strategy-discovery/artifacts'
import { isLocalFixtureModeAuthorized, ZIP_LIMITS } from '../strategy-discovery/config'
import { importCodexResult } from '../strategy-discovery/codexImport'
import { recoverableLatestRun } from '../strategy-discovery/buttonState'

const routes = new Hono<{ Bindings: Bindings; Variables: Variables }>()
routes.use('/api/dashboard-state', authMiddleware, adminMiddleware)
routes.use('/api/full-analysis', authMiddleware, adminMiddleware)
routes.use('/api/runs/*', authMiddleware, adminMiddleware)

function idempotencyKey(value: string | undefined): string | null {
  const key = value?.trim() ?? ''
  return key.length >= 8 && key.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(key) ? key : null
}

function newRunId(now = new Date()): string {
  return `RUN-${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`
}

routes.get('/api/dashboard-state', async (c) => c.json(await analyzeCurrentState(c.env)))

routes.post('/api/full-analysis', async (c) => {
  const key = idempotencyKey(c.req.header('Idempotency-Key'))
  if (!key) return c.json({ error: 'Valid Idempotency-Key header required' }, 400)
  const repository = new StrategyDiscoveryRepository(c.env.DB)
  const state = await analyzeCurrentState(c.env)
  const duplicate = await repository.getRunByIdempotencyKey(key)
  const recoverableLatest = recoverableLatestRun(state)
  // A recoverable or stale run is the one idempotent replay that must execute
  // again: the workflow reuses its completed checkpoints and advances attempt.
  if (duplicate && duplicate.run_id !== recoverableLatest?.run_id) {
    return c.json({ run_id: duplicate.run_id, status: duplicate.status, idempotent_replay: true }, 200)
  }
  if (state.blockers.length) return c.json({ error: 'Analysis blocked', blockers: state.blockers, workers_ai: state.workers_ai }, 409)
  if (!c.env.STRATEGY_DISCOVERY_WORKFLOW) return c.json({ error: 'Strategy Discovery Workflow binding missing' }, 503)
  const body = await c.req.json<{ fixture_mode?: boolean }>().catch(() => null)
  const fixtureMode = body?.fixture_mode === true
  if (fixtureMode && !isLocalFixtureModeAuthorized(c.env)) {
    return c.json({ error: 'Fixture mode is local-test only' }, 403)
  }
  const latest = state.latest_run
  if (latest && ['CREATED', 'PREFLIGHT', 'RUNNING'].includes(latest.status) && latest.run_id !== recoverableLatest?.run_id) {
    return c.json({ error: 'Analysis already running', run_id: latest.run_id, status: latest.status }, 409)
  }
  let run
  let resume = false
  try {
    if (recoverableLatest) {
      run = recoverableLatest
      resume = true
    } else {
      run = await repository.createRun({ runId: newRunId(), idempotencyKey: key, fixtureMode })
    }
    const attempt = run.workflow_attempt + 1
    const workflowId = `${run.run_id}-a${attempt}`
    const instance = await c.env.STRATEGY_DISCOVERY_WORKFLOW.create({ id: workflowId, params: { run_id: run.run_id, attempt } })
    await repository.updateRun(run.run_id, {
      status: 'RUNNING', workflowInstanceId: instance.id, workflowAttempt: attempt,
      currentStep: '01_preflight', errorCode: null, errorDetail: null, heartbeat: true,
    })
    return c.json({ run_id: run.run_id, workflow_instance_id: instance.id, status: 'RUNNING', resume, idempotent_replay: false }, 202)
  } catch (error) {
    if (run) await repository.updateRun(run.run_id, { status: 'FAILED_RECOVERABLE', errorCode: 'workflow_start_failed', errorDetail: error instanceof Error ? error.message : String(error) }).catch(() => undefined)
    const message = error instanceof Error ? error.message : String(error)
    return c.json({ error: message }, message === 'analysis_active_run_conflict' ? 409 : 503)
  }
})

routes.get('/api/runs/:runId/status', async (c) => {
  const run = await new StrategyDiscoveryRepository(c.env.DB).getRun(c.req.param('runId'))
  return run ? c.json(run) : c.json({ error: 'Run not found' }, 404)
})

async function artifactResponse(c: any, artifactType: string, contentDisposition?: string) {
  const repository = new StrategyDiscoveryRepository(c.env.DB)
  const artifact = await repository.artifact(c.req.param('runId'), artifactType)
  if (!artifact) return c.json({ error: 'Artifact not found' }, 404)
  try {
    const bytes = await new StrategyDiscoveryArtifacts(c.env.ARTIFACTS, repository).getBytes(artifact.r2_key, artifact.artifact_hash)
    if (artifactType === 'jury-bundle') {
      const run = await repository.getRun(c.req.param('runId'))
      if (run?.status === 'CODEX_HANDOFF_READY') await repository.updateRun(run.run_id, { status: 'AWAITING_RESULT', heartbeat: true })
    }
    const headers = new Headers({ 'Content-Type': artifact.content_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' })
    if (contentDisposition) headers.set('Content-Disposition', contentDisposition)
    const body = new Uint8Array(new ArrayBuffer(bytes.byteLength))
    body.set(bytes)
    return new Response(body.buffer, { headers })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
  }
}

routes.get('/api/runs/:runId/report', (c) => artifactResponse(c, 'cloud-analysis-report'))
routes.get('/api/runs/:runId/jury-bundle', (c) => artifactResponse(c, 'jury-bundle', `attachment; filename="jury-bundle-${c.req.param('runId')}.zip"`))

routes.post('/api/runs/:runId/codex-result', async (c) => {
  const key = idempotencyKey(c.req.header('Idempotency-Key'))
  if (!key) return c.json({ error: 'Valid Idempotency-Key header required' }, 400)
  const contentType = c.req.header('Content-Type')?.split(';', 1)[0].trim().toLowerCase()
  if (!['application/zip', 'application/x-zip-compressed'].includes(contentType ?? '')) return c.json({ error: 'application/zip required' }, 415)
  const declaredSize = Number(c.req.header('Content-Length') ?? 0)
  if (declaredSize > ZIP_LIMITS.maxUploadBytes) return c.json({ error: 'ZIP upload too large' }, 413)
  const buffer = await c.req.arrayBuffer()
  if (!buffer.byteLength || buffer.byteLength > ZIP_LIMITS.maxUploadBytes) return c.json({ error: 'ZIP upload size invalid' }, 413)
  try { return c.json(await importCodexResult({ env: c.env, runId: c.req.param('runId'), idempotencyKey: key, bytes: new Uint8Array(buffer) }), 200) }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const status = message.includes('not_found') ? 404 : message.includes('not_importable') ? 409 : 422
    return c.json({ error: message }, status)
  }
})

routes.get('/api/runs/:runId/codex-conclusion', (c) => artifactResponse(c, 'codex-conclusion'))

export { routes as strategyDiscoveryRoutes }
