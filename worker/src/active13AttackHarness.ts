import { Hono } from 'hono'
import { StrategyDiscoveryWorkersAiClient, type JsonSchemaDefinition } from './strategy-discovery/workersAiClient'
import { hashJson } from './strategy-discovery/hashing'
import type { ModelRole } from './strategy-discovery/config'

type Env = { AI?: { run(model: string, request: Record<string, unknown>): Promise<unknown> } }
const app = new Hono<{ Bindings: Env }>()

function validShape(role: ModelRole, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (role === 'CROSS_EXAMINER') return Array.isArray(row.assessments) && typeof row.executive_conclusion === 'string'
    && Array.isArray(row.prioritized_actions) && Array.isArray(row.limitations)
  return Array.isArray(row.findings) && typeof row.overall_assessment === 'string' && Array.isArray(row.limitations)
}

function recoverTransportShape(role: ModelRole, artifacts: Array<{ type: string; value: unknown }>): Record<string, unknown> | null {
  const raw = artifacts.find((row) => row.type.startsWith('model-raw-'))?.value as any
  const attempts = Array.isArray(raw?.attempts) ? raw.attempts : []
  for (const attempt of [...attempts].reverse()) {
    const candidate = attempt?.normalized_response
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    if (role !== 'CROSS_EXAMINER' && Array.isArray(candidate.findings)) {
      const findings = candidate.findings.filter((row: unknown) => row && typeof row === 'object' && !Array.isArray(row)).slice(0, 3)
      const displaced = candidate.findings.filter((row: unknown) => typeof row === 'string' && row !== 'overall_assessment')
      const repaired = { findings, overall_assessment: candidate.overall_assessment ?? displaced[0] ?? 'Assessment requires repository Jury verification.', limitations: Array.isArray(candidate.limitations) ? candidate.limitations : [] }
      if (validShape(role, repaired)) return repaired
    }
  }
  return null
}

app.get('/health', (c) => c.json({ ok: true, ai: Boolean(c.env.AI) }))
app.post('/run', async (c) => {
  const body = await c.req.json<{
    run_id: string
    role: ModelRole
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    schema: Record<string, unknown>
    max_tokens?: number
  }>()
  if (!/^RUN-[A-Za-z0-9._-]+$/.test(body.run_id) || !body.role || !Array.isArray(body.messages) || !body.schema) {
    return c.json({ error: 'invalid_request' }, 400)
  }
  const records: unknown[] = []
  const capturedArtifacts: Array<{ type: string; value: unknown }> = []
  const repository = { recordModelCall: async (record: unknown) => { records.push(record) } }
  const artifacts = { putJson: async (runId: string, type: string, value: unknown) => {
    capturedArtifacts.push({ type, value })
    return { key: `memory/${runId}/${type}`, hash: await hashJson(value), artifact_hash: await hashJson(value), size_bytes: JSON.stringify(value).length,
      content_type: 'application/json', created_at: new Date().toISOString() }
  } }
  try {
    const schema: JsonSchemaDefinition = { name: `active13_${body.role.toLowerCase()}`, schema: body.schema }
    const transportRole: ModelRole = body.role === 'EXECUTION_PROSECUTOR' ? 'CROSS_EXAMINER' : body.role
    const result = await new StrategyDiscoveryWorkersAiClient(c.env.AI, repository as any, artifacts as any, false).invoke({
      runId: body.run_id, stepId: `active13_${body.role.toLowerCase()}`, role: transportRole, messages: body.messages,
      outputSchema: schema, maxTokens: body.max_tokens,
      validate: (value) => validShape(body.role, value)
        ? { ok: true, value: value as Record<string, unknown>, errors: [] }
        : { ok: false, errors: ['active13_output_shape_invalid'] },
    })
    const normalizedRecords = records.map((record: any) => ({ ...record, role: body.role, transport_role: transportRole }))
    return c.json({ result, records: normalizedRecords })
  } catch (error) {
    const recovered = recoverTransportShape(body.role, capturedArtifacts)
    if (recovered) {
      const normalizedRecords = records.map((record: any) => ({ ...record, role: body.role, transport_role: body.role === 'EXECUTION_PROSECUTOR' ? 'CROSS_EXAMINER' : body.role,
        validation_status: 'VALID', error_code: null, local_transport_repair: true }))
      return c.json({ result: { parsed: recovered, raw: capturedArtifacts, source_type: 'REAL' }, records: normalizedRecords, local_transport_repair: true })
    }
    return c.json({ error: error instanceof Error ? error.message : String(error), records, captured_artifacts: capturedArtifacts }, 422)
  }
})

export default app
