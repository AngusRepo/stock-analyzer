import assert from 'node:assert/strict'
import { queuePostPipelineStage, type PipelineStageRow } from './pipelineStageLease'

const NOW = '2026-08-15 00:00:00'

function stageRow(input: Partial<PipelineStageRow> = {}): PipelineStageRow {
  return {
    business_date: '2026-08-14',
    stage: 'post_pipeline_chain',
    canonical_run_id: 'old-run',
    status: 'running',
    cursor_key: null,
    processed_count: 0,
    expected_count: null,
    persisted_count: 0,
    attempt_count: 1,
    lease_owner: 'old-owner',
    lease_expires_at: '2026-08-15 00:10:00',
    ...input,
  }
}

class FakeStatement {
  private values: unknown[] = []

  constructor(
    private readonly db: FakePipelineStageD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: 0 } }
  }
}

class FakePipelineStageD1 {
  constructor(public row: PipelineStageRow | null) {}

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql)
  }

  first(sql: string, values: unknown[]): PipelineStageRow | null {
    if (sql.includes('INSERT INTO pipeline_stage_runs')) {
      if (this.row) return null
      const [businessDate, stage, runId] = values.map(String)
      this.row = stageRow({
        business_date: businessDate,
        stage,
        canonical_run_id: runId,
        status: 'queued',
        attempt_count: 0,
        lease_owner: null,
        lease_expires_at: null,
      })
      return { ...this.row }
    }

    if (sql.includes("SET canonical_run_id=?, status='queued'") && sql.includes("status IN ('waiting', 'error')")) {
      const [runId, businessDate, stage, differentRunId] = values.map(String)
      if (
        this.row
        && this.row.business_date === businessDate
        && this.row.stage === stage
        && this.row.canonical_run_id !== differentRunId
        && (
          ['waiting', 'error'].includes(this.row.status)
          || (this.row.status === 'running' && Boolean(this.row.lease_expires_at) && this.row.lease_expires_at! < NOW)
        )
      ) {
        this.row = stageRow({
          business_date: businessDate,
          stage,
          canonical_run_id: runId,
          status: 'queued',
          attempt_count: 0,
          lease_owner: null,
          lease_expires_at: null,
        })
        return { ...this.row }
      }
      return null
    }

    if (sql.includes("SET status='queued'") && sql.includes("status IN ('waiting', 'error')")) {
      if (
        this.row
        && (
          ['waiting', 'error'].includes(this.row.status)
          || (this.row.status === 'running' && Boolean(this.row.lease_expires_at) && this.row.lease_expires_at! < NOW)
        )
      ) {
        this.row = { ...this.row, status: 'queued', lease_owner: null, lease_expires_at: null }
        return { ...this.row }
      }
      return null
    }

    if (sql.includes('SET canonical_run_id=?') && sql.includes("AND status='success'")) {
      const [runId, businessDate, stage, differentRunId] = values.map(String)
      if (
        this.row
        && this.row.business_date === businessDate
        && this.row.stage === stage
        && this.row.status === 'success'
        && this.row.canonical_run_id !== differentRunId
      ) {
        this.row = stageRow({
          business_date: businessDate,
          stage,
          canonical_run_id: runId,
          status: 'queued',
          attempt_count: 0,
          lease_owner: null,
          lease_expires_at: null,
        })
        return { ...this.row }
      }
      return null
    }

    if (sql.includes('FROM pipeline_stage_runs')) {
      return this.row ? { ...this.row } : null
    }

    throw new Error(`unsupported SQL in lease test: ${sql}`)
  }
}

class FakeQueue {
  readonly messages: Array<Record<string, unknown>> = []

  async send(message: Record<string, unknown>): Promise<void> {
    this.messages.push(message)
  }
}

async function queueWith(row: PipelineStageRow) {
  const db = new FakePipelineStageD1(row)
  const queue = new FakeQueue()
  const result = await queuePostPipelineStage({
    DB: db as unknown as D1Database,
    UPDATE_QUEUE: queue as unknown as Queue,
  }, {
    businessDate: '2026-08-14',
    runId: 'new-run',
    adoptRunIdOnResume: true,
    supersedeSuccess: true,
  })
  return { db, queue, result }
}

async function main() {
  const activeOldLease = await queueWith(stageRow())
  assert.deepEqual(activeOldLease.result, {
    queued: false,
    canonicalRunId: 'old-run',
    status: 'running',
  })
  assert.equal(activeOldLease.queue.messages.length, 0)
  assert.equal(activeOldLease.db.row?.canonical_run_id, 'old-run')

  const waitingOldLease = await queueWith(stageRow({
    status: 'waiting',
    lease_owner: null,
    lease_expires_at: null,
  }))
  assert.equal(waitingOldLease.result.queued, true)
  assert.equal(waitingOldLease.result.canonicalRunId, 'new-run')
  assert.equal(waitingOldLease.db.row?.canonical_run_id, 'new-run')
  assert.equal(waitingOldLease.queue.messages.length, 1)
  assert.equal(waitingOldLease.queue.messages[0]?.runId, 'new-run')

  const expiredOldLease = await queueWith(stageRow({ lease_expires_at: '2026-08-14 23:59:59' }))
  assert.equal(expiredOldLease.result.queued, true)
  assert.equal(expiredOldLease.result.canonicalRunId, 'new-run')
  assert.equal(expiredOldLease.queue.messages[0]?.runId, 'new-run')

  const successfulOldRun = await queueWith(stageRow({
    status: 'success',
    lease_owner: null,
    lease_expires_at: null,
  }))
  assert.equal(successfulOldRun.result.queued, true)
  assert.equal(successfulOldRun.result.canonicalRunId, 'new-run')
  assert.equal(successfulOldRun.queue.messages[0]?.runId, 'new-run')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
