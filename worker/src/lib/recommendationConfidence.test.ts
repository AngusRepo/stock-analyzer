import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildConfidenceContext,
  confidenceForSymbol,
  DEFAULT_CONFIDENCE_SORT,
  loadConfidenceContext,
  lookupWinRate,
  parseConfidenceSort,
  sortRecommendationsByConfidence,
  validateDisplayWinRateTable,
  winRateUnavailableReason,
  type DisplayWinRateTable,
  type PlanHeader,
} from './recommendationConfidence'

const committed = JSON.parse(readFileSync(new URL('./r33DisplayWinRate.json', import.meta.url), 'utf8')) as DisplayWinRateTable
const COHORT = 'active8-oof-v9-feature-semantic-source-attested-v7-r33-exo131-core4-2025-12-17-2026-10-29-tr60-te21'
const header: PlanHeader = {
  plan_id: 'plan-1',
  signal_date: '2026-11-23',
  cohort_id: committed.identity.cohort_id,
  ensemble_payload_checksum: committed.identity.ensemble_payload_checksum,
  calibration_checksum: committed.identity.serving_calibration_checksum,
}
const pointer = { cohort_id: committed.identity.cohort_id, payload_checksum: committed.identity.ensemble_payload_checksum }
const MODELS = ['LightGBM', 'ExtraTrees', 'TabM', 'GNN']

function target(symbol: string, score: number | null, zs: number[], er: number | null, available = [true, true, true, true]) {
  return {
    symbol,
    score,
    z: JSON.stringify(Object.fromEntries(MODELS.map((m, i) => [m, zs[i]]))),
    available: JSON.stringify(Object.fromEntries(MODELS.map((m, i) => [m, available[i]]))),
    expected_return_gross: er,
  }
}

const targets = [
  target('A', 1.5, [1, 1, 1, -1], 0.0098),
  target('B', 0.9, [1, -1, 1, -1], -0.0006),
  target('C', 0.9, [1, -1, -1, -1], -0.0006),
  target('D', -0.5, [-1, -1, -1, 2], -0.0011),
  target('E', -1.6, [-1, -1, -1, -1], -0.0124),
  target('F', 0.2, [0.5, 0, 0, 0], -0.0011, [true, false, false, false]),
  target('G', null, [0, 0, 0, 0], null, [false, false, false, false]),
]

test('committed display table is the production core4 cohort and its sha256 is the canonical JSON digest', () => {
  assert.equal(validateDisplayWinRateTable(committed), null)
  assert.equal(committed.identity.cohort_id, COHORT)
  assert.deepEqual(committed.model_order, MODELS)
  assert.equal(committed.horizon_sessions, 5)
  const canonical = (value: unknown): string => Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(',')}}`
      : JSON.stringify(value)
  const { table_sha256: digest, ...body } = committed as any
  assert.equal(createHash('sha256').update(canonical(body), 'utf8').digest('hex'), digest)
})

test('percentile is the mid-rank share of the scored pool; agreement counts available models with z > 0', () => {
  const context = buildConfidenceContext({ header, targets, pointer, table: committed })
  assert.equal(context.sortedScores.length, 6)
  const a = confidenceForSymbol(context, 'A')
  assert.equal(a.percentile.status, 'available')
  assert.deepEqual({ ...(a.percentile as any), definition: undefined }, {
    status: 'available', value: 100, rank: 1, pool_size: 6, models_positive: 3, models_available: 4, roster_size: 4, definition: undefined,
  })
  const b = confidenceForSymbol(context, 'B').percentile as any
  const c = confidenceForSymbol(context, 'C').percentile as any
  assert.equal(b.value, c.value) // ties share one mid-rank
  assert.equal(b.value, 70)      // (3 below + 0.5) / 5
  assert.equal(b.rank, 2)
  const e = confidenceForSymbol(context, 'E').percentile as any
  assert.equal(e.value, 0)
  assert.equal(e.rank, 6)
  const f = confidenceForSymbol(context, 'F').percentile as any
  assert.equal(f.models_available, 1)
  assert.equal(f.models_positive, 1)
  assert.deepEqual(confidenceForSymbol(context, 'G').percentile, { status: 'unavailable', reason: 'r33_score_unavailable' })
  assert.deepEqual(confidenceForSymbol(context, 'Z').percentile, { status: 'unavailable', reason: 'symbol_not_in_plan' })
})

test('win rate follows the serving EV segments of the committed table', () => {
  const context = buildConfidenceContext({ header, targets, pointer, table: committed })
  const segments = committed.segments
  const top = confidenceForSymbol(context, 'A').win_rate as any
  assert.equal(top.status, 'available')
  assert.equal(top.value, segments[segments.length - 1].win_rate)
  assert.equal(top.cohort_id, COHORT)
  assert.equal(top.table_sha256, committed.table_sha256)
  assert.equal((confidenceForSymbol(context, 'E').win_rate as any).value, segments[0].win_rate)
  for (const [index, segment] of segments.entries()) {
    assert.equal(lookupWinRate(committed, segment.score_lo).segment, index)
    assert.equal(lookupWinRate(committed, segment.score_hi).segment, index)
  }
  assert.equal(lookupWinRate(committed, -99).segment, 0)
  assert.equal(lookupWinRate(committed, 99).segment, segments.length - 1)
})

test('win rate fails closed on any cohort, ensemble, calibration or pointer mismatch', () => {
  assert.equal(winRateUnavailableReason(committed, header, pointer), null)
  assert.equal(winRateUnavailableReason(committed, null, pointer), 'plan_unavailable')
  assert.equal(winRateUnavailableReason(committed, { ...header, cohort_id: 'other' }, pointer), 'plan_cohort_mismatch')
  assert.equal(winRateUnavailableReason(committed, { ...header, ensemble_payload_checksum: 'f'.repeat(64) }, pointer), 'plan_ensemble_mismatch')
  assert.equal(winRateUnavailableReason(committed, { ...header, calibration_checksum: null }, pointer), 'plan_serving_calibration_mismatch')
  assert.equal(winRateUnavailableReason(committed, header, null), 'l3_pointer_unavailable')
  assert.equal(winRateUnavailableReason(committed, header, undefined), 'l3_pointer_unavailable')
  assert.equal(winRateUnavailableReason(committed, header, { ...pointer, cohort_id: 'next-cohort' }), 'l3_pointer_cohort_mismatch')
  assert.equal(winRateUnavailableReason(committed, header, { ...pointer, payload_checksum: 'e'.repeat(64) }), 'l3_pointer_cohort_mismatch')
  assert.equal(winRateUnavailableReason({ ...committed, schema_version: 'v0' }, header, pointer), 'table_schema_invalid')
  const overlapping = { ...committed, segments: [committed.segments[1], committed.segments[0]] }
  assert.equal(winRateUnavailableReason(overlapping, header, pointer), 'table_segments_overlap')
  const context = buildConfidenceContext({ header: { ...header, cohort_id: 'next-cohort' }, targets, pointer, table: committed })
  assert.deepEqual(confidenceForSymbol(context, 'A').win_rate, { status: 'unavailable', reason: 'plan_cohort_mismatch' })
  assert.equal(confidenceForSymbol(context, 'A').percentile.status, 'available') // percentile needs no table
})

test('default order is L4 EV, then R33 score, then the legacy rank; unavailable values sort last', () => {
  assert.equal(DEFAULT_CONFIDENCE_SORT, 'l4_ev')
  assert.equal(parseConfidenceSort(undefined), 'l4_ev')
  assert.equal(parseConfidenceSort('bogus'), 'l4_ev')
  assert.equal(parseConfidenceSort('win_rate'), 'win_rate')
  const context = buildConfidenceContext({ header, targets, pointer, table: committed })
  const recs = ['G', 'E', 'D', 'C', 'B', 'A', 'F'].map((symbol, i) => ({ symbol, rank: i + 1, r33_confidence: confidenceForSymbol(context, symbol) }))
  assert.deepEqual(sortRecommendationsByConfidence(recs, 'l4_ev').map((r) => r.symbol), ['A', 'C', 'B', 'F', 'D', 'E', 'G'])
  assert.deepEqual(sortRecommendationsByConfidence(recs, 'r33_percentile').map((r) => r.symbol), ['A', 'C', 'B', 'F', 'D', 'E', 'G'])
  assert.deepEqual(sortRecommendationsByConfidence(recs, 'win_rate').map((r) => r.symbol).slice(0, 1), ['A'])
  assert.deepEqual(sortRecommendationsByConfidence(recs, 'legacy_rank').map((r) => r.symbol), ['G', 'E', 'D', 'C', 'B', 'A', 'F'])
  const blocked = buildConfidenceContext({ header: { ...header, cohort_id: 'x' }, targets, pointer, table: committed })
  const blockedRecs = recs.map((r) => ({ ...r, r33_confidence: confidenceForSymbol(blocked, r.symbol) }))
  // with the win rate unavailable everywhere the R33 score decides, as a display fallback
  assert.deepEqual(sortRecommendationsByConfidence(blockedRecs, 'win_rate').map((r) => r.symbol), ['A', 'C', 'B', 'F', 'D', 'E', 'G'])
})

function fakeEnv(opts: { planRow?: any; pointer?: any; pointerError?: boolean; planError?: boolean }) {
  const calls: string[] = []
  const db = {
    prepare(sql: string) {
      calls.push(sql.replace(/\s+/g, ' ').trim())
      const bound = {
        args: [] as unknown[],
        bind(...args: unknown[]) { this.args = args; return this },
        async first() {
          if (opts.planError && sql.includes('l4_portfolio_plans_v1')) throw new Error('paper down')
          if (sql.includes('active8_ensemble_pointer_v1')) {
            if (opts.pointerError) throw new Error('learning 429')
            return opts.pointer ?? null
          }
          if (sql.includes('activated=1')) return opts.planRow ? { plan_id: opts.planRow.plan_id } : null
          return opts.planRow ?? null
        },
        async all() {
          if (opts.planError) throw new Error('paper down')
          return { results: targets }
        },
      }
      return bound
    },
  }
  return { env: { DB: db } as any, calls }
}

test('loadConfidenceContext reads the plan the cards name, its targets and the L3 pointer', async () => {
  const { env, calls } = fakeEnv({ planRow: header, pointer })
  const recs = [{ alpha_allocation: JSON.stringify({ plan_id: 'plan-1' }) }, { alpha_allocation: { plan_id: 'plan-1' } }, { alpha_allocation: null }]
  const context = await loadConfidenceContext(env, '2026-11-23', recs)
  assert.equal(context.header?.plan_id, 'plan-1')
  assert.equal(context.winRateReason, null)
  assert.equal(context.sortedScores.length, 6)
  assert.ok(calls.some((sql) => sql.includes("json_each(p.payload_json,'$.targets')")))
  assert.ok(!calls.some((sql) => sql.includes('activated=1')), 'plan id comes from the cards when they carry one')
})

test('loadConfidenceContext falls back to the activated plan and fails closed on read errors', async () => {
  const fallback = await loadConfidenceContext(fakeEnv({ planRow: header, pointer }).env, '2026-11-23', [{}])
  assert.equal(fallback.header?.plan_id, 'plan-1')
  const noPointer = await loadConfidenceContext(fakeEnv({ planRow: header, pointerError: true }).env, '2026-11-23', [{}])
  assert.equal(noPointer.winRateReason, 'l3_pointer_unavailable')
  assert.equal(noPointer.unavailableReason, null)
  const noPlan = await loadConfidenceContext(fakeEnv({}).env, '2026-11-23', [{}])
  assert.equal(noPlan.unavailableReason, 'plan_unavailable')
  assert.deepEqual(confidenceForSymbol(noPlan, 'A').percentile, { status: 'unavailable', reason: 'plan_unavailable' })
  const broken = await loadConfidenceContext(fakeEnv({ planRow: header, planError: true }).env, '2026-11-23', [{ alpha_allocation: { plan_id: 'plan-1' } }])
  assert.equal(broken.unavailableReason, 'plan_read_failed')
})

test('only the recommendations route reads display confidence; no decision code imports it', () => {
  // fileURLToPath, not URL.pathname: on Windows pathname is '/D:/...' and the walk fails with ENOENT.
  const root = fileURLToPath(new URL('..', import.meta.url))
  const importers: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !path.endsWith('lib/recommendationConfidence.ts')
        && /from '[^']*recommendationConfidence'/.test(readFileSync(path, 'utf8'))) importers.push(relative(root, path).split(sep).join('/'))
    }
  }
  walk(root)
  assert.deepEqual(importers, ['routes/other.ts'])
  const route = readFileSync(new URL('../routes/other.ts', import.meta.url), 'utf8')
  const start = route.indexOf("recommendations.get('/daily'")
  const body = route.slice(start, route.indexOf("recommendations.get('/history'"))
  const sortAt = body.indexOf('sortRecommendationsByConfidence(recs, confidenceSort)')
  assert.ok(sortAt > 0 && sortAt < body.indexOf("recs.filter((r: any) => r.recommendation_lane === 'tradable')"),
    'cards are ordered by display confidence before the lanes are split')
  assert.ok(body.includes('confidence: confidenceSummary'))
})
