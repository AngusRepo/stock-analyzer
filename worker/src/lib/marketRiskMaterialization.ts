import { twToday } from './dateUtils'
import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'
import { riskPacketChecksum,canonicalRiskJson } from './riskPacketCodec'
import { buildMarketRegimeFactorPacket,upsertMarketRegimeFactorPacket,type CanonicalWriteMode } from './marketRegimeFactorPacket'
import { historicalLearningLineageDecision } from './historicalLearningLineageGuard'
import { paperExecutionDate,paperExecutionNow } from './paperExecutionScope'
import { readMarketRegimeStateForDate,readMarketRegimeStateHistory } from './marketRegimeState'
const MARKET_RISK_LATEST_CACHE_KEYS = [
  'market:risk:latest',
  'market:risk:latest:v4-context',
  'market:risk:latest:v19-finlab-risk-detail',
  'market:risk:latest:v20-finlab-risk-detail-oi-delta',
]

async function clearMarketRiskLatestCaches(env: Bindings): Promise<void> {
  await Promise.allSettled(MARKET_RISK_LATEST_CACHE_KEYS.map((key) => env.KV.delete(key)))
}

export const MARKET_RISK_PIT_TASK='market-risk-materialization'

/** PIT (Wei 10/29): once the next session has opened, a past date keeps its original rows; a
 * recomputation is only appended to the revisions tables (or fills a row that never existed). */
async function canonicalWriteMode(env:Bindings,marketDb:D1Database,twDate:string):Promise<CanonicalWriteMode> {
  const boundary=await historicalLearningLineageDecision(marketDb,env.KV,MARKET_RISK_PIT_TASK,twDate,paperExecutionNow())
  return boundary.allowed?'replace':'keep_original'
}

export async function recomputeDailyMarketRisk(env:Bindings,twDate:string) {
  const parsed=new Date(twDate+'T00:00:00Z')
  if(!/^\d{4}-\d{2}-\d{2}$/.test(twDate)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==twDate||twDate>twToday())throw new Error('market_risk_date_invalid')
  const marketDb=databaseForDataDomain(env,'market')
  const { calcMarketRisk } = await import('./marketRisk')
  const shouldRecomputeRisk = twDate === twToday()
  const existingRisk = shouldRecomputeRisk
    ? null
    : await databaseForDataDomain(env, 'core').prepare('SELECT * FROM market_risk WHERE date=? LIMIT 1').bind(twDate).first<any>()
  const existingQuality=await databaseForDataDomain(env,'core').prepare('SELECT * FROM market_risk_quality_v1 WHERE date=?').bind(twDate).first<any>()
  let qualityValid=false
  try{
    const decoded=JSON.parse(existingQuality?.json??'null')
    qualityValid=existingQuality?.schema_version==='market-risk-quality-v1'&&existingQuality.status==='complete'
      &&decoded?.schema_version===existingQuality.schema_version&&decoded?.date===twDate&&decoded?.status==='complete'
      &&decoded.known_score===existingRisk?.risk_score&&decoded.upper_score===existingRisk?.risk_score
      &&Array.isArray(decoded.missing)&&decoded.missing.length===0&&Array.isArray(decoded.critical_missing)&&decoded.critical_missing.length===0
      &&await riskPacketChecksum(decoded)===existingQuality.checksum
  }catch{ /* invalid old receipts are recomputed, never preserved or imputed */ }
  const existingRiskComplete = qualityValid && existingRisk
    && existingRisk.twii_close != null
    && existingRisk.twii_ma20 != null
    && existingRisk.twii_bias != null
    && existingRisk.twii_vol20 != null
  const mode=await canonicalWriteMode(env,marketDb,twDate)
  let revisionChecksum:string|null=null
  if (!shouldRecomputeRisk && existingRiskComplete) {
    console.log(`[ML V2] Market risk preserved for backfill date=${twDate}; skip current-market overwrite`)
    const regimeState = await readMarketRegimeStateHistory(marketDb,twDate).catch(()=>null) ?? await readMarketRegimeStateForDate(env.KV,twDate).catch(()=>null)
    const packet = await buildMarketRegimeFactorPacket(marketDb, existingRisk, regimeState)
    await upsertMarketRegimeFactorPacket(marketDb, packet, mode)
    await clearMarketRiskLatestCaches(env)
    console.log(`[ML V2] Market regime factor packet refreshed from preserved row: ${packet.level} (${packet.score}/100) date=${packet.date}`)
  } else {
    const risk = await calcMarketRisk(
      marketDb,
      env.ML_CONTROLLER_URL,
      env.ML_CONTROLLER_SECRET,
      twDate,
    )
    const riskRow={
      date:risk.date,vix:risk.vix,vix_level:risk.vixLevel,twii_close:risk.twiiClose,twii_vol20:risk.twiiVol20,
      twii_ma20:risk.twiiMa20,twii_bias:risk.twiiBias,foreign_consecutive_sell:risk.foreignConsecutiveSell,
      foreign_net_5d:risk.foreignNet5d,margin_ratio:risk.marginRatio,limit_down_count:risk.limitDownCount,
      limit_down_pct:risk.limitDownPct,risk_score:risk.riskScore,risk_level:risk.riskLevel,risk_summary:risk.riskSummary,
      adl_value:risk.adlValue,adl_trend:risk.adlTrend,bull_alignment_count:risk.bullAlignmentCount,bull_alignment_pct:risk.bullAlignmentPct,
    }
    const verb=mode==='replace'?'INSERT OR REPLACE':'INSERT OR IGNORE'
    const columns=Object.keys(riskRow)
    const riskStatement=databaseForDataDomain(env, 'core').prepare(
      `${verb} INTO market_risk (${columns.join(', ')}) VALUES (${columns.map(()=>'?').join(',')})`,
    ).bind(...Object.values(riskRow))
    const qualityJson=canonicalRiskJson(risk.quality),qualityChecksum=await riskPacketChecksum(risk.quality)
    const qualityStatement=databaseForDataDomain(env,'core').prepare(`${verb} INTO market_risk_quality_v1
      (date,schema_version,status,known_score,upper_score,json,checksum,updated_at) VALUES (?,?,?,?,?,?,?,?)`).bind(
      risk.date,risk.quality.schema_version,risk.quality.status,risk.quality.known_score,risk.quality.upper_score,
      qualityJson,qualityChecksum,new Date().toISOString())
    revisionChecksum=await riskPacketChecksum({risk:riskRow,quality:risk.quality})
    const revisionStatement=databaseForDataDomain(env,'core').prepare(`INSERT OR IGNORE INTO market_risk_revisions_v1
      (date,revision_checksum,risk_json,quality_json,canonical_mode,recorded_at) VALUES (?,?,?,?,?,?)`).bind(
      risk.date,revisionChecksum,canonicalRiskJson(riskRow),qualityJson,mode,paperExecutionDate().toISOString())
    // An existing original row and its quality receipt stay as a pair; only the revision is added.
    const keepExisting=mode==='keep_original'&&existingRisk!=null
    await databaseForDataDomain(env,'core').batch(keepExisting?[revisionStatement]:[riskStatement,qualityStatement,revisionStatement])
    await marketDb.prepare("UPDATE market_breadth SET bull_alignment_pct=? WHERE date=? AND (?='replace' OR bull_alignment_pct IS NULL)")
      .bind(risk.bullAlignmentPct,risk.date,mode).run()
    const regimeState = await readMarketRegimeStateHistory(marketDb,twDate).catch(()=>null) ?? await readMarketRegimeStateForDate(env.KV,twDate).catch(()=>null)
    const packet = await buildMarketRegimeFactorPacket(marketDb, riskRow, regimeState)
    await upsertMarketRegimeFactorPacket(marketDb, packet, mode)
    await clearMarketRiskLatestCaches(env)
    console.log(`[ML V2] Market risk: ${packet.level} (${packet.score}/100) date=${risk.date}`)
  }
  const readback=await databaseForDataDomain(env,'core').prepare('SELECT r.risk_score,q.* FROM market_risk r JOIN market_risk_quality_v1 q ON r.date=q.date WHERE r.date=?').bind(twDate).first<any>()
  if(!readback||readback.date!==twDate||readback.risk_score!==readback.upper_score||await riskPacketChecksum(JSON.parse(readback.json))!==readback.checksum)
    throw new Error(mode==='keep_original'?'market_risk_original_kept_unqualified:'+twDate:'market_risk_quality_readback_failed')
  if(revisionChecksum&&!await databaseForDataDomain(env,'core').prepare('SELECT 1 AS ok FROM market_risk_revisions_v1 WHERE date=? AND revision_checksum=?')
    .bind(twDate,revisionChecksum).first())throw new Error('market_risk_revision_readback_failed:'+twDate)
  return {date:twDate,owner:'market-risk-quality-v1',canonical_mode:mode,revision_checksum:revisionChecksum,quality_status:readback.status,
    known_score:readback.known_score,upper_score:readback.upper_score,quality_checksum:readback.checksum,
    model_training:false,prediction_pipeline_started:false}
}
