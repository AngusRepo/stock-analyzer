/**
 * p7Streak.ts — Layer 7: Recent prediction streak (nofx-inspired 急性降載)
 * Uses five mature, nonoverlapping date cohorts of the current ensemble.
 * Equal-date aggregate wrong score ≥4 reduces sizing by the configured scale.
 * 2026-04-21 R1 extract from paper.ts L7.
 */
import type { TradingConfig } from '../tradingConfig'
import type { LegacyLayerDeps, LegacyLayerResult } from '../riskTypes'
import { failClosedRiskCheck } from './failClosed'
import { paperExecutionDate } from '../paperExecutionScope'

export interface PredictionCohort {date:string;end_date:string;accuracy:number;samples:number}
/** Equal date weights and disjoint label windows; correlated stocks are not trials. */
export function independentPredictionCohorts(rows:PredictionCohort[]) {
  const chosen:PredictionCohort[]=[]
  for(const row of [...rows].sort((a,b)=>b.date.localeCompare(a.date))) {
    if(!Number.isFinite(row.accuracy) || row.accuracy<0 || row.accuracy>1 || row.samples<1) continue
    if(chosen.length && row.end_date>=chosen[chosen.length-1].date) continue
    chosen.push(row)
    if(chosen.length===5) break
  }
  return chosen
}

export async function checkP7Streak(
  db: D1Database,
  cfg: TradingConfig,
  deps: LegacyLayerDeps,
): Promise<LegacyLayerResult> {
  const cc = cfg.circuit
  const { defaults } = deps

  try {
    const identity=await db.prepare('SELECT artifact_id,cohort_id,payload_checksum,base_artifact_set_checksum FROM active8_ensemble_pointer_v1 WHERE singleton_id=1')
      .first<{artifact_id:string;cohort_id:string;payload_checksum:string;base_artifact_set_checksum:string}>()
    if(!identity) return null // No published identity: P7 has no valid population.
    const now=paperExecutionDate().toISOString(),today=new Date(paperExecutionDate().getTime()+8*3600000).toISOString().slice(0,10)
    const { results: recent } = await db.prepare(`
      WITH eligible AS (
        SELECT prediction_date,verification_label_end_date,direction_correct,
          ROW_NUMBER() OVER(PARTITION BY prediction_date,stock_id ORDER BY generated_at DESC,id DESC) AS n
        FROM predictions WHERE model_name='ensemble' AND direction_correct IN (0,1)
          AND verified_at IS NOT NULL AND datetime(verified_at)<=datetime(?) AND datetime(generated_at)<=datetime(?)
          AND verification_label_known_date<=? AND verification_label_end_date<=?
          AND prediction_date<verification_label_end_date
          AND json_valid(forecast_data)
          AND json_extract(forecast_data,'$.ensemble_v2.artifact_id')=?
          AND json_extract(forecast_data,'$.ensemble_v2.cohort_id')=?
          AND json_extract(forecast_data,'$.ensemble_v2.artifact_checksum')=?
          AND json_extract(forecast_data,'$.ensemble_v2.base_artifact_set_checksum')=?
          AND json_extract(forecast_data,'$.ensemble_v2.forecast_horizon_bars')=5
          AND verification_label_schema_version='next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
      ) SELECT prediction_date AS date,MAX(verification_label_end_date) AS end_date,
          AVG(CAST(direction_correct AS REAL)) AS accuracy,COUNT(*) AS samples
        FROM eligible WHERE n=1 GROUP BY prediction_date ORDER BY prediction_date DESC LIMIT 100
    `).bind(now,now,today,today,identity.artifact_id,identity.cohort_id,identity.payload_checksum,identity.base_artifact_set_checksum)
      .all<PredictionCohort>()
    const cohorts=independentPredictionCohorts(recent ?? [])
    if(cohorts.length<5) return null
    const wrongCount=cohorts.reduce((n,row)=>n+1-row.accuracy,0)
    if(wrongCount<4) return null

    const layer7Scale = cc.layer7ScaleRatio
    if(!Number.isFinite(layer7Scale) || layer7Scale<0 || layer7Scale>1) throw new Error('p7_scale_invalid')
    const adjusted = defaults.maxPositionPct * layer7Scale
    console.warn(
      `[CircuitBreaker] Layer7 SCALE: recent streak ${wrongCount}/5 wrong ` +
      `→ posPct ${(adjusted * 100).toFixed(1)}% (× ${layer7Scale})`
    )
    return {
      ...defaults,
      maxPositionPct: adjusted,
      reason: `現行ensemble五個不重疊五日標籤批次，等日期平均錯誤率 ${(wrongCount/5*100).toFixed(1)}%（模型降載）`,
    }
  } catch (e) {
    console.error('[CircuitBreaker] Layer7 check failed; fail closed:', e)
    return failClosedRiskCheck('P7', e, deps)
  }
}
