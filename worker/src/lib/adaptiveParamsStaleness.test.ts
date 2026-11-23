import assert from 'node:assert/strict'
import test from 'node:test'
import { l4NativeFixture } from './l4NativeFixture.testSupport'
import { RISK_CONFIG_FIXTURE } from './riskConfig.testSupport'
import { DEFAULT_ADAPTIVE_PARAMS, adaptiveParamsFreshness, invalidateAdaptiveCache } from './adaptiveConfig'
import { buildMarketRegimeState } from './marketRegimeState'
import { withPaperExecutionScope } from './paperExecutionScope'
import { checkCircuitBreakers } from './pendingBuyOrchestrator'
import { checkP2Accuracy } from './riskChecks/p2Accuracy'
import { buildChampionTradingConfig, validateTradingConfig, DEFAULT_TRADING_CONFIG } from './tradingConfig'
import { LEGACY_ALPHA_MODELS } from './alphaModelRoster'

// FG-02/03: ml:adaptive_params older than trading:config L2_formula.adaptive_params_max_age_days
// retires confidence_delta (after regime override) and is unavailable P2 evidence.

const NOW = Date.parse('2026-11-20T00:30:00Z') // Taipei 2026-11-20 08:30

test('freshness: Taipei calendar days, inclusive max age, undated/lookahead not fresh', () => {
  const f = (computed_at: string, n = 7) => adaptiveParamsFreshness({ computed_at }, n, NOW)
  assert.deepEqual(f('2026-11-19T14:40:00+08:00'), {
    status: 'fresh', computed_date: '2026-11-19', as_of_date: '2026-11-20', age_days: 1, max_age_days: 7,
  })
  assert.equal(f('2026-11-13T14:40:00+08:00').status, 'fresh', 'age == N is still fresh')
  assert.equal(f('2026-11-12T14:40:00+08:00').status, 'stale', 'age == N+1 is stale')
  const prod = f('2026-10-07T15:10:00+08:00')
  assert.equal(prod.status, 'stale')
  assert.equal(prod.age_days, 44)
  assert.equal(f('2026-11-19T16:30:00Z').computed_date, '2026-11-20', 'UTC instants map to the Taipei date')
  assert.equal(f('').status, 'undated')
  assert.equal(f('not-a-date').status, 'undated')
  assert.equal(f('2026-11-21T09:00:00+08:00').status, 'lookahead')
  assert.equal(f('2026-10-07T15:10:00+08:00', 30).status, 'stale')
  assert.equal(f('2026-11-01T15:10:00+08:00', 30).status, 'fresh')
  for (const bad of [0, -1, 2.5, Number.NaN, undefined as unknown as number]) {
    assert.throws(() => adaptiveParamsFreshness({ computed_at: '2026-11-19T14:40:00+08:00' }, bad, NOW), /max age invalid/)
  }
})

test('trading:config owns N: absent field falls back to the champion default; invalid values fail validation', () => {
  const absent = buildChampionTradingConfig({ L2_formula: { confidence_risk_mult: 0.15 } } as any)
  assert.equal(absent.L2_formula.adaptive_params_max_age_days, 7)
  assert.equal(DEFAULT_TRADING_CONFIG.L2_formula.adaptive_params_max_age_days, 7)
  const set = buildChampionTradingConfig({ L2_formula: { adaptive_params_max_age_days: 5 } } as any)
  assert.equal(set.L2_formula.adaptive_params_max_age_days, 5)
  assert.deepEqual(validateTradingConfig(set).filter((e) => e.includes('adaptive_params_max_age_days')), [])
  for (const bad of [0, 31, 2.5, '7', null]) {
    const cfg = buildChampionTradingConfig({ L2_formula: { adaptive_params_max_age_days: bad } } as any)
    assert.ok(validateTradingConfig(cfg).some((e) => e.includes('L2_formula.adaptive_params_max_age_days')), `reject ${String(bad)}`)
  }
})

// ── FG-02: circuit thresholds (regime override first, then staleness) ──────────
const FIXTURE_TODAY = '2026-09-14' // l4NativeFixture clock, Taipei date
const FRESH_AT = '2026-09-11T14:40:00+08:00' // Fri post-market -> Mon morning, age 3
const STALE_AT = '2026-09-04T14:40:00+08:00' // age 10 > 7

function seed(f: ReturnType<typeof l4NativeFixture>, label: string, computedAt: string) {
  f.sqls.learning.exec('CREATE TABLE IF NOT EXISTS active8_ensemble_pointer_v1(singleton_id INTEGER PRIMARY KEY,artifact_id TEXT,cohort_id TEXT,payload_checksum TEXT,base_artifact_set_checksum TEXT)')
  // No published pointer row -> a model_accuracy read would use the legacy roster. Seeded at 25%
  // so any fallthrough would raise thresholds to drawdownRaisedConf; P2 must not read it here.
  f.sqls.learning.exec('CREATE TABLE IF NOT EXISTS active8_ensemble_artifacts_v1(artifact_id TEXT PRIMARY KEY,payload_json TEXT,state TEXT,production_effect TEXT,payload_checksum TEXT)')
  for (const model of LEGACY_ALPHA_MODELS) {
    f.sqls.learning.prepare("INSERT INTO model_accuracy(stock_id,model_name,period,total_count,correct_count) VALUES(1,?,'30d',20,5)").run(model)
  }
  f.kvs.set('trading:risk_config', JSON.stringify(RISK_CONFIG_FIXTURE))
  // Prod shape on 11/16: top-level +0.0615, bull override -0.0554, frozen accuracy 0.6.
  f.kvs.set('ml:adaptive_params', JSON.stringify({
    ...DEFAULT_ADAPTIVE_PARAMS,
    confidence_delta: 0.0615,
    regime_overrides: { bull: { confidence_delta: -0.0554 } },
    recent_accuracy_30d: 0.6,
    computed_at: computedAt,
    provenance: { ...DEFAULT_ADAPTIVE_PARAMS.provenance, source: 'ml-controller', fallback: false, computed_at: computedAt },
  }))
  f.sqls.core.exec("INSERT INTO market_risk(date,twii_close,risk_score,risk_level) VALUES('2026-09-11',30000,10,'green'),('2026-09-10',30000,10,'green')")
  f.sqls.market.exec("INSERT INTO market_breadth(date,advance_ratio,bull_alignment_pct) VALUES('2026-09-11',.6,60)")
  f.sqls.market.exec("INSERT INTO market_regime_factor_packets(date,schema_version,score,level,factor_json,contribution_json,source_json,freshness_json,missing_reason_json,lineage_json,generated_at) VALUES('2026-09-11','market-regime-factor-packet-v1',10,'green','[]','{}','{}','{}','{}','{}','2026-09-11T14:00:00Z')")
  f.kvs.set('market_regime_state', JSON.stringify(buildMarketRegimeState({ label, runDate: '2026-09-11', computedAt: '2026-09-11T14:00:00Z' })))
  f.seedRiskQuality('2026-09-11')
}

async function thresholds(label: string, computedAt: string) {
  invalidateAdaptiveCache()
  const f = l4NativeFixture()
  try {
    seed(f, label, computedAt)
    assert.equal(adaptiveParamsFreshness({ computed_at: computedAt }, 7, f.ports.nowMs).as_of_date, FIXTURE_TODAY)
    const state = await withPaperExecutionScope(f.ports, () => checkCircuitBreakers({
      paper: f.env.PAPER_DB, core: f.env.CORE_DB, market: f.env.MARKET_DB, learning: f.env.LEARNING_DB,
    }, f.cfg, f.env.KV))
    return state.result
  } finally {
    f.close()
  }
}

const close = (actual: number, expected: number, msg: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} != ${expected}`)

test('FG-02 bull: fresh applies the regime override delta; stale retires it to 0', async () => {
  const fresh = await thresholds('bull_market', FRESH_AT)
  assert.equal(fresh.halt, false)
  close(fresh.buyConfThreshold, 0.5446, 'fresh bull buy')
  close(fresh.sellConfThreshold, 0.5946, 'fresh bull sell')
  assert.equal(fresh.evidenceNotes, undefined)
  const stale = await thresholds('bull_market', STALE_AT)
  assert.equal(stale.halt, false)
  close(stale.buyConfThreshold, 0.6, 'stale bull buy = baseline')
  close(stale.sellConfThreshold, 0.65, 'stale bull sell = baseline')
  // FG-03 through the real chain: P2 is a neutral, annotated pass (no halt, no model_accuracy fallthrough).
  assert.deepEqual(stale.evidenceNotes, ['[P2] p2_evidence_stale stale computed=2026-09-04 as_of=2026-09-14 age_days=10 max_age_days=7'])
  assert.ok(!(stale.triggeredLayers ?? []).includes('P2'), 'annotation-only P2 is not a trigger')
  assert.doesNotMatch(String(stale.reason ?? ''), /P2/)
})

test('FG-02 volatile/bear: fresh applies the top-level delta; stale retires it to 0', async () => {
  for (const label of ['volatile', 'bear_market']) {
    const fresh = await thresholds(label, FRESH_AT)
    close(fresh.buyConfThreshold, 0.6615, `fresh ${label} buy`)
    close(fresh.sellConfThreshold, 0.7115, `fresh ${label} sell`)
    assert.equal(fresh.halt, false)
    const stale = await thresholds(label, STALE_AT)
    assert.equal(stale.halt, false)
    close(stale.buyConfThreshold, 0.6, `stale ${label} buy = baseline`)
    close(stale.sellConfThreshold, 0.65, `stale ${label} sell = baseline`)
  }
})

// ── FG-03: P2 accuracy evidence ─────────────────────────────────────────────
const deps = {
  defaults: { halt: false, maxPositionPct: 0.08, buyConfThreshold: 0.6, sellConfThreshold: 0.65 },
  effectiveBuy: 0.6,
  effectiveSell: 0.65,
}
class FakeDB {
  constructor(private row: any) {}
  prepare(sql: string) {
    const row = sql.includes('active8_ensemble_pointer_v1') ? null : this.row
    return { bind() { return this }, async first() { return row } }
  }
}
class FakeKV {
  constructor(private value: any) {}
  async get(_key: string, mode?: string) { return mode === 'json' ? this.value : JSON.stringify(this.value) }
}
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
const adaptive = (computedAt: string, acc: number) => ({
  ...DEFAULT_ADAPTIVE_PARAMS,
  recent_accuracy_30d: acc,
  computed_at: computedAt,
  provenance: { ...DEFAULT_ADAPTIVE_PARAMS.provenance, source: 'ml-controller', fallback: false },
})
const p2 = (params: any, row: any, cfg = DEFAULT_TRADING_CONFIG) => {
  invalidateAdaptiveCache()
  return checkP2Accuracy(new FakeDB(row) as unknown as D1Database, new FakeKV(params) as unknown as KVNamespace, cfg, deps)
}

test('FG-03 P2: fresh adaptive accuracy is still the first source', async () => {
  assert.equal(await p2(adaptive(daysAgo(1), 0.6), { accuracy: 0.3, samples: 80 }), null)
  const low = await p2(adaptive(daysAgo(1), 0.4), { accuracy: 0.9, samples: 80 })
  assert.equal(low?.buyConfThreshold, DEFAULT_TRADING_CONFIG.circuit.drawdownRaisedConf)
  assert.match(String(low?.reason), /source=ml:adaptive_params/)
})

const neutral = (r: any, status: string) => {
  assert.equal(r?.halt, false)
  assert.equal(r?.reason, undefined)
  assert.equal(r?.buyConfThreshold, deps.defaults.buyConfThreshold)
  assert.equal(r?.sellConfThreshold, deps.defaults.sellConfThreshold)
  assert.equal(r?.maxPositionPct, deps.defaults.maxPositionPct)
  assert.equal(r?.evidenceNotes?.length, 1)
  assert.match(r.evidenceNotes[0], new RegExp(`^p2_evidence_stale ${status} computed=`))
  assert.match(r.evidenceNotes[0], /max_age_days=7$/)
}

test('FG-03 P2: params present but not fresh -> neutral annotated pass, never model_accuracy', async () => {
  // Low model_accuracy would raise thresholds and a missing one would halt; neither may happen.
  for (const row of [{ accuracy: 0.2, samples: 80 }, null]) {
    neutral(await p2(adaptive(daysAgo(44), 0.6), row), 'stale')
    neutral(await p2(adaptive(daysAgo(44), 0.3), row), 'stale')
    neutral(await p2(adaptive('', 0.6), row), 'undated')
    neutral(await p2(adaptive(daysAgo(-2), 0.6), row), 'lookahead')
  }
})

test('FG-03 P2: missing/unreadable adaptive params keep the model_accuracy -> fail-closed path', async () => {
  const missing = await p2(null, null)
  assert.equal(missing?.halt, true)
  assert.match(String(missing?.reason), /adaptive params missing/)
  const fallback = await p2(null, { accuracy: 0.4, samples: 80 })
  assert.equal(fallback?.buyConfThreshold, DEFAULT_TRADING_CONFIG.circuit.drawdownRaisedConf)
  assert.match(String(fallback?.reason), /model_accuracy\.active8\.samples_80/)
})

test('FG-03 P2: N comes from trading:config', async () => {
  const wide = buildChampionTradingConfig({ L2_formula: { adaptive_params_max_age_days: 30 } } as any)
  assert.equal(await p2(adaptive(daysAgo(10), 0.6), null, wide), null, '10 days old is fresh with N=30')
  neutral(await p2(adaptive(daysAgo(10), 0.6), null), 'stale')
})
