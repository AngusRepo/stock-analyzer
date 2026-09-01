import assert from 'node:assert/strict'
import {
  assertStrategyLearningLease,
  checkpointStrategyLearningPage,
  claimStrategyLearningPage,
  completeStrategyLearningRun,
  deferStrategyLearningFinalizer,
  failStrategyLearningRun,
  heartbeatStrategyLearningLease,
  hasStrategyLearningPostVerifyAuthority,
  initializeStrategyLearningRun,
  isStrategyLearningLeaseLost,
  loadStrategyLearningRun,
  markStrategyLearningRunFinalized,
  reclaimStrategyLearningFinalizedLease,
  releaseStrategyLearningFinalizedLease,
  startStrategyLearningLeaseHeartbeat,
  type StrategyLearningRunRow,
} from './strategyLearningRunState'
import { runStrategyLearningFinalizerStage } from './strategyLearning'

const NOW = '2026-08-15 00:00:00'
const FUTURE = '2026-08-15 00:15:00'

function runRow(input: Partial<StrategyLearningRunRow> = {}): StrategyLearningRunRow {
  return {
    business_date: '2026-08-14',
    canonical_run_id: 'canonical-run',
    producer_run_id: 'producer-run',
    status: 'running',
    cursor_symbol: '2330',
    expected_candidates: 2,
    processed_candidates: 2,
    strategy_count: 2,
    expected_decision_rows: 4,
    persisted_decision_rows: 4,
    lease_owner: 'lease-a',
    lease_expires_at: FUTURE,
    completed_at: null,
    production_authority_intent: 0,
    policy_closure_status: 'evidence_only',
    policy_closure_reason: 'historical_replay:test',
    policy_closure_completed_at: NOW,
    ...input,
  }
}

class FakeStatement {
  private values: unknown[] = []

  constructor(
    private readonly db: FakeStrategyLearningD1,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]): FakeStatement {
    this.values = values
    return this
  }

  async first<T>(): Promise<T | null> {
    return this.db.first(this.sql, this.values) as T | null
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: this.db.run(this.sql, this.values) } }
  }
}

class FakeStrategyLearningD1 {
  constructor(
    public row: StrategyLearningRunRow | null,
    public postVerifyCanonicalRunId = 'canonical-run',
  ) {}

  universeProducerRunId = 'producer-run'
  universeExpectedCandidates = 2

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql)
  }

  private leaseMatches(
    businessDate: string, canonicalRunId: string, leaseOwner: string, statuses = ['running'],
  ): boolean {
    return Boolean(
      this.row
      && this.row.business_date === businessDate
      && this.row.canonical_run_id === canonicalRunId
      && statuses.includes(this.row.status)
      && this.row.lease_owner === leaseOwner
      && this.row.lease_expires_at
      && this.row.lease_expires_at >= NOW,
    )
  }

  first(sql: string, values: unknown[]): StrategyLearningRunRow
    | { candidate_rows: number; decision_rows: number }
    | { authorized: number }
    | { producer_run_id: string; expected_candidates: number }
    | Record<string, number>
    | null {
    if (sql.includes('FROM selection_reference_snapshots_v1')) {
      return {
        producer_run_id: this.universeProducerRunId,
        expected_candidates: this.universeExpectedCandidates,
      }
    }
    if (sql.includes('UPDATE strategy_learning_runs') && sql.includes('RETURNING business_date')) {
      assert.match(sql, /WHERE business_date=\? AND canonical_run_id=\?/)
      const [leaseOwner, , businessDate, canonicalRunId, cursorSymbol] = values.map(String)
      const leaseAvailable = this.row?.lease_owner == null
        || Boolean(this.row?.lease_expires_at && this.row.lease_expires_at < NOW)
        || this.row?.lease_owner === leaseOwner
      if (
        !this.row
        || this.row.business_date !== businessDate
        || this.row.canonical_run_id !== canonicalRunId
        || !['queued', 'running'].includes(this.row.status)
        || String(this.row.cursor_symbol ?? '') !== cursorSymbol
        || !leaseAvailable
      ) return null
      this.row = { ...this.row, status: 'running', lease_owner: leaseOwner, lease_expires_at: FUTURE }
      return { ...this.row }
    }

    const returnedAlias = sql.match(/RETURNING 1 AS (\w+)/)?.[1]
    if (sql.includes('UPDATE strategy_learning_runs') && returnedAlias) {
      const changes = this.run(sql, values)
      return changes === 1 ? { [returnedAlias]: 1 } : null
    }

    if (sql.includes('SELECT 1 AS authorized') && sql.includes('FROM pipeline_stage_runs')) {
      const [businessDate, canonicalRunId] = values.map(String)
      if (businessDate !== this.row?.business_date || canonicalRunId !== this.postVerifyCanonicalRunId) return null
      return { authorized: 1 }
    }

    if (sql.includes('FROM strategy_learning_runs')) {
      return this.row ? { ...this.row } : null
    }

    if (sql.includes('FROM strategy_decision_log')) {
      return {
        candidate_rows: Number(this.row?.processed_candidates ?? 0),
        decision_rows: Number(this.row?.persisted_decision_rows ?? 0),
      }
    }

    throw new Error(`unsupported first SQL: ${sql}`)
  }

  run(sql: string, values: unknown[]): number {
    if (sql.includes('INSERT INTO strategy_learning_runs')) {
      assert.match(sql, /ON CONFLICT\(business_date\) DO UPDATE SET/)
      assert.match(sql, /WHERE strategy_learning_runs\.status<>'success'/)
      if (this.row?.status === 'success') return 0
      throw new Error(`unsupported non-finalized initialize SQL: ${sql}`)
    }

    assert.match(sql, /WHERE business_date=\? AND canonical_run_id=\?/)
    assert.match(sql, /lease_owner=\?/)

    if (sql.includes("status='success' AND completed_at IS NOT NULL") && sql.includes('lease_expires_at < CURRENT_TIMESTAMP')) {
      assert.match(sql, /lease_owner IS NOT NULL/)
      assert.match(sql, /FROM pipeline_stage_runs p/)
      const [, businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (
        this.row?.business_date !== businessDate
        || this.row.canonical_run_id !== canonicalRunId
        || this.row.status !== 'success'
        || !this.row.completed_at
        || this.row.lease_owner !== leaseOwner
        || !this.row.lease_expires_at
        || this.row.lease_expires_at >= NOW
        || this.postVerifyCanonicalRunId !== canonicalRunId
      ) return 0
      this.row = { ...this.row, lease_expires_at: FUTURE }
      return 1
    }

    assert.match(sql, /lease_expires_at >= CURRENT_TIMESTAMP/)

    if (sql.includes("SET lease_expires_at=datetime('now', ?)")) {
      assert.match(sql, /status IN \('running', 'success'\)/)
      const [, businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (!this.leaseMatches(businessDate, canonicalRunId, leaseOwner, ['running', 'success'])) return 0
      this.row = { ...this.row!, lease_expires_at: FUTURE }
      return 1
    }

    if (sql.includes("SET status='queued', cursor_symbol=?")) {
      const [nextCursor, processed, persisted, businessDate, canonicalRunId, leaseOwner, previousCursor] = values
      if (
        !this.leaseMatches(String(businessDate), String(canonicalRunId), String(leaseOwner))
        || String(this.row?.cursor_symbol ?? '') !== String(previousCursor)
      ) return 0
      this.row = {
        ...this.row!,
        status: 'queued',
        cursor_symbol: String(nextCursor),
        processed_candidates: Number(this.row!.processed_candidates) + Number(processed),
        persisted_decision_rows: Number(this.row!.persisted_decision_rows) + Number(persisted),
        lease_owner: null,
        lease_expires_at: null,
      }
      return 1
    }

    if (sql.includes("SET status='running', processed_candidates=?")) {
      const [candidateRows, decisionRows, , businessDate, canonicalRunId, leaseOwner] = values
      if (!this.leaseMatches(String(businessDate), String(canonicalRunId), String(leaseOwner))) return 0
      this.row = {
        ...this.row!,
        processed_candidates: Number(candidateRows),
        persisted_decision_rows: Number(decisionRows),
        lease_expires_at: FUTURE,
      }
      return 1
    }

    if (sql.includes("SET status='success'")) {
      assert.match(sql, /FROM pipeline_stage_runs p/)
      const [businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (
        !this.leaseMatches(businessDate, canonicalRunId, leaseOwner)
        || this.row!.processed_candidates !== this.row!.expected_candidates
        || this.row!.persisted_decision_rows !== this.row!.expected_decision_rows
        || this.postVerifyCanonicalRunId !== canonicalRunId
      ) return 0
      this.row = {
        ...this.row!,
        status: 'success',
        lease_owner: String(leaseOwner),
        lease_expires_at: FUTURE,
        completed_at: NOW,
      }
      return 1
    }

    if (sql.includes("SET status='queued', lease_owner=NULL")) {
      const [, businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (!this.leaseMatches(businessDate, canonicalRunId, leaseOwner)) return 0
      this.row = { ...this.row!, status: 'queued', lease_owner: null, lease_expires_at: null }
      return 1
    }

    if (sql.includes("SET status='error'")) {
      const [, businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (!this.leaseMatches(businessDate, canonicalRunId, leaseOwner)) return 0
      this.row = { ...this.row!, status: 'error', lease_owner: null, lease_expires_at: null }
      return 1
    }

    if (sql.includes('SET lease_owner=NULL, lease_expires_at=NULL')) {
      assert.match(sql, /status='success' AND completed_at IS NOT NULL/)
      assert.match(sql, /FROM pipeline_stage_runs p/)
      const [businessDate, canonicalRunId, leaseOwner] = values.map(String)
      if (
        !this.leaseMatches(businessDate, canonicalRunId, leaseOwner, ['success'])
        || !this.row?.completed_at
        || this.postVerifyCanonicalRunId !== canonicalRunId
      ) return 0
      this.row = { ...this.row!, lease_owner: null, lease_expires_at: null }
      return 1
    }

    throw new Error(`unsupported run SQL: ${sql}`)
  }
}

const asD1 = (db: FakeStrategyLearningD1): D1Database => db as unknown as D1Database

async function testCanonicalTakeoverRejectsLateOwner(): Promise<void> {
  const db = new FakeStrategyLearningD1(runRow({ lease_expires_at: '2026-08-14 23:59:59' }))
  const claimed = await claimStrategyLearningPage(asD1(db), {
    businessDate: '2026-08-14',
    canonicalRunId: 'canonical-run',
    leaseOwner: 'lease-b',
    cursorSymbol: '2330',
  })
  assert.equal(claimed?.lease_owner, 'lease-b')

  const lateA = { businessDate: '2026-08-14', canonicalRunId: 'canonical-run', leaseOwner: 'lease-a' }
  assert.equal(await completeStrategyLearningRun(asD1(db), lateA), null)
  assert.equal(await checkpointStrategyLearningPage(asD1(db), {
    ...lateA,
    previousCursor: '2330',
    nextCursor: '2454',
    processedCandidates: 1,
    persistedRows: 2,
  }), false)
  assert.equal(await markStrategyLearningRunFinalized(asD1(db), lateA), false)
  assert.equal(await deferStrategyLearningFinalizer(asD1(db), { ...lateA, error: 'late-a' }), false)
  assert.equal(await failStrategyLearningRun(asD1(db), { ...lateA, error: 'late-a' }), false)
  assert.equal(db.row?.status, 'running')
  assert.equal(db.row?.lease_owner, 'lease-b')

  const ownerB = { ...lateA, leaseOwner: 'lease-b' }
  assert.equal(await markStrategyLearningRunFinalized(asD1(db), ownerB), true)
  assert.equal(db.row?.status, 'success')
  assert.equal(db.row?.lease_owner, 'lease-b')
  assert.equal(await hasStrategyLearningPostVerifyAuthority(asD1(db), ownerB), true)
  assert.equal(await releaseStrategyLearningFinalizedLease(asD1(db), lateA), false)
  assert.equal(await releaseStrategyLearningFinalizedLease(asD1(db), ownerB), true)
  assert.equal(db.row?.lease_owner, null)
}

async function testCanonicalIdentityIsRequiredToClaim(): Promise<void> {
  const db = new FakeStrategyLearningD1(runRow({
    canonical_run_id: 'new-canonical',
    status: 'queued',
    lease_owner: null,
    lease_expires_at: null,
  }))
  const claimed = await claimStrategyLearningPage(asD1(db), {
    businessDate: '2026-08-14',
    canonicalRunId: 'old-canonical',
    leaseOwner: 'late-owner',
    cursorSymbol: '2330',
  })
  assert.equal(claimed, null)
  assert.equal(db.row?.canonical_run_id, 'new-canonical')
  assert.equal(db.row?.lease_owner, null)
}

async function testPostVerifyTakeoverBlocksLateStrategyFinalize(): Promise<void> {
  const db = new FakeStrategyLearningD1(runRow(), 'pipeline-b')
  const ownerA = { businessDate: '2026-08-14', canonicalRunId: 'canonical-run', leaseOwner: 'lease-a' }
  const rootBefore = { status: 'running', runId: 'pipeline-b' }
  assert.equal(await markStrategyLearningRunFinalized(asD1(db), ownerA), false)
  assert.equal(db.row?.status, 'running')
  assert.equal(db.row?.lease_owner, 'lease-a')
  assert.deepEqual(rootBefore, { status: 'running', runId: 'pipeline-b' })
}

async function testFinalizedLeaseReleaseRequiresCurrentPostVerifyAuthority(): Promise<void> {
  const db = new FakeStrategyLearningD1(runRow({
    status: 'success',
    completed_at: NOW,
  }), 'pipeline-b')
  const ownerA = { businessDate: '2026-08-14', canonicalRunId: 'canonical-run', leaseOwner: 'lease-a' }
  assert.equal(await hasStrategyLearningPostVerifyAuthority(asD1(db), ownerA), false)
  assert.equal(await heartbeatStrategyLearningLease(asD1(db), ownerA), true)
  assert.equal(await releaseStrategyLearningFinalizedLease(asD1(db), ownerA), false)
  assert.equal(db.row?.status, 'success')
  assert.equal(db.row?.lease_owner, 'lease-a')
}

async function testExpiredFinalizedLeaseCanOnlyBeReclaimedByCurrentAuthority(): Promise<void> {
  const ownerA = { businessDate: '2026-08-14', canonicalRunId: 'canonical-run', leaseOwner: 'lease-a' }
  const db = new FakeStrategyLearningD1(runRow({
    status: 'success',
    completed_at: NOW,
    lease_expires_at: '2026-08-14 23:59:59',
  }))
  assert.equal(await heartbeatStrategyLearningLease(asD1(db), ownerA), false)
  assert.equal(await reclaimStrategyLearningFinalizedLease(asD1(db), ownerA), true)
  assert.equal(db.row?.lease_expires_at, FUTURE)
  assert.equal(await releaseStrategyLearningFinalizedLease(asD1(db), ownerA), true)

  const takenOver = new FakeStrategyLearningD1(runRow({
    status: 'success',
    completed_at: NOW,
    lease_expires_at: '2026-08-14 23:59:59',
  }), 'pipeline-b')
  assert.equal(await reclaimStrategyLearningFinalizedLease(asD1(takenOver), ownerA), false)
  assert.equal(takenOver.row?.lease_expires_at, '2026-08-14 23:59:59')

  const legacy = new FakeStrategyLearningD1(runRow({
    status: 'success',
    completed_at: NOW,
    lease_owner: null,
    lease_expires_at: null,
  }))
  assert.equal(await reclaimStrategyLearningFinalizedLease(asD1(legacy), ownerA), false)
}

async function testInitializeCannotMutateConcurrentlyFinalizedRun(): Promise<void> {
  const db = new FakeStrategyLearningD1(runRow({
    status: 'running',
    lease_owner: 'lease-a',
  }))
  const initiallyLoaded = await loadStrategyLearningRun(asD1(db), '2026-08-14')
  assert.equal(initiallyLoaded?.status, 'running')

  db.row = runRow({
    canonical_run_id: 'canonical-finalized',
    producer_run_id: 'producer-finalized',
    status: 'success',
    cursor_symbol: 'final-symbol',
    expected_candidates: 2,
    processed_candidates: 2,
    strategy_count: 2,
    expected_decision_rows: 4,
    persisted_decision_rows: 4,
    lease_owner: 'finalized-owner',
    lease_expires_at: FUTURE,
    completed_at: NOW,
  })
  const finalizedSnapshot = { ...db.row }
  db.universeProducerRunId = 'producer-new'
  db.universeExpectedCandidates = 99

  const initialized = await initializeStrategyLearningRun(asD1(db), {
    businessDate: '2026-08-14',
    runId: 'new-run-must-not-replace-finalized',
    strategyCount: 9,
  })
  assert.deepEqual(initialized, finalizedSnapshot)
  assert.deepEqual(db.row, finalizedSnapshot)
}

async function testHeartbeatIsOwnerFencedAndFailClosed(): Promise<void> {
  const db = new FakeStrategyLearningD1(runRow())
  const ownerA = { businessDate: '2026-08-14', canonicalRunId: 'canonical-run', leaseOwner: 'lease-a' }
  assert.equal(await heartbeatStrategyLearningLease(asD1(db), ownerA), true)
  assert.equal(await heartbeatStrategyLearningLease(asD1(db), { ...ownerA, leaseOwner: 'lease-b' }), false)
  db.row = runRow({ lease_expires_at: '2026-08-14 23:59:59' })
  assert.equal(await heartbeatStrategyLearningLease(asD1(db), ownerA), false)
  await assert.rejects(
    assertStrategyLearningLease(asD1(db), ownerA),
    (error: unknown) => isStrategyLearningLeaseLost(error),
  )
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

async function testPeriodicHeartbeatKeepsLongStageLeaseAlive(): Promise<void> {
  let timerCallback: (() => void) | null = null
  let timerCleared = false
  let nowSeconds = 0
  let leaseExpiresAtSeconds = 900
  let heartbeatCount = 0
  const controller = startStrategyLearningLeaseHeartbeat({} as D1Database, {
    businessDate: '2026-08-14',
    canonicalRunId: 'canonical-run',
    leaseOwner: 'lease-a',
  }, {
    intervalMs: 60_000,
    heartbeat: async () => {
      heartbeatCount += 1
      if (nowSeconds > leaseExpiresAtSeconds) return false
      leaseExpiresAtSeconds = nowSeconds + 900
      return true
    },
    setIntervalFn: (callback) => {
      timerCallback = callback
      return 1
    },
    clearIntervalFn: () => {
      timerCleared = true
    },
  })
  await controller.assertActive()
  for (let minute = 1; minute <= 16; minute += 1) {
    nowSeconds = minute * 60
    timerCallback!()
    await flushPromises()
    assert.ok(leaseExpiresAtSeconds > nowSeconds)
  }
  assert.equal(nowSeconds, 960)
  assert.ok(heartbeatCount >= 17)
  await controller.stop()
  assert.equal(timerCleared, true)
}

async function testHeartbeatFailureBlocksPolicyAndTelemetryStage(): Promise<void> {
  let timerCallback: (() => void) | null = null
  const controller = startStrategyLearningLeaseHeartbeat({} as D1Database, {
    businessDate: '2026-08-14',
    canonicalRunId: 'canonical-run',
    leaseOwner: 'lease-a',
  }, {
    heartbeat: async () => false,
    setIntervalFn: (callback) => {
      timerCallback = callback
      return 1
    },
    clearIntervalFn: () => {},
  })
  timerCallback!()
  await flushPromises()
  let policyWrites = 0
  let telemetryWrites = 0
  await assert.rejects(runStrategyLearningFinalizerStage(
    'adaptive_policy',
    async () => { policyWrites += 1 },
    {
      assertLease: async () => controller.assertActive(),
      onStageTransition: async () => { telemetryWrites += 1 },
    },
  ), (error: unknown) => isStrategyLearningLeaseLost(error))
  assert.equal(policyWrites, 0)
  assert.equal(telemetryWrites, 0)
  await controller.stop()
}

async function main(): Promise<void> {
  await testCanonicalTakeoverRejectsLateOwner()
  await testCanonicalIdentityIsRequiredToClaim()
  await testPostVerifyTakeoverBlocksLateStrategyFinalize()
  await testFinalizedLeaseReleaseRequiresCurrentPostVerifyAuthority()
  await testExpiredFinalizedLeaseCanOnlyBeReclaimedByCurrentAuthority()
  await testInitializeCannotMutateConcurrentlyFinalizedRun()
  await testHeartbeatIsOwnerFencedAndFailClosed()
  await testPeriodicHeartbeatKeepsLongStageLeaseAlive()
  await testHeartbeatFailureBlocksPolicyAndTelemetryStage()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
