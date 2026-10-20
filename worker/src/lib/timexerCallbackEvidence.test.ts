import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import ts from 'typescript'
import * as logger from './schedulerRunLogger'
import { acceptPipelineExecutionCallback, isPipelineStageCanonicalState } from './pipelineStageLease'
import { verifyServingOnlyCallback } from './postcloseResearch'
import * as evidence from './timexerCallbackEvidence'

const day = '2026-10-19', runId = 'run-a', checksum = 'a'.repeat(64)
const receipt = {
  path: `pipeline-v2/premarket/${day}/${createHash('sha256').update(runId).digest('hex')}/timexer-outcomes/${checksum}.json`,
  checksum, observation_status: 'sealed_l3', pipeline_status: 'error',
}
const callback = () => ({
  task: 'pipeline', status: 'error', run_date: day, run_id: runId,
  error: 'pipeline_cloud_run_failed:memory_limit', timexer_evidence_receipt: { ...receipt },
})

class LocalKv {
  values = new Map<string, string>()
  fail = false
  async get(key: string, kind?: string) {
    const raw = this.values.get(key)
    return raw === undefined ? null : kind === 'json' ? JSON.parse(raw) : raw
  }
  async put(key: string, value: string) {
    if (this.fail) throw new Error('fixture-kv-write-failed')
    this.values.set(key, value)
  }
  async delete(key: string) { this.values.delete(key) }
}

function routeFixture() {
  const sql = new DatabaseSync(':memory:')
  sql.exec(`CREATE TABLE pipeline_stage_runs (
    business_date TEXT, stage TEXT, canonical_run_id TEXT, status TEXT, cursor_key TEXT,
    processed_count INTEGER, expected_count INTEGER, persisted_count INTEGER, attempt_count INTEGER,
    lease_owner TEXT, lease_expires_at TEXT, completed_at TEXT, updated_at TEXT, last_error TEXT);
    INSERT INTO pipeline_stage_runs(business_date,stage,canonical_run_id,status)
    VALUES ('${day}','pipeline_execution','${runId}','running');`)
  const db = { prepare: (query: string) => ({
    bind: (...args: any[]) => ({ first: async () => sql.prepare(query).get(...args) ?? null }),
  }) }
  const kv = new LocalKv()
  // Compile the actual callback, injecting I/O while retaining the real SQL ownership guard.
  const path = process.env.TIMEXER_CALLBACK_SOURCE || 'src/routes/adminControlRoutes.ts'
  const source = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'handleSchedulerCallback')!
  const code = ts.transpile(fn.getFullText(source), {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  }).replace(/\bimport\(/g, 'imports(')
  const deps = {
    requireServiceToken: async () => null,
    databaseForDataDomain: () => db,
    acceptPipelineExecutionCallback, isPipelineStageCanonicalState,
    REPORT_ARTIFACT_TASKS: new Set<string>(),
    imports: async (name: string) => {
      if (name === '../lib/schedulerRunLogger') return logger
      if (name === '../lib/timexerCallbackEvidence') return evidence
      if (name === '../lib/postcloseResearch') return { verifyServingOnlyCallback }
      if (name === '../lib/eveningChainRootClosure') return { closeEveningChainRootIfComplete: async () => null }
      throw new Error(`unexpected fixture import: ${name}`)
    },
  }
  const handler = new Function(...Object.keys(deps), `${code}; return handleSchedulerCallback;`)(...Object.values(deps))
  return {
    sql, kv,
    call: (body: unknown) => handler({
      req: { json: async () => body },
      env: { KV: kv, PAPER_DAILY_PLAN_OWNER: 'premarket_once_v1', ML_CONTROLLER_URL: 'https://controller.invalid' },
      json: (body: unknown, status = 200) => ({ status, body }),
    }),
    saved: () => kv.get(`scheduler:run:pipeline:${day}`, 'json'),
  }
}

test('actual callback saves a canonical receipt, preserves it on duplicate legacy callbacks, and rejects stale runs', async () => {
  const f = routeFixture()
  try {
    assert.equal((await f.call({ ...callback(), run_id: 'stale' })).status, 409)
    assert.equal(f.kv.values.size, 0)
    assert.equal((await f.call(callback())).status, 200)
    assert.deepEqual((await f.saved()).timexer_evidence_receipt, receipt)
    assert.equal((await f.call(callback())).status, 200)
    const duplicate = { ...callback(), timexer_evidence_receipt: undefined }
    assert.equal((await f.call(duplicate)).status, 200)
    assert.deepEqual((await f.saved()).timexer_evidence_receipt, receipt)
    assert.deepEqual((await f.kv.get(`scheduler:run:daily:${day}`, 'json')).pipeline.timexer_evidence_receipt, receipt)
  } finally { f.sql.close() }
})

test('actual callback rejects a receipt for another run and keeps recorder/KV failures visible and retryable', async () => {
  const f = routeFixture()
  try {
    const wrong = { ...callback(), timexer_evidence_receipt: { ...receipt, path: receipt.path.replace(checksum, 'b'.repeat(64)) } }
    assert.equal((await f.call(wrong)).status, 400)
    assert.equal(f.kv.values.size, 0)
    const failed = { ...callback(), timexer_evidence_receipt: undefined, timexer_recorder_error: 'OSError' }
    assert.equal((await f.call(failed)).status, 200)
    assert.equal((await f.saved()).timexer_recorder_error, 'OSError')
    f.kv.fail = true
    assert.equal((await f.call(callback())).status, 503)
    f.kv.fail = false
    assert.equal((await f.call(callback())).status, 200)
    assert.deepEqual((await f.saved()).timexer_evidence_receipt, receipt)
    assert.equal((await f.saved()).timexer_recorder_error, undefined)
  } finally { f.sql.close() }
})

test('receipt identity validation rejects malformed or inconsistent evidence', async () => {
  for (const change of [
    { checksum: 'bad' }, { pipeline_status: 'success' }, { observation_status: 'invented' },
    { path: receipt.path.replace(day, '2026-10-20') },
  ]) {
    await assert.rejects(evidence.timexerCallbackEvidence(
      { ...callback(), timexer_evidence_receipt: { ...receipt, ...change } }, day, runId), /evidence_invalid/)
  }
  await assert.rejects(evidence.timexerCallbackEvidence(
    { ...callback(), timexer_recorder_error: 'OSError' }, day, runId), /evidence_invalid/)
  assert.deepEqual(await evidence.timexerCallbackEvidence({ task: 'pipeline', status: 'error' }, day, runId), {})
})

test('published Paper success survives diagnostic KV failure and retry never republishes or queues trades', async () => {
  const f = routeFixture(), originalFetch = globalThis.fetch
  const calls: string[] = [], publicationChecksum = 'c'.repeat(64)
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(init?.method, 'GET') // Any publication, queue or order mutation fails this fixture.
    assert.equal(url.pathname, '/pipeline/v2/premarket-state')
    assert.equal(url.searchParams.get('date'), day)
    assert.equal(url.searchParams.get('run_id'), runId)
    calls.push(url.pathname)
    return Response.json({ publication: { checksum: publicationChecksum, signal_date: day, run_id: runId } })
  }
  try {
    const body = { ...callback(), status: 'success', error: undefined,
      serving_publication_checksum: publicationChecksum,
      timexer_evidence_receipt: { ...receipt, pipeline_status: 'success' } }
    f.kv.fail = true
    assert.equal((await f.call(body)).status, 503)
    assert.equal(f.sql.prepare("SELECT status FROM pipeline_stage_runs WHERE stage='pipeline_execution'").get()?.status, 'success')
    assert.equal((await f.call(callback())).status, 409) // Late job-error cannot reverse published success.
    f.kv.fail = false
    assert.equal((await f.call(body)).status, 200)
    assert.equal((await f.saved()).status, 'success')
    assert.deepEqual((await f.saved()).timexer_evidence_receipt, body.timexer_evidence_receipt)
    assert.deepEqual(calls, ['/pipeline/v2/premarket-state', '/pipeline/v2/premarket-state'])
  } finally { globalThis.fetch = originalFetch; f.sql.close() }
})
