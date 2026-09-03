import { adminOptunaRoutes } from '../routes/adminOptunaRoutes'
import type { Bindings } from '../types'
import { DEFAULT_TRADING_CONFIG } from './tradingConfig'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

class FakeKV {
  store = new Map<string, string>()

  async get(key: string, mode?: string) {
    const raw = this.store.get(key)
    if (!raw) return null
    return mode === 'json' ? JSON.parse(raw) : raw
  }

  async put(key: string, value: string) {
    this.store.set(key, value)
  }
}

class FakeStatement {
  values: unknown[] = []

  constructor(private readonly db: FakeDB, private readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values
    return this
  }

  async run() {
    this.db.runs.push({ sql: this.sql, values: this.values })
    if (this.sql.includes('INSERT INTO ga_optimizer_shadow_candidates_v1')) {
      const [
        shadowId,
        candidateRegistryId,
        gaCandidateId,
        candidateConfigJson,
        candidateConfigChecksum,
        baselineConfigJson,
        baselineConfigChecksum,
        evaluatorVersion,
        enrolledBusinessDate,
        enrollmentSnapshotId,
        enrollmentSnapshotChecksum,
        sourceRunId,
        sourceCadence,
      ] = this.values
      const exists = this.db.shadowRows.some((row) =>
        row.ga_candidate_id === gaCandidateId &&
        row.candidate_config_checksum === candidateConfigChecksum &&
        row.baseline_config_checksum === baselineConfigChecksum &&
        row.enrolled_business_date === enrolledBusinessDate &&
        row.source_run_id === sourceRunId
      )
      if (!exists) {
        this.db.shadowRows.push({
          shadow_id: shadowId,
          candidate_registry_id: candidateRegistryId,
          ga_candidate_id: gaCandidateId,
          status: this.db.shadowRows.some((row) => row.status === 'ACTIVE') ? 'QUEUED' : 'ACTIVE',
          candidate_config_json: candidateConfigJson,
          candidate_config_checksum: candidateConfigChecksum,
          baseline_config_json: baselineConfigJson,
          baseline_config_checksum: baselineConfigChecksum,
          evaluator_version: evaluatorVersion,
          enrolled_business_date: enrolledBusinessDate,
          enrollment_snapshot_id: enrollmentSnapshotId,
          enrollment_snapshot_checksum: enrollmentSnapshotChecksum,
          source_run_id: sourceRunId,
          source_cadence: sourceCadence,
        })
      }
    }
    return { success: true }
  }

  async first() {
    if (this.sql.includes('FROM ga_optimizer_shadow_candidates_v1') && this.sql.includes('ga_candidate_id=?')) {
      const [candidateId, candidateChecksum, baselineChecksum, enrolledDate, sourceRunId] = this.values
      return this.db.shadowRows.find((row) =>
        row.ga_candidate_id === candidateId &&
        row.candidate_config_checksum === candidateChecksum &&
        row.baseline_config_checksum === baselineChecksum &&
        row.enrolled_business_date === enrolledDate &&
        row.source_run_id === sourceRunId
      ) ?? null
    }
    if (this.sql.includes('FROM ga_optimizer_shadow_candidates_v1') && this.sql.includes("status='ACTIVE'")) {
      return this.db.shadowRows.find((row) => row.status === 'ACTIVE') ?? null
    }
    return null
  }
}

class FakeDB {
  runs: Array<{ sql: string; values: unknown[] }> = []
  batches: string[][] = []
  shadowRows: any[] = []

  prepare(sql: string) {
    return new FakeStatement(this, sql)
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements.map((stmt) => (stmt as any).sql))
    return statements.map(() => ({ success: true }))
  }
}

const env = {
  DB: new FakeDB(),
  LEARNING_DB: new FakeDB(),
  KV: new FakeKV(),
  MULTI_D1_ACTIVE_DOMAINS: 'learning',
  MULTI_D1_STRICT: 'true',
  STOCKVISION_AUTH_TOKEN: 'service-token',
} as unknown as Bindings

void (async () => {
  const originalTradingConfig = JSON.stringify(DEFAULT_TRADING_CONFIG)
  ;(env.KV as any).store.set('trading:config', originalTradingConfig)

  const res = await adminOptunaRoutes.request('/api/admin/optuna-push', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'ga_optimizer',
      params: {
        optimizer: 'GAOptimizer',
        status: 'learning',
        validation: { status: 'completed', decision: 'PASS', evidence_clock: { look_ahead_check: 'PASS' } },
        history: [
          { generation: 0, best_score: 1.0 },
          { generation: 1, best_score: 1.2 },
        ],
        best: {
          score: 1.2,
          candidate: { id: 'ga_optimizer:g1:c1' },
          metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120, look_ahead_check: 'PASS' },
          gate: { decision: 'PASS', passed: true, failed_gates: [], checks: { pbo: true, monte_carlo_mdd_95th: true } },
        },
        best_alphaFramework: {
          riskOverlay: { highVolThreshold: 0.045 },
          allocation: { weights: { bull: { trend_following: 0.5 } } },
        },
      },
      meta: { best_score: 1.2, run_id: 'ga-push-test-1', run_date: '2026-09-02', cadence: 'weekly' },
    }),
  }, env)

  assert(res.status === 200, 'ga_optimizer push should be accepted')
  const body = await res.json() as any
  assert(body.target === 'production_meta_optimizer_learning_state', 'ga_optimizer should write production learning state, not sandbox')
  assert(body.updatedKeys.includes('optimizer:ga:latest'), 'ga_optimizer should update latest learning key')
  assert(body.kv_readback_ok === true, 'ga_optimizer push should read back latest KV state')
  assert(body.updatedKeys.includes('optimizer:ga:candidate:latest'), 'ga_optimizer should update canonical candidate key')
  assert(body.candidate_record?.candidate_id?.startsWith('parameter:ga_optimizer:'), 'ga_optimizer push should persist a D1 parameter candidate record')
  assert(body.candidate_evidence_record?.status === 'EVIDENCE_INSUFFICIENT', 'new GA candidate must remain evidence-insufficient before prospective shadow maturity')
  assert(body.candidate_evidence_record?.promotion_packet_id == null, 'new GA candidate must not mint a final promotion packet before prospective maturity')
  assert(body.promotion.level === 'L1', 'gate-passing GA state must remain L1 until its frozen prospective shadow passes')
  assert(body.promotion.approvalRequiredForNextLevel === false, 'GA promotion must be evidence-driven without manual approval')
  assert(body.promotion.canRequestNextLevel === false, 'manual review must not bypass GA candidate-specific evidence')
  assert(body.shadow_enrollment?.status === 'ACTIVE', 'first frozen GA challenger should become active')
  assert(body.materialization_complete === true, 'GA push must close candidate, evidence, and frozen shadow materialization')

  const latest = JSON.parse((env.KV as any).store.get('optimizer:ga:candidate:latest'))
  assert(latest.status === 'review_candidate', 'latest GA state should expose its evidence-derived L1 status')
  assert(latest.promotion.nextAction.includes('prospective'), 'latest GA state should explain the next automatic evidence requirement')
  assert(latest.production_learning_loop === true, 'GA must be a production learning loop')
  assert(latest.mutates_trading_config === false, 'GA learning push must not mutate trading:config')
  assert(latest.best_alphaFramework.riskOverlay.highVolThreshold === 0.045, 'latest GA state should preserve learned policy')
  assert((env.KV as any).store.get('trading:config') === originalTradingConfig, 'ga_optimizer push must not mutate formal trading:config')
  assert((env.KV as any).store.has('optimizer:ga:shadow:active'), 'active frozen challenger must be materialized')
  const evidenceRun = (env.LEARNING_DB as any).runs.find((run: any) =>
    String(run.sql).includes('parameter_candidate_evidence') &&
    String(run.values?.[1]) === 'ga_optimizer_policy_packet_validation'
  )
  assert(evidenceRun, 'ga_optimizer push should persist candidate-specific validation evidence')
  assert((env.DB as any).runs.length === 0, 'GA registry must not write the legacy main D1 owner')
  assert(String(evidenceRun.values?.[3]).includes('"sandbox_config_required":false'), 'GA validation evidence must not depend on sandbox config state')
  assert(String(evidenceRun.values?.[3]).includes('"mutates_trading_config":false'), 'GA validation evidence must preserve no trading config mutation boundary')
  assert(String(evidenceRun.values?.[3]).includes('"promotion_mode":"automatic_candidate_specific_evidence"'), 'GA evidence must declare automatic evidence-driven promotion')

  assert(!(env.KV as any).store.has('optimizer:ga:champion'), 'a new challenger must not release before prospective maturity')
  const secondPush = await adminOptunaRoutes.request('/api/admin/optuna-push', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'ga_optimizer',
      params: {
        optimizer: 'GAOptimizer',
        status: 'learning',
        validation: { status: 'completed', decision: 'PASS', evidence_clock: { look_ahead_check: 'PASS' } },
        history: [
          { generation: 0, best_score: 1.0 },
          { generation: 1, best_score: 1.25 },
        ],
        best: {
          score: 1.25,
          candidate: { id: 'ga_optimizer:g2:c1' },
          metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120, look_ahead_check: 'PASS' },
          gate: { decision: 'PASS', passed: true, failed_gates: [], checks: { pbo: true, monte_carlo_mdd_95th: true } },
        },
        best_alphaFramework: {
          riskOverlay: { highVolThreshold: 0.04 },
          allocation: { weights: { bull: { trend_following: 0.55 } } },
        },
      },
      meta: { best_score: 1.25, run_id: 'ga-push-test-2', run_date: '2026-09-02', cadence: 'weekly' },
    }),
  }, env)
  assert(secondPush.status === 200, 'GA push after L3 approval should be accepted')
  const secondBody = await secondPush.json() as any
  assert(secondBody.promotion.level === 'L1', 'new GA candidate must start from its own evidence-derived ladder')
  assert(secondBody.promotion.nextLevel === 'L2', 'new candidate should expose its own next evidence step')
  assert(secondBody.shadow_enrollment?.status === 'QUEUED', 'new challenger must queue behind the active frozen cohort')
  const currentCandidate = JSON.parse((env.KV as any).store.get('optimizer:ga:candidate:latest'))
  assert(currentCandidate.best.score === 1.25, 'candidate key should advance to the new weekly candidate')
  assert(secondBody.champion_key === 'optimizer:ga:champion', 'push response should expose champion lineage')
  assert((env.KV as any).store.get('trading:config') === originalTradingConfig, 'queued candidate must not mutate formal trading config')
})()

class ReadbackFailKV extends FakeKV {
  async get(key: string, mode?: string) {
    if (key === 'optimizer:ga:candidate:latest' && this.store.has(key)) {
      return null
    }
    return super.get(key, mode)
  }
}

const brokenEnv = {
  DB: new FakeDB(),
  LEARNING_DB: new FakeDB(),
  KV: new ReadbackFailKV(),
  MULTI_D1_ACTIVE_DOMAINS: 'learning',
  MULTI_D1_STRICT: 'true',
  STOCKVISION_AUTH_TOKEN: 'service-token',
} as unknown as Bindings

void (async () => {
  ;(brokenEnv.KV as any).store.set('trading:config', JSON.stringify(DEFAULT_TRADING_CONFIG))

  const res = await adminOptunaRoutes.request('/api/admin/optuna-push', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source: 'ga_optimizer',
      params: {
        optimizer: 'GAOptimizer',
        status: 'learning',
        validation: { status: 'completed', decision: 'FAIL' },
        history: [
          { generation: 0, best_score: 1.0 },
          { generation: 1, best_score: 1.1 },
        ],
        best: {
          score: 1.1,
          candidate: { id: 'ga_optimizer:broken:c1' },
          metrics: { pbo: 0.6, mdd_95th: 0.3, sharpe: 0.2, trade_count: 20, look_ahead_check: 'PASS' },
          gate: { decision: 'REJECT', passed: false, failed_gates: ['pbo'] },
        },
        best_alphaFramework: {
          riskOverlay: { highVolThreshold: 0.05 },
          allocation: { weights: { bull: { trend_following: 0.4 } } },
        },
      },
      meta: { run_id: 'readback-fail-test', run_date: '2026-09-02', cadence: 'weekly' },
    }),
  }, brokenEnv)

  assert(res.status === 503, 'GA push must fail closed when canonical candidate KV readback fails')
  const body = await res.json() as any
  assert(body.success === false, 'incomplete GA materialization must not report success')
  assert(body.materialization_complete === false, 'incomplete GA materialization must be explicit')
  assert(body.materialization_checks.kv_readback === false, 'failed KV readback must be named')
})()
