import assert from 'node:assert/strict'
import test from 'node:test'

import {
  claimPipelineStage,
  enqueuePipelineStageAuthorized,
  markPipelineStageFenced,
  queuePostPipelineStage,
  queuePostVerifyStage,
  type PipelineStageRow,
} from './pipelineStageLease'

function row(stage: string, runId: string, status: PipelineStageRow['status']): PipelineStageRow {
  return {
    business_date: '2026-08-14',
    stage,
    canonical_run_id: runId,
    status,
    cursor_key: null,
    processed_count: 0,
    expected_count: null,
    persisted_count: 0,
    attempt_count: 0,
    lease_owner: null,
    lease_expires_at: null,
  }
}

type StrategyLearningState = {
  canonicalRunId: string
  status: 'running' | 'success' | 'error'
  leaseOwner: string | null
  leaseLive: boolean
}

class Statement {
  values: unknown[] = []
  constructor(private db: FakeD1, private sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this }
  first<T>() { return Promise.resolve(this.db.first(this.sql, this.values) as T | null) }
  run() { return Promise.resolve({ meta: { changes: 0 } }) }
}

class FakeD1 {
  rows = new Map<string, PipelineStageRow>()
  strategyLearning: StrategyLearningState | null = null
  prepare(sql: string) { return new Statement(this, sql) }

  private authorityAccepted(values: unknown[], offset: number): boolean {
    const [date, stage, canonical, statusA, statusB, cursorA, cursorB, ownerA, ownerB] = values.slice(offset)
    const authority = this.rows.get(String(stage))
    return Boolean(
      authority
      && authority.business_date === date
      && authority.canonical_run_id === canonical
      && (statusA == null || (statusA === statusB && authority.status === statusA))
      && (cursorA == null || (cursorA === cursorB && authority.cursor_key === cursorA))
      && (ownerA == null || (ownerA === ownerB && authority.lease_owner === ownerA)),
    )
  }

  private liveStrategyBlocks(sql: string, current: PipelineStageRow, incomingRunId: unknown): boolean {
    return Boolean(
      sql.includes('FROM strategy_learning_runs strategy_learning')
      && current.canonical_run_id !== incomingRunId
      && this.strategyLearning?.canonicalRunId === current.canonical_run_id
      && ['running', 'success'].includes(this.strategyLearning.status)
      && this.strategyLearning.leaseOwner != null
      && this.strategyLearning.leaseLive
    )
  }

  first(sql: string, values: unknown[]): PipelineStageRow | { status: string } | null {
    if (
      sql.includes('INSERT INTO pipeline_stage_runs')
      && sql.includes('SELECT ?, ?, ?')
      && sql.includes('SELECT 1 FROM pipeline_stage_runs authority')
    ) {
      const [date, stage, runId] = values
      const foreignLiveStrategy = sql.includes('strategy_learning.canonical_run_id<>?')
        && this.strategyLearning?.canonicalRunId !== runId
        && ['running', 'success'].includes(this.strategyLearning?.status ?? '')
        && this.strategyLearning?.leaseOwner != null
        && this.strategyLearning?.leaseLive
      if (foreignLiveStrategy || !this.authorityAccepted(values, 3) || this.rows.has(String(stage))) return null
      const created = row(String(stage), String(runId), 'queued')
      created.business_date = String(date)
      this.rows.set(String(stage), created)
      return { ...created }
    }
    if (sql.includes('INSERT INTO pipeline_stage_runs')) {
      const [date, stage, runId] = values
      const foreignLiveStrategy = sql.includes('strategy_learning.canonical_run_id<>?')
        && this.strategyLearning?.canonicalRunId !== runId
        && ['running', 'success'].includes(this.strategyLearning?.status ?? '')
        && this.strategyLearning?.leaseOwner != null
        && this.strategyLearning?.leaseLive
      if (foreignLiveStrategy || this.rows.has(String(stage))) return null
      const created = row(String(stage), String(runId), 'queued')
      created.business_date = String(date)
      this.rows.set(String(stage), created)
      return { ...created }
    }
    if (sql.includes("SET canonical_run_id=?, status='queued'") && sql.includes('AND EXISTS')) {
      const [runId, date, stage] = values
      const current = this.rows.get(String(stage))
      if (!current || current.business_date !== date || !this.authorityAccepted(values, 3)) return null
      if (
        sql.includes('FROM strategy_learning_runs strategy_learning')
        && current.canonical_run_id !== runId
        && this.liveStrategyBlocks(sql, current, runId)
      ) return null
      const sameCanonical = current.canonical_run_id === runId
      const resumable = sameCanonical
        ? current.status === 'waiting' || current.status === 'error'
        : current.status === 'waiting' || current.status === 'error' || current.status === 'success'
      if (!resumable) return null
      current.canonical_run_id = String(runId)
      current.status = 'queued'
      current.cursor_key = null
      current.lease_owner = null
      current.lease_expires_at = null
      return { ...current }
    }
    if (sql.includes("SET canonical_run_id=?, status='queued'") && sql.includes("status IN ('waiting', 'error')")) {
      const [runId, date, stage] = values
      const current = this.rows.get(String(stage))
      if (!current || current.business_date !== date || current.canonical_run_id === runId) return null
      const resumable = current.status === 'waiting' || current.status === 'error'
      if (!resumable || this.liveStrategyBlocks(sql, current, runId)) return null
      current.canonical_run_id = String(runId)
      current.status = 'queued'
      current.cursor_key = null
      current.lease_owner = null
      current.lease_expires_at = null
      return { ...current }
    }
    if (sql.includes("SET status='queued'") && sql.includes("status IN ('waiting', 'error')")) {
      const [date, stage, expected] = values
      const current = this.rows.get(String(stage))
      if (!current || current.business_date !== date || !['waiting', 'error'].includes(current.status)) return null
      if (sql.includes('canonical_run_id=?') && current.canonical_run_id !== expected) return null
      current.status = 'queued'
      return { ...current }
    }
    if (sql.includes("AND status='success'") && sql.includes('SET canonical_run_id=?')) {
      const [runId, date, stage] = values
      const current = this.rows.get(String(stage))
      if (!current || current.business_date !== date || current.status !== 'success' || current.canonical_run_id === runId) return null
      if (this.liveStrategyBlocks(sql, current, runId)) return null
      current.canonical_run_id = String(runId)
      current.status = 'queued'
      current.cursor_key = null
      current.lease_owner = null
      current.lease_expires_at = null
      return { ...current }
    }
    if (sql.includes("SET status='running'")) {
      const [owner, , date, stage, expectedA, expectedB] = values
      const current = this.rows.get(String(stage))
      if (!current || current.business_date !== date || current.status !== 'queued') return null
      if (expectedA != null && (expectedA !== expectedB || current.canonical_run_id !== expectedA)) return null
      current.status = 'running'
      current.lease_owner = String(owner)
      current.lease_expires_at = '2099-01-01 00:00:00'
      return { ...current }
    }
    if (sql.includes('cursor_key=COALESCE(?, cursor_key)') && sql.includes('lease_expires_at >= CURRENT_TIMESTAMP')) {
      const [
        status, , nextCursor, , date, stage, canonical,
        cursorA, cursorB, ownerA, ownerB, expectedA, expectedB, requireUnleased,
      ] = values
      const current = this.rows.get(String(stage))
      if (!current || current.business_date !== date || current.canonical_run_id !== canonical) return null
      if (cursorA != null && (cursorA !== cursorB || current.cursor_key !== cursorA)) return null
      if (ownerA != null && (
        ownerA !== ownerB
        || current.status !== 'running'
        || current.lease_owner !== ownerA
        || current.lease_expires_at == null
      )) return null
      if (expectedA != null && (expectedA !== expectedB || current.status !== expectedA)) return null
      if (Number(requireUnleased) === 1 && current.lease_owner != null) return null
      if (current.status === 'success' && status !== 'success') return null
      current.status = status as PipelineStageRow['status']
      current.cursor_key = nextCursor == null ? current.cursor_key : String(nextCursor)
      current.lease_owner = null
      current.lease_expires_at = null
      return { status: current.status }
    }
    if (sql.includes('FROM pipeline_stage_runs')) {
      const stage = String(values[1])
      const current = this.rows.get(stage)
      return current ? { ...current } : null
    }
    throw new Error(`unsupported SQL: ${sql}`)
  }
}

class FakeQueue {
  messages: unknown[] = []
  async send(message: unknown) { this.messages.push(message) }
}

test('stale allocator callback A cannot supersede successful canonical B', async () => {
  const db = new FakeD1()
  db.rows.set('post_pipeline_chain', row('post_pipeline_chain', 'run-B', 'success'))
  const queue = new FakeQueue()
  const result = await queuePostPipelineStage({
    DB: db as unknown as D1Database,
    UPDATE_QUEUE: queue as unknown as Queue,
  }, {
    businessDate: '2026-08-14',
    runId: 'run-A',
    resumeWaiting: true,
    expectedCanonicalRunId: 'run-A',
  })
  assert.equal(result.canonicalRunId, 'run-B')
  assert.equal(result.queued, false)
  assert.equal(db.rows.get('post_pipeline_chain')?.canonical_run_id, 'run-B')
  assert.equal(queue.messages.length, 0)
})

test('expired worker A cannot finalize canonical B or a reclaimed same-run lease', async () => {
  const db = new FakeD1()
  db.rows.set('post_pipeline_chain', row('post_pipeline_chain', 'run-A', 'queued'))
  const claimed = await claimPipelineStage(db as unknown as D1Database, {
    businessDate: '2026-08-14',
    stage: 'post_pipeline_chain',
    canonicalRunId: 'run-A',
    ownerId: 'owner-A',
  })
  assert.equal(claimed?.lease_owner, 'owner-A')

  db.rows.set('post_pipeline_chain', {
    ...row('post_pipeline_chain', 'run-B', 'running'),
    lease_owner: 'owner-B',
  })
  assert.equal(await markPipelineStageFenced(db as unknown as D1Database, {
    businessDate: '2026-08-14', stage: 'post_pipeline_chain', canonicalRunId: 'run-A',
    leaseOwner: 'owner-A', status: 'success',
  }), false)
  assert.equal(db.rows.get('post_pipeline_chain')?.canonical_run_id, 'run-B')

  db.rows.set('post_pipeline_chain', {
    ...row('post_pipeline_chain', 'run-B', 'running'),
    lease_owner: 'owner-B2',
  })
  assert.equal(await markPipelineStageFenced(db as unknown as D1Database, {
    businessDate: '2026-08-14', stage: 'post_pipeline_chain', canonicalRunId: 'run-B',
    leaseOwner: 'owner-B', status: 'error',
  }), false)
  assert.equal(db.rows.get('post_pipeline_chain')?.status, 'running')
})

test('stale verify authority A cannot replace post-verify canonical B', async () => {
  const db = new FakeD1()
  db.rows.set('verify_v2', {
    ...row('verify_v2', 'run-B', 'success'),
    cursor_key: 'verify-B',
  })
  db.rows.set('post_verify_chain', row('post_verify_chain', 'run-B', 'success'))
  const result = await enqueuePipelineStageAuthorized(db as unknown as D1Database, {
    businessDate: '2026-08-14',
    stage: 'post_verify_chain',
    runId: 'run-A',
    authority: { stage: 'verify_v2', canonicalRunId: 'run-A', status: 'success', cursorKey: 'verify-A' },
  })
  assert.equal(result.shouldEnqueue, false)
  assert.equal(result.row.canonical_run_id, 'run-B')
})

function setupPostVerifyTakeover(status: StrategyLearningState['status'], leaseLive: boolean): FakeD1 {
  const db = new FakeD1()
  db.rows.set('verify_v2', {
    ...row('verify_v2', 'run-B', 'success'),
    cursor_key: 'verify-B',
  })
  db.rows.set('post_verify_chain', row('post_verify_chain', 'run-A', 'success'))
  db.strategyLearning = {
    canonicalRunId: 'run-A',
    status,
    leaseOwner: leaseLive ? 'strategy-owner-A' : null,
    leaseLive,
  }
  return db
}

test('post-verify B cannot supersede A while A strategy-learning lease is live', async () => {
  const db = setupPostVerifyTakeover('running', true)
  const result = await enqueuePipelineStageAuthorized(db as unknown as D1Database, {
    businessDate: '2026-08-14',
    stage: 'post_verify_chain',
    runId: 'run-B',
    authority: {
      stage: 'verify_v2',
      canonicalRunId: 'run-B',
      status: 'success',
      cursorKey: 'verify-B',
    },
  })
  assert.equal(result.shouldEnqueue, false)
  assert.equal(result.row.canonical_run_id, 'run-A')
  assert.equal(result.row.status, 'success')
})

test('post-verify B can supersede A after strategy-learning finalized', async () => {
  const db = setupPostVerifyTakeover('success', false)
  const result = await enqueuePipelineStageAuthorized(db as unknown as D1Database, {
    businessDate: '2026-08-14',
    stage: 'post_verify_chain',
    runId: 'run-B',
    authority: {
      stage: 'verify_v2',
      canonicalRunId: 'run-B',
      status: 'success',
      cursorKey: 'verify-B',
    },
  })
  assert.equal(result.shouldEnqueue, true)
  assert.equal(result.row.canonical_run_id, 'run-B')
  assert.equal(result.row.status, 'queued')
})

test('post-verify B can supersede A after strategy-learning lease expired', async () => {
  const db = setupPostVerifyTakeover('running', false)
  const result = await enqueuePipelineStageAuthorized(db as unknown as D1Database, {
    businessDate: '2026-08-14',
    stage: 'post_verify_chain',
    runId: 'run-B',
    authority: {
      stage: 'verify_v2',
      canonicalRunId: 'run-B',
      status: 'success',
      cursorKey: 'verify-B',
    },
  })
  assert.equal(result.shouldEnqueue, true)
  assert.equal(result.row.canonical_run_id, 'run-B')
  assert.equal(result.row.status, 'queued')
})

test('post-verify B cannot supersede successful A until strict telemetry releases its live strategy lease', async () => {
  const db = setupPostVerifyTakeover('success', true)
  const result = await enqueuePipelineStageAuthorized(db as unknown as D1Database, {
    businessDate: '2026-08-14',
    stage: 'post_verify_chain',
    runId: 'run-B',
    authority: {
      stage: 'verify_v2',
      canonicalRunId: 'run-B',
      status: 'success',
      cursorKey: 'verify-B',
    },
  })
  assert.equal(result.shouldEnqueue, false)
  assert.equal(result.row.canonical_run_id, 'run-A')
})

test('generic post-verify adopt and supersede cannot bypass a live strategy-learning lease', async () => {
  for (const status of ['waiting', 'success'] as const) {
    const db = new FakeD1()
    db.rows.set('post_verify_chain', row('post_verify_chain', 'run-A', status))
    db.strategyLearning = {
      canonicalRunId: 'run-A',
      status: 'success',
      leaseOwner: 'strategy-owner-A',
      leaseLive: true,
    }
    const queue = new FakeQueue()
    const result = await queuePostVerifyStage({
      DB: db as unknown as D1Database,
      UPDATE_QUEUE: queue as unknown as Queue,
    }, {
      businessDate: '2026-08-14',
      runId: 'run-B',
      adoptRunIdOnResume: true,
      supersedeSuccess: true,
    })
    assert.equal(result.queued, false)
    assert.equal(result.canonicalRunId, 'run-A')
    assert.equal(queue.messages.length, 0)
  }
})

test('generic post-verify takeover resumes after the prior strategy lease is released or expired', async () => {
  for (const leaseLive of [false]) {
    const db = new FakeD1()
    db.rows.set('post_verify_chain', row('post_verify_chain', 'run-A', 'success'))
    db.strategyLearning = {
      canonicalRunId: 'run-A',
      status: 'success',
      leaseOwner: leaseLive ? 'strategy-owner-A' : null,
      leaseLive,
    }
    const queue = new FakeQueue()
    const result = await queuePostVerifyStage({
      DB: db as unknown as D1Database,
      UPDATE_QUEUE: queue as unknown as Queue,
    }, {
      businessDate: '2026-08-14',
      runId: 'run-B',
      supersedeSuccess: true,
    })
    assert.equal(result.queued, true)
    assert.equal(result.canonicalRunId, 'run-B')
    assert.equal(queue.messages.length, 1)
  }
})

test('missing post-verify stage cannot be re-established under a foreign live strategy lease', async () => {
  const db = new FakeD1()
  db.strategyLearning = {
    canonicalRunId: 'run-A',
    status: 'success',
    leaseOwner: 'strategy-owner-A',
    leaseLive: true,
  }
  const queue = new FakeQueue()
  await assert.rejects(queuePostVerifyStage({
    DB: db as unknown as D1Database,
    UPDATE_QUEUE: queue as unknown as Queue,
  }, {
    businessDate: '2026-08-14',
    runId: 'run-B',
  }), /pipeline_stage_state_missing/)
  assert.equal(queue.messages.length, 0)
})

test('queue send ambiguous failure cannot overwrite a stage already claimed by the consumer', async () => {
  const db = new FakeD1()
  const queue = {
    async send() {
      const current = db.rows.get('post_pipeline_chain')
      if (!current) throw new Error('stage missing before simulated delivery')
      current.status = 'running'
      current.lease_owner = 'consumer-B'
      current.lease_expires_at = '2099-01-01 00:00:00'
      throw new Error('ambiguous queue acknowledgement')
    },
  }
  await assert.rejects(queuePostPipelineStage({
    DB: db as unknown as D1Database,
    UPDATE_QUEUE: queue as unknown as Queue,
  }, {
    businessDate: '2026-08-14',
    runId: 'run-A',
  }), /ambiguous queue acknowledgement/)
  assert.equal(db.rows.get('post_pipeline_chain')?.status, 'running')
  assert.equal(db.rows.get('post_pipeline_chain')?.lease_owner, 'consumer-B')
})
