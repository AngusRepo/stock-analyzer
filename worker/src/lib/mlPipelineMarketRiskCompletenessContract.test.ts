import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync('src/lib/mlPipelineTrigger.ts', 'utf8')

assert(
  source.includes('existingRiskComplete'),
  'historical market_risk preservation must require a completeness guard',
)

for (const field of ['twii_close', 'twii_ma20', 'twii_bias', 'twii_vol20']) {
  assert(
    source.includes(`existingRisk.${field} != null`),
    `historical market_risk preservation must require ${field}`,
  )
}

assert(
  source.includes('if (!shouldRecomputeRisk && existingRiskComplete)'),
  'incomplete historical market_risk rows must be recomputed instead of preserved',
)

assert(
  source.includes('MARKET_RISK_LATEST_CACHE_KEYS')
    && source.includes('market:risk:latest:v19-finlab-risk-detail')
    && source.includes('clearMarketRiskLatestCaches(env)'),
  'market_risk recompute must clear the currently served /api/market/risk KV cache key',
)
