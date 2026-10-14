import type { CanonicalMarketRiskContext } from '../marketRiskRuntime'
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps } from '../riskTypes'
import { checkP3MarketRisk } from './p3MarketRisk'
import { checkP4Breadth } from './p4Breadth'

/** One restriction owner; preserve component evidence and strict old limits. */
export async function checkCanonicalMarketRestriction(context:CanonicalMarketRiskContext,cfg:TradingConfig,deps:LegacyLayerDeps) {
  const [p3,p4]=await Promise.all([checkP3MarketRisk(context,cfg,deps),checkP4Breadth(context,cfg,deps)])
  const components=[{id:'P3',state:p3},{id:'P4',state:p4}].filter(c=>c.state!==null)
  if(!components.length) return null
  const states=components.map(c=>c.state!)
  return {...deps.defaults,...(p3 ?? p4!),halt:states.some(s=>s.halt),
    maxPositionPct:Math.min(...states.map(s=>s.maxPositionPct)),
    buyConfThreshold:Math.max(...states.map(s=>s.buyConfThreshold)),
    sellConfThreshold:Math.max(...states.map(s=>s.sellConfThreshold)),
    reason:components.map(c=>`${c.id}: ${c.state!.reason}`).join(' | '),
    marketRestrictionEvidence:{owner:'canonical_market_risk_runtime_v1',
      components:components.map(c=>({id:c.id,halt:c.state!.halt,maxPositionPct:c.state!.maxPositionPct,reason:c.state!.reason})),aggregation:'minimum_not_product'}}
}
