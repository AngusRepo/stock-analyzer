import {
  reconcileCandidateStrategyPoolAttribution,
} from './screenerStrategyConsumer'
import { STRATEGY_SPEC_VERSION, type StrategySpec } from './strategySpec'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const baseTechnicalStrategy: Omit<StrategySpec, 'id' | 'name' | 'variantId' | 'thresholds' | 'thesis'> = {
  version: STRATEGY_SPEC_VERSION,
  status: 'active',
  owner: 'strategy',
  ownerType: 'strategy',
  promotionStatus: 'production',
  alphaBucket: 'trend_following',
  familyId: 'TREND_RECLAIM_CONTINUATION',
  supportedRegimes: ['bull', 'sideways', 'volatile'],
  candidatePolicy: { poolQuota: 10, costBudget: 12 },
  riskNotes: ['test only'],
  createdBy: 'p5_strategy_governance',
}

const s02Spec: StrategySpec = {
  ...baseTechnicalStrategy,
  id: 'stock_tech_s02_52w_dual_momentum_v1',
  name: 'S2 52w dual momentum',
  variantId: 's02_52w_dual_momentum_v1',
  thesis: 'S2 technical admission must own final attribution when materialized.',
  thresholds: {
    minPrice: 10,
    dsl: {
      all: [{ signal: 'technicalIndicators.stockTechS02Admission', op: '==', value: 1 }],
    },
  },
}

const s04Spec: StrategySpec = {
  ...baseTechnicalStrategy,
  id: 'stock_tech_s04_ma_deduct_turn_breakout_v1',
  name: 'S4 MA deduct turn breakout',
  variantId: 's04_ma_deduct_turn_breakout_v1',
  thesis: 'S4 technical admission must own final attribution when materialized.',
  thresholds: {
    minPrice: 10,
    dsl: {
      all: [{ signal: 'technicalIndicators.stockTechS04Admission', op: '==', value: 1 }],
    },
  },
}

{
  const candidate = reconcileCandidateStrategyPoolAttribution({
    symbol: '2472',
    name: 'test candidate',
    current_price: 88,
    raw_signals: {
      close: 88,
      technicalIndicators: {
        stockTechS02Admission: 1,
        stockTechS02Score: 0.9496,
        stockTechS04Admission: 1,
        stockTechS04Score: 0.7791,
      },
    },
    strategy_pool_ids: ['alpha223_0109'],
    strategy_family_ids: ['ALPHA223_QUALITY_TURNOVER'],
    strategy_variant_ids: ['alpha223_0109'],
    strategy_owner_types: ['strategy'],
    strategy_watch_points: ['preexisting_router_attribution'],
  }, [s02Spec, s04Spec], { regime: 'volatile' })

  assert(
    candidate.strategy_pool_ids?.includes('stock_tech_s02_52w_dual_momentum_v1'),
    'S02 admission must be reconciled into production strategy_pool_ids',
  )
  assert(
    candidate.strategy_pool_ids?.includes('stock_tech_s04_ma_deduct_turn_breakout_v1'),
    'S04 admission must be reconciled into production strategy_pool_ids',
  )
  assert(
    candidate.strategy_variant_ids?.includes('s02_52w_dual_momentum_v1') &&
      candidate.strategy_variant_ids?.includes('s04_ma_deduct_turn_breakout_v1'),
    'technical strategy variants must be preserved for final attribution',
  )
  assert(
    candidate.strategy_watch_points?.includes('strategy_pool_attribution_reconciled_from_strict_spec_assessment'),
    'reconciliation must leave an explicit audit watch point',
  )
}

{
  const outOfRegimeSpec: StrategySpec = {
    ...s02Spec,
    id: 'active_bull_only_test_v1',
    name: 'Active bull-only test',
    supportedRegimes: ['bull'],
  }
  const candidate = reconcileCandidateStrategyPoolAttribution({
    symbol: '9991',
    current_price: 88,
    raw_signals: {
      close: 88,
      technicalIndicators: {
        stockTechS02Admission: 1,
      },
    },
    strategy_pool_ids: [],
    research_strategy_ids: [],
  }, [outOfRegimeSpec], { regime: 'volatile' })

  assert(
    !candidate.strategy_pool_ids?.includes('active_bull_only_test_v1'),
    'reconciliation must not bypass runtime regime ownership gates',
  )
  assert(
    candidate.research_strategy_ids?.includes('active_bull_only_test_v1'),
    'out-of-regime strict evidence should stay visible outside production strategy_pool_ids',
  )
}
