import { twToday } from './dateUtils'
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { riskPacketChecksum,canonicalRiskJson } from './riskPacketCodec'
import { buildMarketRegimeFactorPacket,upsertMarketRegimeFactorPacket,validFactorPacketPolicy } from './marketRegimeFactorPacket'
import { readMarketRegimeStateForDate,readMarketRegimeStateHistory } from './marketRegimeState'
import { getRiskConfig,riskConfigUnavailable,riskScoringPolicy } from './riskConfig'
import { marketRiskLevelPolicy,storedRiskV2Drift,storedRiskV2FromQuality } from './marketRiskStressV2'
export const MARKET_RISK_LATEST_CACHE_KEYS = [
  'market:risk:latest',
  'market:risk:latest:v4-context',
  'market:risk:latest:v19-finlab-risk-detail',
  'market:risk:latest:v20-finlab-risk-detail-oi-delta',
  'market:risk:latest:v21-runtime-level',
]

async function clearMarketRiskLatestCaches(env: Bindings): Promise<void> {
  await Promise.allSettled(MARKET_RISK_LATEST_CACHE_KEYS.map((key) => env.KV.delete(key)))
}

async function storedRiskV2Statement(db:D1Database,quality:any,qualityChecksum:string,portfolio:Parameters<typeof storedRiskV2FromQuality>[1]){
  const stress=storedRiskV2FromQuality(quality,portfolio)
  if(!stress)throw new Error('market_risk_stress_v2_inputs_invalid')
  return db.prepare(`INSERT OR REPLACE INTO market_risk_stress_v2
    (date,schema_version,status,score,calibrated_score,level,quality_checksum,json,checksum,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
    stress.date,stress.schema_version,stress.status,stress.score,stress.calibrated_score,stress.level,qualityChecksum,
    canonicalRiskJson(stress),await riskPacketChecksum(stress),new Date().toISOString())
}

export async function recomputeDailyMarketRisk(env:Bindings,twDate:string) {
  const parsed=new Date(twDate+'T00:00:00Z')
  if(!/^\d{4}-\d{2}-\d{2}$/.test(twDate)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==twDate||twDate>twToday())throw new Error('market_risk_date_invalid')
  const marketDb=databaseForDataDomain(env,'market'),coreDb=databaseForDataDomain(env,'core')
  const riskConfig=await getRiskConfig(env.KV)
  // A missing / unreadable trading:risk_config never writes v2. The KV-independent v1 row + receipt and a packet
  // flagged as built on built-in defaults are still written (what main wrote), so HMM still runs and the runtime
  // keeps de-risking existing positions; new risk is blocked there. The result carries risk_config_unavailable
  // (regime-compute summary, admin recompute 503); the nightly kv-config-drift task fails during the outage.
  const configUnavailable=riskConfigUnavailable(riskConfig)
  const portfolio=riskScoringPolicy(riskConfig.portfolio)
  const levelPolicy=marketRiskLevelPolicy(portfolio)
  if(!levelPolicy)throw new Error('market_risk_level_policy_invalid')
  // Checked before any write, so an invalid packet policy cannot leave market_risk written without its packet.
  if(!validFactorPacketPolicy(portfolio.factorPacketPolicy))throw new Error('factor_packet_policy_invalid')
  const { calcMarketRisk } = await import('./marketRisk')
  const shouldRecomputeRisk = twDate === twToday()
  const existingRisk = shouldRecomputeRisk
    ? null
    : await databaseForDataDomain(env, 'core').prepare('SELECT * FROM market_risk WHERE date=? LIMIT 1').bind(twDate).first<any>()
  const existingQuality=await databaseForDataDomain(env,'core').prepare('SELECT * FROM market_risk_quality_v1 WHERE date=?').bind(twDate).first<any>()
  let qualityValid=false,preservedQuality:any=null
  try{
    const decoded=JSON.parse(existingQuality?.json??'null')
    qualityValid=existingQuality?.schema_version==='market-risk-quality-v1'&&existingQuality.status==='complete'
      &&decoded?.schema_version===existingQuality.schema_version&&decoded?.date===twDate&&decoded?.status==='complete'
      &&decoded.known_score===existingRisk?.risk_score&&decoded.upper_score===existingRisk?.risk_score
      &&Array.isArray(decoded.missing)&&decoded.missing.length===0&&Array.isArray(decoded.critical_missing)&&decoded.critical_missing.length===0
      &&await riskPacketChecksum(decoded)===existingQuality.checksum
    if(qualityValid)preservedQuality=decoded
  }catch{ /* invalid old receipts are recomputed, never preserved or imputed */ }
  const existingRiskComplete = qualityValid && existingRisk
    && existingRisk.twii_close != null
    && existingRisk.twii_ma20 != null
    && existingRisk.twii_bias != null
    && existingRisk.twii_vol20 != null
  if (!shouldRecomputeRisk && existingRiskComplete) {
    console.log(`[ML V2] Market risk preserved for backfill date=${twDate}; skip current-market overwrite`)
    const regimeState = await readMarketRegimeStateHistory(marketDb,twDate).catch(()=>null) ?? await readMarketRegimeStateForDate(env.KV,twDate).catch(()=>null)
    const packet = await buildMarketRegimeFactorPacket(marketDb, existingRisk, regimeState, levelPolicy.factorPacket, portfolio.factorPacketPolicy)
    if(configUnavailable)packet.lineage={...packet.lineage,risk_config:'unavailable_builtin_defaults'}
    // Build v2 before touching the packet, so a receipt v2 cannot score leaves both untouched.
    const stressStatement=configUnavailable ? null : await storedRiskV2Statement(coreDb,preservedQuality,existingQuality.checksum,portfolio)
    await upsertMarketRegimeFactorPacket(marketDb, packet)
    await stressStatement?.run()
    await clearMarketRiskLatestCaches(env)
    console.log(`[ML V2] Market regime factor packet refreshed from preserved row: ${packet.level} (${packet.score}/100) date=${packet.date}`)
  } else {
    const risk = await calcMarketRisk(
      marketDb,
      env.ML_CONTROLLER_URL,
      env.ML_CONTROLLER_SECRET,
      twDate,
      levelPolicy.storedV1,
    )
    const riskStatement=databaseForDataDomain(env, 'core').prepare(`
      INSERT OR REPLACE INTO market_risk
        (date, vix, vix_level, twii_close, twii_vol20, twii_ma20, twii_bias,
         foreign_consecutive_sell, foreign_net_5d, margin_ratio,
         limit_down_count, limit_down_pct, risk_score, risk_level, risk_summary,
         adl_value, adl_trend, bull_alignment_count, bull_alignment_pct)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      risk.date,
      risk.vix,
      risk.vixLevel,
      risk.twiiClose,
      risk.twiiVol20,
      risk.twiiMa20,
      risk.twiiBias,
      risk.foreignConsecutiveSell,
      risk.foreignNet5d,
      risk.marginRatio,
      risk.limitDownCount,
      risk.limitDownPct,
      risk.riskScore,
      risk.riskLevel,
      risk.riskSummary,
      risk.adlValue,risk.adlTrend,risk.bullAlignmentCount,risk.bullAlignmentPct,
    )
    const qualityJson=canonicalRiskJson(risk.quality),qualityChecksum=await riskPacketChecksum(risk.quality)
    const qualityStatement=databaseForDataDomain(env,'core').prepare(`INSERT OR REPLACE INTO market_risk_quality_v1
      (date,schema_version,status,known_score,upper_score,json,checksum,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(
      risk.date,risk.quality.schema_version,risk.quality.status,risk.quality.known_score,risk.quality.upper_score,
      qualityJson,qualityChecksum,new Date().toISOString())
    // v2 is derived from the same receipt and lands atomically with it; v1 risk_score is unchanged.
    const stressStatement=configUnavailable ? null : await storedRiskV2Statement(coreDb,JSON.parse(qualityJson),qualityChecksum,portfolio)
    await databaseForDataDomain(env,'core').batch(stressStatement ? [riskStatement,qualityStatement,stressStatement] : [riskStatement,qualityStatement])
    await marketDb.prepare('UPDATE market_breadth SET bull_alignment_pct=? WHERE date=?').bind(risk.bullAlignmentPct,risk.date).run()
    const regimeState = await readMarketRegimeStateHistory(marketDb,twDate).catch(()=>null) ?? await readMarketRegimeStateForDate(env.KV,twDate).catch(()=>null)
    const packet = await buildMarketRegimeFactorPacket(marketDb, {
      date: risk.date,
      vix: risk.vix,
      vix_level: risk.vixLevel,
      twii_close: risk.twiiClose,
      twii_vol20: risk.twiiVol20,
      twii_ma20: risk.twiiMa20,
      twii_bias: risk.twiiBias,
      foreign_consecutive_sell: risk.foreignConsecutiveSell,
      foreign_net_5d: risk.foreignNet5d,
      margin_ratio: risk.marginRatio,
      limit_down_count: risk.limitDownCount,
      limit_down_pct: risk.limitDownPct,
      risk_score: risk.riskScore,
      risk_level: risk.riskLevel,
      risk_summary: risk.riskSummary,
      adl_value:risk.adlValue,adl_trend:risk.adlTrend,bull_alignment_count:risk.bullAlignmentCount,bull_alignment_pct:risk.bullAlignmentPct,
    }, regimeState, levelPolicy.factorPacket, portfolio.factorPacketPolicy)
    if(configUnavailable)packet.lineage={...packet.lineage,risk_config:'unavailable_builtin_defaults'}
    await upsertMarketRegimeFactorPacket(marketDb, packet)
    await clearMarketRiskLatestCaches(env)
    console.log(`[ML V2] Market risk: ${packet.level} (${packet.score}/100) date=${risk.date}`)
  }
  const readback=await databaseForDataDomain(env,'core').prepare('SELECT r.risk_score,q.* FROM market_risk r JOIN market_risk_quality_v1 q ON r.date=q.date WHERE r.date=?').bind(twDate).first<any>()
  if(!readback||readback.date!==twDate||readback.risk_score!==readback.upper_score||await riskPacketChecksum(JSON.parse(readback.json))!==readback.checksum)throw new Error('market_risk_quality_readback_failed')
  const result={date:twDate,owner:'market-risk-quality-v1' as const,quality_status:readback.status,
    known_score:readback.known_score,upper_score:readback.upper_score,quality_checksum:readback.checksum,
    model_training:false,prediction_pipeline_started:false}
  // No v2 under an unavailable config: after KV is back, rerun this date to write v2 and an unflagged packet.
  if(configUnavailable)return {...result,risk_config_unavailable:true as const}
  const stress=await coreDb.prepare('SELECT * FROM market_risk_stress_v2 WHERE date=?').bind(twDate).first<any>()
  if(!stress||stress.quality_checksum!==readback.checksum||await riskPacketChecksum(JSON.parse(stress.json))!==stress.checksum)throw new Error('market_risk_stress_v2_readback_failed')
  // Written under the current KV: it must recompute exactly from the receipt and echo the current policy.
  const drift=await storedRiskV2Drift(stress,readback,riskConfig.portfolio)
  if(!drift.ok||drift.policyChanged)throw new Error('market_risk_stress_v2_drift '+JSON.stringify(drift))
  return {...result,risk_config_unavailable:false as const}
}

/**
 * Nightly drift check of stored v2 rows (read-only). Each row must equal a recompute of its quality receipt under
 * the KV policy echoed in it. A receipt written after the first v2 row (same batch since go-live) without its v2
 * row is also a drift; receipts written before v2 existed are skipped. Rows whose echoed policy differs from the
 * current KV are reported (expected after a KV change), not failed.
 */
export async function runStoredRiskV2DriftCheck(coreDb:D1Database,portfolio:Parameters<typeof storedRiskV2Drift>[2],sinceDate:string){
  if(portfolio.configUnavailable===true)throw new Error('risk_config_unavailable')
  if(!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate))throw new Error('stored_risk_v2_drift_since_invalid')
  // SEARCH market_risk_quality_v1 by PK range, then SEARCH market_risk_stress_v2 by PK.
  const {results}=await coreDb.prepare(`SELECT q.date AS q_date,q.json AS q_json,q.checksum AS q_checksum,q.updated_at AS q_updated_at,s.*
    FROM market_risk_quality_v1 q LEFT JOIN market_risk_stress_v2 s ON s.date=q.date WHERE q.date>=? ORDER BY q.date`).bind(sinceDate).all<any>()
  const rows=results??[]
  const stored=rows.filter(row=>row.date!=null).map(row=>String(row.updated_at)).sort()
  const liveSince=stored[0]??null
  if(liveSince==null&&rows.length){
    // No v2 row in the window although receipts exist: only fine if v2 never went live (table empty).
    const latest=await coreDb.prepare('SELECT MAX(date) AS date FROM market_risk_stress_v2').first<any>()
    if(latest?.date!=null){
      const summary=`stored_risk_v2_drift since=${sinceDate} checked=0 failed=1 v2_rows_stopped latest=${latest.date}`
      return {ok:false,summary,failures:[{date:String(rows.at(-1).q_date),mismatches:['v2_rows_stopped']}],policyChanged:[] as string[]}
    }
  }
  const failures:Array<{date:string;mismatches:string[]}>=[],policyChanged:string[]=[]
  let checked=0,skipped=0
  for(const row of rows){
    if(row.date==null&&(liveSince==null||String(row.q_updated_at)<liveSince)){skipped+=1;continue}
    checked+=1
    const drift=row.date==null
      ?{ok:false,mismatches:['row_missing'],policyChanged:false}
      :await storedRiskV2Drift(row,{date:row.q_date,json:row.q_json,checksum:row.q_checksum},portfolio)
    if(!drift.ok)failures.push({date:row.q_date,mismatches:drift.mismatches})
    if(drift.policyChanged)policyChanged.push(row.q_date)
  }
  const summary=`stored_risk_v2_drift since=${sinceDate} checked=${checked} skipped_pre_v2=${skipped} failed=${failures.length} policy_changed=${policyChanged.length}`
  return {ok:failures.length===0,summary,failures,policyChanged}
}
