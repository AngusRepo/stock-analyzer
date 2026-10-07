import type { Bindings } from '../types'
import { getTradingConfig } from './tradingConfig'
import { getRiskConfig, isKillSwitchActive } from './riskConfig'
import { resolveCanonicalMarketRisk, MARKET_RISK_POLICY_VERSION } from './marketRiskRuntime'
import { databaseForDataDomain } from './dataDomainRegistry'
import { resolveCircuitAdjustedSingleNameCap } from './riskPositionSizing'
import { paperExecutionNow } from './paperExecutionScope'
import { checkP3MarketRisk } from './riskChecks/p3MarketRisk'
import { checkP4Breadth } from './riskChecks/p4Breadth'

import { canonicalRiskJson, riskPacketChecksum } from './riskPacketCodec'
export { canonicalRiskJson, riskPacketChecksum } from './riskPacketCodec'
export async function buildDailyMarketRiskPacket(env: Bindings, tradeDate: string) {
 const now=paperExecutionNow(), nowIso=new Date(now).toISOString()
 const today=new Date(now+8*3600000).toISOString().slice(0,10)
 if(tradeDate!==today)throw new Error('daily_risk_current_decision_date_required')
 const [config,riskConfig,killSwitch]=await Promise.all([getTradingConfig(env.KV,{bypassCache:true}),getRiskConfig(env.KV),isKillSwitchActive(env.KV)])
 const market=await resolveCanonicalMarketRisk({core:databaseForDataDomain(env,'core'),market:databaseForDataDomain(env,'market')},env.KV,riskConfig)
 const configured=Math.min(config.position.maxPctOfPortfolio,riskConfig.position.maxSingleNamePct)
 const defaults={halt:false,maxPositionPct:config.circuit.maxPositionPct,
   buyConfThreshold:config.circuit.buyConfThreshold,sellConfThreshold:config.circuit.sellConfThreshold}
 const deps={defaults,effectiveBuy:defaults.buyConfThreshold,effectiveSell:defaults.sellConfThreshold}
 const marketChecks=await Promise.all([checkP3MarketRisk(market,config,deps),checkP4Breadth(market,config,deps)])
 const circuitEffective=Math.min(defaults.maxPositionPct,...marketChecks.filter(result=>result!==null).map(result=>result!.maxPositionPct))
 const nameCap=resolveCircuitAdjustedSingleNameCap({configuredSingleNameCap:configured,
   circuitBaselinePositionPct:config.circuit.maxPositionPct,circuitEffectivePositionPct:circuitEffective})
 const blocked=killSwitch || market.status!=='ready' || market.haltNewBuys
 const allocation=config.alphaFramework.allocation as Record<string,any>
 const content={schema_version:'daily-market-risk-packet-v1',policy_version:MARKET_RISK_POLICY_VERSION,
   trade_date:tradeDate,signal_date:market.date,captured_at:nowIso,expected_session:market.lineage.expectedSession,
   market,kill_switch:killSwitch,halt_new_buys:blocked,
   constraints:{exposure_cap:blocked ? 0 : market.targetExposureCap,name_cap:nameCap,
     max_positions:config.position.maxPositions,min_position_value:config.position.minPositionValue,
     min_commission:config.fees.minCommission,odd_lot_min_commission:Math.min(1,config.fees.minCommission),commission_policy:'sinopac-gross-leg-v1',buy_cost:config.fees.commission,sell_cost:config.fees.commission+config.fees.tax,
     risk_aversion:allocation.riskAversion,alpha_strength:allocation.alphaStrength,
     turnover_penalty:allocation.turnoverPenalty,l2_penalty:allocation.l2Penalty,
     max_cluster_weight:allocation.max_cluster_weight??allocation.maxClusterWeight??allocation.max_weight??allocation.maxWeight??.55,sector_concentration_cap:allocation.sector_concentration_cap !== undefined ? allocation.sector_concentration_cap : allocation.sectorConcentrationCap !== undefined ? allocation.sectorConcentrationCap : .5,
     cluster_edge_threshold:allocation.cluster_edge_threshold??allocation.clusterEdgeThreshold??null,cluster_threshold_quantile:allocation.cluster_threshold_quantile??allocation.clusterThresholdQuantile??.9,
     covariance_horizon_sessions:1},
   account_risk_policy:{daily_pnl_loss_limit:riskConfig.portfolio.dailyPnlLossLimit,
     daily_pnl_loss_limit_pct:riskConfig.portfolio.dailyPnlLossLimitPct,
     intraday_drawdown_halt:riskConfig.portfolio.intradayDrawdownHalt},
   source_identity:{worker_source_sha:env.CF_VERSION_METADATA?.tag??null},
   execution_scope:'shared_market_policy_account_controls_not_native_intraday_execution'}
 return {content,canonical_json:canonicalRiskJson(content),checksum:await riskPacketChecksum(content)}
}
