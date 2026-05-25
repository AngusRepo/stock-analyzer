import {
  buildPendingBuyPaperAttributionEvents,
  recordPendingBuyPaperAttribution,
} from './paperActiveAttributionWiring'
import type { PendingBuy } from './pendingBuyStore'
import { SCORE_V2_VERSION, SCORE_V2_WEIGHTS } from './scoreV2Taxonomy'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`)
  }
}

function createMockEnv() {
  const calls: Array<{ sql: string; params: unknown[] }> = []
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              async run() {
                calls.push({ sql, params })
                return { success: true }
              },
            }
          },
        }
      },
    },
  }
  return { env, calls }
}

const pendingBuy: PendingBuy = {
  symbol: '2330',
  name: '台積電',
  signal: 'BUY',
  confidence: 0.73,
  ml_entry_price: 938,
  ml_stop_loss: 905,
  ml_target1: 980,
  ml_target2: 1020,
  reason: 'ensemble',
  watch_points: ['Alpha bucket: quality'],
  debate_verdict: 'APPROVE',
  debate_status: 'completed',
  risk_pct: 0.012,
  kelly_pct: null,
  chip_score: 0.68,
  tech_score: 0.64,
  ml_score: 0.71,
  score: 0.12,
  score_v2: {
    version: SCORE_V2_VERSION,
    source: 'score_v2',
    weights: SCORE_V2_WEIGHTS,
    components: {
      mlEdge: 20,
      chipFlow: 19,
      technicalStructure: 21,
      fundamentalQuality: 13,
      newsTheme: 3,
    },
    total: 73,
    finalScore: 76,
    alphaAdjustment: 3,
    riskFlags: [],
    reasons: ['canonical_score_v2'],
  },
  source: 'morning_setup',
  original_entry: 940,
}

{
  const events = buildPendingBuyPaperAttributionEvents([pendingBuy], {
    tradeDate: '2026-05-17',
    sourceRecoDate: '2026-05-16',
    featureSetVersion: 'finlab-v4.1',
    regimeVersion: 'market-regime-state-v4',
  })

  assert(events.length === 1, 'one pending buy should produce one attribution event')
  assert(events[0].tradeDate === '2026-05-17', 'trade date should be preserved')
  assert(events[0].symbol === '2330', 'symbol should be preserved')
  assert(events[0].decision === 'pending_buy:APPROVE', 'decision should preserve debate verdict')
  assert(events[0].paperLane === 'paper_active_baseline', 'baseline pending buys should not masquerade as challenger')
  assert(events[0].candidateSource === 'morning_setup_pending_buy', 'candidate source should be explicit')
  assert(events[0].baselineScore === 76, 'baseline score should use canonical Score V2 finalScore first')
  assert(events[0].challengerScore === null, 'baseline attribution must not fabricate challenger score')
  assertDeepEqual(events[0].evidenceSources, [
    'daily_recommendations',
    'predictions.ensemble',
    'pending_buy_orchestrator',
    'source_reco_date:2026-05-16',
    'pending_source:morning_setup',
  ], 'evidence sources should explain lineage')
}

{
  const events = buildPendingBuyPaperAttributionEvents([{ ...pendingBuy, score_v2: null, score: 99 }], {
    tradeDate: '2026-05-17',
    sourceRecoDate: '2026-05-16',
  })

  assert(events[0].baselineScore === 0.73, 'missing Score V2 should fall back to confidence, not stale legacy score')
}

async function runPersistenceCheck() {
  const { env, calls } = createMockEnv()
  const written = await recordPendingBuyPaperAttribution(env as any, [pendingBuy], {
    tradeDate: '2026-05-17',
    sourceRecoDate: '2026-05-16',
  })

  assert(written === 1, 'one attribution write should be attempted')
  assert(calls.length === 1, 'one D1 insert should be issued')
  assert(calls[0].sql.includes('paper_decision_attribution'), 'write should target attribution table only')
  assert(!calls[0].sql.includes('paper_orders'), 'attribution sidecar must never write paper orders')
}

void runPersistenceCheck()
