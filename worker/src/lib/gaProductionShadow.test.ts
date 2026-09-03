import assert from 'node:assert/strict'
import {
  GA_SHADOW_EVALUATOR_VERSION,
  buildGaShadowMaturity,
  enrollGaProductionShadowCandidate,
  refreshActiveGaShadowProjection,
} from './gaProductionShadow'

type CandidateRow = Record<string, any>

function enrollmentDb() {
  let stored: CandidateRow | null = null
  const statements: string[] = []
  return {
    get stored() { return stored },
    get statements() { return statements },
    prepare(sql: string) {
      statements.push(sql)
      return {
        bind(...params: any[]) {
          return {
            async run() {
              if (sql.includes('INSERT INTO ga_optimizer_shadow_candidates_v1')) {
                stored = {
                  shadow_id: params[0],
                  candidate_registry_id: params[1],
                  ga_candidate_id: params[2],
                  status: 'ACTIVE',
                  candidate_config_json: params[3],
                  candidate_config_checksum: params[4],
                  baseline_config_json: params[5],
                  baseline_config_checksum: params[6],
                  evaluator_version: params[7],
                  enrolled_business_date: params[8],
                }
              }
              return { success: true }
            },
            async first() {
              return stored
            },
          }
        },
        async first() {
          return stored
        },
      }
    },
  }
}

async function main() {
{
  const db = enrollmentDb()
  const enrollment = await enrollGaProductionShadowCandidate(db as any, {
    candidateRegistryId: 'parameter:ga:test',
    learningState: {
      best: {
        candidate: {
          id: 'ga_optimizer:g3:c7',
          params: { alphaFramework: { scoring: { momentum: 0.55 } } },
        },
      },
      validation: {
        evidence_clock: {
          as_of_date: '2026-09-02',
          snapshot_id: 'snapshot-2026-09-02',
          snapshot_checksum: `sha256:${'a'.repeat(64)}`,
        },
      },
    },
    baselineConfig: { alphaFramework: { scoring: { momentum: 0.40 } } },
    runDate: '2026-09-02',
    runId: 'weekly-ga-2026-09-02',
    cadence: 'weekly',
  })

  assert.equal(enrollment.status, 'ACTIVE')
  assert.equal(enrollment.ga_candidate_id, 'ga_optimizer:g3:c7')
  assert.equal(enrollment.production_effect, false)
  assert.match(enrollment.candidate_config_checksum, /^sha256:[a-f0-9]{64}$/)
  assert.match(enrollment.baseline_config_checksum, /^sha256:[a-f0-9]{64}$/)
  assert.notEqual(enrollment.candidate_config_checksum, enrollment.baseline_config_checksum)
  assert.equal(db.stored?.evaluator_version, GA_SHADOW_EVALUATOR_VERSION)
  assert.equal(db.stored?.enrolled_business_date, '2026-09-02')
  assert.ok(db.statements.some((sql) => sql.includes(
    'ON CONFLICT(ga_candidate_id, candidate_config_checksum, baseline_config_checksum,\n' +
    '                enrolled_business_date, source_run_id)',
  )))
}

{
  const active = {
    shadow_id: 'ga-shadow-v1:test',
    candidate_registry_id: 'parameter:ga:test',
    ga_candidate_id: 'ga_optimizer:g3:c7',
    status: 'ACTIVE',
    candidate_config_json: '{}',
    candidate_config_checksum: `sha256:${'a'.repeat(64)}`,
    baseline_config_json: '{}',
    baseline_config_checksum: `sha256:${'b'.repeat(64)}`,
    evaluator_version: GA_SHADOW_EVALUATOR_VERSION,
    enrolled_business_date: '2026-09-02',
  }
  const db = {
    prepare() {
      return { bind() { return {} } }
    },
    async batch() {
      return [
        { results: [{ evidence_dates: 20 }] },
        { results: [{
          business_date: '2026-09-30',
          candidate_total_return: 0.08,
          baseline_total_return: 0.04,
          paired_return_delta: 0.04,
          candidate_total_trades: 35,
          baseline_total_trades: 32,
          candidate_sharpe: 0.9,
          baseline_sharpe: 0.6,
          candidate_max_drawdown: 0.08,
          baseline_max_drawdown: 0.1,
          walk_forward_pass: 1,
          gate_decision: 'PASS',
          execution_parity_decision: 'MISSING',
          evidence_checksum: `sha256:${'c'.repeat(64)}`,
        }] },
      ]
    },
  }
  const maturity = await buildGaShadowMaturity(db as any, active)
  assert.equal(maturity?.l2_pass, true)
  assert.equal(maturity?.l3_pass, false)
  assert.equal(maturity?.l4_pass, false)
  assert.equal(maturity?.production_effect, false)
  assert.ok(maturity?.blockers.l3.includes('l3_execution_parity_not_passed'))
}

{
  const active = {
    shadow_id: 'ga-shadow-v1:auto-release',
    candidate_registry_id: 'parameter:ga:auto-release',
    ga_candidate_id: 'ga_optimizer:g3:c7',
    status: 'ACTIVE',
    candidate_config_json: '{}',
    candidate_config_checksum: `sha256:${'a'.repeat(64)}`,
    baseline_config_json: '{}',
    baseline_config_checksum: `sha256:${'b'.repeat(64)}`,
    evaluator_version: GA_SHADOW_EVALUATOR_VERSION,
    enrolled_business_date: '2026-09-02',
  }
  const updates: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    prepare(sql: string) {
      return {
        async first() {
          return active
        },
        bind(...params: unknown[]) {
          return {
            async run() {
              updates.push({ sql, params })
              return { success: true }
            },
          }
        },
      }
    },
    async batch() {
      return [
        { results: [{ evidence_dates: 40 }] },
        { results: [{
          business_date: '2026-10-30',
          candidate_total_return: 0.12,
          baseline_total_return: 0.05,
          paired_return_delta: 0.07,
          candidate_total_trades: 65,
          baseline_total_trades: 60,
          candidate_sharpe: 1.1,
          baseline_sharpe: 0.6,
          candidate_max_drawdown: 0.07,
          baseline_max_drawdown: 0.1,
          walk_forward_pass: 1,
          gate_decision: 'PASS',
          execution_parity_decision: 'PASS',
          evidence_checksum: `sha256:${'c'.repeat(64)}`,
        }] },
      ]
    },
  }
  const store = new Map<string, string>()
  store.set('optimizer:ga:shadow:active', JSON.stringify({
    source: 'ga_optimizer',
    best_alphaFramework: { scoring: { momentum: 0.55 } },
    best: {
      candidate: { id: active.ga_candidate_id },
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    shadow: { shadow_id: active.shadow_id, production_effect: false },
    promotion: { level: 'L2', status: 'shadow_config' },
  }))
  const kv = {
    async get(key: string, mode?: string) {
      const raw = store.get(key)
      if (!raw) return null
      return mode === 'json' ? JSON.parse(raw) : raw
    },
    async put(key: string, value: string) {
      store.set(key, value)
    },
  }
  const summary = await refreshActiveGaShadowProjection({
    DB: db,
    LEARNING_DB: db,
    KV: kv,
    MULTI_D1_ACTIVE_DOMAINS: 'learning',
    MULTI_D1_STRICT: 'true',
  } as any)
  const champion = JSON.parse(store.get('optimizer:ga:champion') ?? '{}')
  assert.match(summary, /level=L3 auto_release=released_L3/)
  assert.equal(champion.promotion.level, 'L3')
  assert.equal(champion.promotion.approval_mode, 'automatic_candidate_specific_evidence')
  assert.equal(champion.release.automatic, true)
  assert.equal(champion.release.production_effect, false)
  assert.equal(store.has('trading:config'), false)
  assert.ok(updates.some((row) => row.sql.includes("SET status='PROD_ACTIVE'")))
}

{
  const completed: CandidateRow = {
    shadow_id: 'ga-shadow-v1:completed',
    candidate_registry_id: 'parameter:ga:completed',
    ga_candidate_id: 'ga_optimizer:completed',
    status: 'ACTIVE',
    candidate_config_json: '{}',
    candidate_config_checksum: `sha256:${'d'.repeat(64)}`,
    baseline_config_json: '{}',
    baseline_config_checksum: `sha256:${'e'.repeat(64)}`,
    evaluator_version: GA_SHADOW_EVALUATOR_VERSION,
    enrolled_business_date: '2026-09-02',
  }
  const queued: CandidateRow = {
    ...completed,
    shadow_id: 'ga-shadow-v1:queued',
    candidate_registry_id: 'parameter:ga:queued',
    ga_candidate_id: 'ga_optimizer:queued',
    status: 'QUEUED',
    candidate_config_checksum: `sha256:${'f'.repeat(64)}`,
  }
  const rows = [completed, queued]
  class Statement {
    params: unknown[] = []
    constructor(readonly sql: string) {}
    bind(...params: unknown[]) { this.params = params; return this }
    async first() {
      if (this.sql.includes("status='ACTIVE'")) return rows.find((row) => row.status === 'ACTIVE') ?? null
      if (this.sql.includes("status='QUEUED'")) return rows.find((row) => row.status === 'QUEUED') ?? null
      return null
    }
    async run() { return { success: true } }
  }
  const db = {
    prepare(sql: string) { return new Statement(sql) },
    async batch(statements: Statement[]) {
      if (statements[0]?.sql.includes('SELECT COUNT(*) AS evidence_dates')) {
        return [
          { results: [{ evidence_dates: 60 }] },
          { results: [{
            business_date: '2026-11-30',
            candidate_total_return: 0.18,
            baseline_total_return: 0.06,
            paired_return_delta: 0.12,
            candidate_total_trades: 110,
            baseline_total_trades: 100,
            candidate_sharpe: 1.2,
            baseline_sharpe: 0.6,
            candidate_max_drawdown: 0.06,
            baseline_max_drawdown: 0.1,
            walk_forward_pass: 1,
            gate_decision: 'PASS',
            execution_parity_decision: 'PASS',
            evidence_checksum: `sha256:${'1'.repeat(64)}`,
          }] },
        ]
      }
      completed.status = 'PROMOTION_READY'
      queued.status = 'ACTIVE'
      return statements.map(() => ({ success: true }))
    },
  }
  const completedState = {
    source: 'ga_optimizer',
    best_alphaFramework: { scoring: { momentum: 0.55 } },
    best: {
      candidate: { id: completed.ga_candidate_id },
      metrics: { pbo: 0.2, mdd_95th: 0.16, sharpe: 1.1, trade_count: 120 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    shadow: { shadow_id: completed.shadow_id, status: 'ACTIVE', production_effect: false },
    promotion: { level: 'L3', status: 'approved' },
  }
  const queuedState = {
    source: 'ga_optimizer',
    best_alphaFramework: { scoring: { momentum: 0.60 } },
    best: {
      candidate: { id: queued.ga_candidate_id },
      metrics: { pbo: 0.18, mdd_95th: 0.14, sharpe: 1.2, trade_count: 130 },
      gate: { passed: true, checks: { pbo: true, monte_carlo_mdd_95th: true } },
    },
    shadow: { shadow_id: queued.shadow_id, status: 'QUEUED', production_effect: false },
    promotion: { level: 'L1', status: 'review_candidate' },
  }
  const store = new Map<string, string>([
    ['optimizer:ga:shadow:active', JSON.stringify(completedState)],
    [`optimizer:ga:shadow:state:${completed.shadow_id}`, JSON.stringify(completedState)],
    [`optimizer:ga:shadow:state:${queued.shadow_id}`, JSON.stringify(queuedState)],
    ['optimizer:ga:candidate:latest', JSON.stringify(queuedState)],
  ])
  const kv = {
    async get(key: string, mode?: string) {
      const raw = store.get(key)
      if (!raw) return null
      return mode === 'json' ? JSON.parse(raw) : raw
    },
    async put(key: string, value: string) { store.set(key, value) },
  }

  const summary = await refreshActiveGaShadowProjection({
    DB: db,
    LEARNING_DB: db,
    KV: kv,
    MULTI_D1_ACTIVE_DOMAINS: 'learning',
    MULTI_D1_STRICT: 'true',
  } as any)
  const champion = JSON.parse(store.get('optimizer:ga:champion') ?? '{}')
  const active = JSON.parse(store.get('optimizer:ga:shadow:active') ?? '{}')
  const latest = JSON.parse(store.get('optimizer:ga:candidate:latest') ?? '{}')
  assert.match(summary, /level=L4 auto_release=released_L4 rotated_to=ga-shadow-v1:queued/)
  assert.equal(champion.shadow.shadow_id, completed.shadow_id)
  assert.equal(champion.promotion.level, 'L4')
  assert.equal(active.shadow.shadow_id, queued.shadow_id)
  assert.equal(active.shadow.status, 'ACTIVE')
  assert.equal(active.rotation.previous_shadow_id, completed.shadow_id)
  assert.equal(latest.best.candidate.id, queued.ga_candidate_id)
  assert.equal(completed.status, 'PROMOTION_READY')
  assert.equal(queued.status, 'ACTIVE')
  assert.equal(store.has('trading:config'), false)
}

console.log('GA production shadow tests passed')
}

main().catch((error) => {
  throw error
})
