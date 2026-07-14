import assert from 'node:assert/strict'
import { StrategyDiscoveryWorkersAiClient } from '../strategy-discovery/workersAiClient'
import { roleMessages } from '../strategy-discovery/rolePrompts'

const schema = { name: 'answer', schema: { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } } }
const validate = (value: unknown) => {
  const answer = (value as any)?.answer
  return typeof answer === 'string' ? { ok: true, value: { answer }, errors: [] } : { ok: false, errors: ['answer_required'] }
}

async function main() {
  for (const role of ['HYPOTHESIS_SCIENTIST', 'REGIME_EXPLORER', 'EXECUTION_ARCHITECT'] as const) {
    const system = roleMessages(role, { assigned: 'one' })[0].content
    assert.match(system, /exactly one assigned/i, `${role} must not request a batch from a single-item schema`)
    assert.doesNotMatch(system, /exactly (?:2|6|12)/i)
  }

  const calls: any[] = []
  const records: any[] = []
  const writtenArtifacts: Array<{ type: string; value: unknown }> = []
  const ai = { run: async (_model: string, request: any) => {
    calls.push(request)
    return calls.length === 1 ? { response: { wrong: true }, usage: { prompt_tokens: 10, completion_tokens: 2 } } : { response: { answer: 'repaired' }, usage: { prompt_tokens: 5, completion_tokens: 3 } }
  } }
  const artifacts = { putJson: async (_run: string, type: string, value: unknown) => { writtenArtifacts.push({ type, value }); return { key: `r2/${type}` } } } as any
  const repository = { recordModelCall: async (row: any) => { records.push(row) } }
  const client = new StrategyDiscoveryWorkersAiClient(ai, repository as any, artifacts, false)
  const result = await client.invoke({ runId: 'RUN-1', stepId: '03', role: 'FEATURE_LIBRARIAN', messages: [{ role: 'user', content: 'return answer' }], outputSchema: schema, validate })
  assert.equal(result.parsed.answer, 'repaired')
  assert.equal(result.repair_count, 1)
  assert.equal(calls.length, 2, 'only one formatting repair is allowed')
  assert.ok(calls[0].response_format)
  assert.equal(calls[0].response_format.json_schema.type, 'object')
  assert.equal(records[0].prompt_tokens, 15)
  assert.equal(records[0].source_type, 'REAL')
  const rawEvidence = writtenArtifacts.find((row) => row.type.startsWith('model-raw-'))?.value as any
  assert.deepEqual(rawEvidence.attempts.map((row: any) => row.kind), ['primary', 'repair'])
  assert.deepEqual(rawEvidence.attempts[0].normalized_response, { wrong: true })
  assert.deepEqual(rawEvidence.final_normalized, { answer: 'repaired' })

  let wrappedRepairCalls = 0
  const wrappedRepair = new StrategyDiscoveryWorkersAiClient({ run: async () => {
    wrappedRepairCalls += 1
    return wrappedRepairCalls === 1
      ? { response: { wrong: true } }
      : { response: { validation_errors: ['answer_required'], schema: schema.schema, raw: { answer: 'nested-repair' } } }
  } }, { recordModelCall: async () => undefined } as any, artifacts, false)
  const wrappedRepairResult = await wrappedRepair.invoke({ runId: 'RUN-WR', stepId: '03', role: 'FEATURE_LIBRARIAN', messages: [], outputSchema: schema, validate })
  assert.equal(wrappedRepairResult.parsed.answer, 'nested-repair')
  assert.equal(wrappedRepairResult.repair_count, 1)
  assert.equal(wrappedRepairCalls, 2)

  const envelopeRecords: any[] = []
  const envelope = new StrategyDiscoveryWorkersAiClient({ run: async () => ({
    choices: [{ message: { content: '{"answer":"wrapped"}' } }],
    usage: { prompt_tokens: 7, completion_tokens: 2 },
  }) }, { recordModelCall: async (row: any) => { envelopeRecords.push(row) } } as any, artifacts, false)
  const envelopeResult = await envelope.invoke({ runId: 'RUN-E', stepId: '01', role: 'PORTFOLIO_JUDGE', messages: [], outputSchema: schema, validate })
  assert.equal(envelopeResult.parsed.answer, 'wrapped')
  assert.equal(envelopeResult.repair_count, 0)
  assert.equal(envelopeRecords[0].validation_status, 'VALID')

  const cappedCalls: any[] = []
  const capped = new StrategyDiscoveryWorkersAiClient({ run: async (_model: string, request: any) => {
    cappedCalls.push(request)
    return { response: { answer: 'capped' } }
  } }, { recordModelCall: async () => undefined } as any, artifacts, false)
  await capped.invoke({ runId: 'RUN-C', stepId: '01', role: 'EXECUTION_ARCHITECT', messages: [], outputSchema: schema, validate, maxTokens: 64 })
  assert.equal(cappedCalls[0].max_tokens, 64)
  assert.equal(cappedCalls[0].reasoning_effort, 'low')

  const fallbackRecords: any[] = []
  let fallbackCalls = 0
  const fallback = new StrategyDiscoveryWorkersAiClient({ run: async () => {
    fallbackCalls += 1
    if (fallbackCalls === 1) throw new Error('504 Gateway Time-out')
    return { response: { answer: 'fallback' }, usage: { prompt_tokens: 4, completion_tokens: 2 } }
  } }, { recordModelCall: async (row: any) => { fallbackRecords.push(row) } } as any, artifacts, false)
  const fallbackResult = await fallback.invoke({ runId: 'RUN-FB', stepId: '06', role: 'EXECUTION_ARCHITECT', messages: [], outputSchema: schema, validate })
  assert.equal(fallbackResult.parsed.answer, 'fallback')
  assert.equal(fallbackCalls, 2)
  assert.equal(fallbackRecords[0].model_id, '@cf/qwen/qwen3-30b-a3b-fp8')
  assert.match(fallbackRecords[0].model_version, /fallback-from:@cf\/zai-org\/glm-4\.7-flash/)

  let internalErrorCalls = 0
  const internalErrorRequests: any[] = []
  const internalErrorFallback = new StrategyDiscoveryWorkersAiClient({ run: async (_model: string, request: any) => {
    internalErrorCalls += 1
    internalErrorRequests.push(request)
    if (internalErrorCalls === 1) throw new Error('AiError: 3043: Internal server error')
    return { response: { answer: 'internal-error-fallback' } }
  } }, { recordModelCall: async () => undefined } as any, artifacts, false)
  const internalErrorResult = await internalErrorFallback.invoke({ runId: 'RUN-3043', stepId: '06', role: 'EXECUTION_ARCHITECT', messages: [], outputSchema: schema, validate })
  assert.equal(internalErrorResult.parsed.answer, 'internal-error-fallback')
  assert.equal(internalErrorCalls, 2)
  assert.equal(internalErrorRequests[1].response_format.type, 'json_object')
  assert.equal(internalErrorRequests[1].response_format.json_schema, undefined)
  assert.match(internalErrorRequests[1].messages[0].content, /trusted output schema/)

  const schemaFallbackRecords: any[] = []
  let schemaFallbackCalls = 0
  const schemaFallback = new StrategyDiscoveryWorkersAiClient({ run: async () => {
    schemaFallbackCalls += 1
    return schemaFallbackCalls === 1 ? { response: { invalid: true } } : { response: { answer: 'schema-fallback' } }
  } }, { recordModelCall: async (row: any) => { schemaFallbackRecords.push(row) } } as any, artifacts, false)
  const schemaFallbackResult = await schemaFallback.invoke({ runId: 'RUN-SFB', stepId: '05', role: 'REGIME_EXPLORER', messages: [], outputSchema: schema, validate })
  assert.equal(schemaFallbackResult.parsed.answer, 'schema-fallback')
  assert.equal(schemaFallbackCalls, 2)
  assert.equal(schemaFallbackRecords[0].model_id, '@cf/qwen/qwen3-30b-a3b-fp8')

  const hypothesisFallbackRecords: any[] = []
  let hypothesisFallbackCalls = 0
  const hypothesisFallback = new StrategyDiscoveryWorkersAiClient({ run: async () => {
    hypothesisFallbackCalls += 1
    return hypothesisFallbackCalls === 1 ? { response: { HYPOTHESIS: 'incomplete' } } : { response: { answer: 'qwen-hypothesis-fallback' } }
  } }, { recordModelCall: async (row: any) => { hypothesisFallbackRecords.push(row) } } as any, artifacts, false)
  const hypothesisFallbackResult = await hypothesisFallback.invoke({ runId: 'RUN-HFB', stepId: '05', role: 'HYPOTHESIS_SCIENTIST', messages: [], outputSchema: schema, validate })
  assert.equal(hypothesisFallbackResult.parsed.answer, 'qwen-hypothesis-fallback')
  assert.equal(hypothesisFallbackCalls, 2)
  assert.equal(hypothesisFallbackRecords[0].model_id, '@cf/qwen/qwen3-30b-a3b-fp8')
  assert.match(hypothesisFallbackRecords[0].model_version, /fallback-from:@cf\/mistralai\/mistral-small-3\.1-24b-instruct/)

  const fenced = new StrategyDiscoveryWorkersAiClient({ run: async () => ({
    response: 'Schema-valid JSON:\n```json\n{"answer":"fenced"}\n```',
  }) }, { recordModelCall: async () => undefined } as any, artifacts, false)
  const fencedResult = await fenced.invoke({ runId: 'RUN-F', stepId: '01', role: 'HYPOTHESIS_SCIENTIST', messages: [], outputSchema: schema, validate })
  assert.equal(fencedResult.parsed.answer, 'fenced')
  assert.equal(fencedResult.repair_count, 0)

  const fixtureRecords: any[] = []
  const fixture = new StrategyDiscoveryWorkersAiClient(undefined, { recordModelCall: async (row: any) => { fixtureRecords.push(row) } } as any, artifacts, true)
  const fixtureResult = await fixture.invoke({ runId: 'RUN-2', stepId: '03', role: 'FEATURE_LIBRARIAN', messages: [], outputSchema: schema, validate, fixture: { answer: 'fixture' } })
  assert.equal(fixtureResult.source_type, 'FIXTURE')
  assert.equal(fixtureResult.estimated_neurons, 0)
  assert.equal(fixtureRecords[0].source_type, 'FIXTURE')

  const failedRecords: any[] = []
  const failedArtifacts: Array<{ type: string; value: any }> = []
  let failedCalls = 0
  const failing = new StrategyDiscoveryWorkersAiClient({ run: async () => { failedCalls += 1; return { response: { invalid: true } } } }, { recordModelCall: async (row: any) => { failedRecords.push(row) } } as any, artifacts, false)
  await assert.rejects(() => failing.invoke({ runId: 'RUN-3', stepId: '09', role: 'DATA_PROSECUTOR', messages: [{ role: 'user', content: 'long role analysis' }], outputSchema: schema, validate }), /model_schema_validation_failed/)
  assert.equal(failedCalls, 2, 'one role failure gets exactly one format repair')
  assert.equal(failedRecords[0].validation_status, 'FAILED')
  assert.equal(failedRecords[0].repair_count, 1)

  const fatal = new StrategyDiscoveryWorkersAiClient({ run: async () => { throw new Error('fatal credential failure') } }, { recordModelCall: async () => undefined } as any,
    { putJson: async (_run: string, type: string, value: any) => { failedArtifacts.push({ type, value }); return { key: `r2/${type}` } } } as any, false)
  await assert.rejects(() => fatal.invoke({ runId: 'RUN-FATAL', stepId: '09', role: 'DATA_PROSECUTOR', messages: [], outputSchema: schema, validate, fixture: { answer: 'must-not-leak' } }), /fatal credential failure/)
  const fatalRaw = failedArtifacts.find((row) => row.type.startsWith('model-raw-'))?.value
  assert.deepEqual(fatalRaw.attempts, [])
  assert.equal(Object.prototype.hasOwnProperty.call(fatalRaw, 'final_normalized'), true)
  assert.equal(fatalRaw.final_normalized, undefined)
}

void main()
