import { riskPacketChecksum } from './riskPacketCodec'
import { getPrevTradingDay } from './paperMarketData'
import { paperExecutionNow } from './paperExecutionScope'
import type { RiskConfig } from './riskConfig'
import type { MarketRegimeState } from './marketRegimeState'
import { readMarketRegimeStateForDate, readMarketRegimeStateHistory } from './marketRegimeState'
import type { MarketRegimeFactorPacket } from './marketRegimeFactorPacket'
import { loadMarketRegimeFactorPacket } from './marketRegimeFactorPacket'

export type CanonicalMarketRiskLevel = 'green' | 'yellow' | 'orange' | 'red' | 'black'

export interface CanonicalMarketRiskContext {
  status: 'ready' | 'blocked'
  date: string | null
  level: CanonicalMarketRiskLevel
  score: number | null
  targetExposureCap: number | null
  deRiskExistingPositions: boolean
  haltNewBuys: boolean
  dailyChangePct: number | null
  advanceRatio: number | null
  bullAlignmentRatio: number | null
  regimeFamily: string | null
  factorPacketLevel: CanonicalMarketRiskLevel | null
  storedRiskLevel: CanonicalMarketRiskLevel | null
  breadthLevel: CanonicalMarketRiskLevel | null
  shockLevel: CanonicalMarketRiskLevel | null
  reasons: string[]
  blockers: string[]
  lineage: {
    owner: 'canonical_market_risk_runtime_v1' | 'canonical_market_risk_runtime_v2' | 'canonical_market_risk_runtime_v3'
    policyVersion?: string
    expectedPreviousSession?: string | null
    expectedSession?: string | null
    factorPacketDate: string | null
    marketRiskDate: string | null
    breadthDate: string | null
    qualityChecksum?: string | null
    hmmModelSha256?: string | null
    hmmInputChecksum?: string | null
    regimeDate: string | null
  }
}

interface MarketRiskRow {
  date?: unknown
  twii_close?: unknown
  risk_score?: unknown
  risk_level?: unknown
}

interface MarketBreadthRow {
  date?: unknown
  advance_ratio?: unknown
  bull_alignment_pct?: unknown
}

export interface CanonicalMarketRiskInputs {
  marketRiskRows: MarketRiskRow[]
  factorPacket: MarketRegimeFactorPacket | null
  breadth: MarketBreadthRow | null
  regimeState: MarketRegimeState | null
  policy: RiskConfig['portfolio']
  quality?: {date:string;status:string;known_score:number;upper_score:number;checksum:string;json:string;schema_version:string} | null
  decisionAsOfMs?: number
  expectedPreviousSession?: string
  expectedSession?: string
}

export interface CanonicalMarketRiskDatabases {
  core: D1Database
  market: D1Database
}

const LEVEL_RANK: Record<CanonicalMarketRiskLevel, number> = {
  green: 0,
  yellow: 1,
  orange: 2,
  red: 3,
  black: 4,
}

function finiteNumber(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeCanonicalMarketRiskLevel(value: unknown): CanonicalMarketRiskLevel | null {
  const level = String(value ?? '').trim().toLowerCase()
  if (['black', 'halt', 'closed', 'extreme'].includes(level)) return 'black'
  if (['red', 'very_high', 'bear', 'bear_market'].includes(level)) return 'red'
  if (['orange', 'high', 'volatile'].includes(level)) return 'orange'
  if (['yellow', 'medium', 'sideways', 'neutral', 'normal'].includes(level)) return 'yellow'
  if (['green', 'low', 'bull', 'bull_market', 'constructive'].includes(level)) return 'green'
  return null
}

function maxLevel(levels: Array<CanonicalMarketRiskLevel | null>): CanonicalMarketRiskLevel {
  return levels.reduce<CanonicalMarketRiskLevel>((highest, current) => (
    current && LEVEL_RANK[current] > LEVEL_RANK[highest] ? current : highest
  ), 'green')
}

function targetExposureCap(level: CanonicalMarketRiskLevel, policy: RiskConfig['portfolio']): number {
  if (level === 'black') return policy.blackTargetExposure
  if (level === 'red') return policy.redTargetExposure
  if (level === 'orange') return policy.orangeTargetExposure
  if (level === 'yellow') return policy.yellowTargetExposure
  return policy.greenTargetExposure
}

function marketShockLevel(changePct: number | null, policy: RiskConfig['portfolio']): CanonicalMarketRiskLevel | null {
  if (changePct == null) return null
  const change = changePct / 100
  if (change <= policy.marketShockBlackPct) return 'black'
  if (change <= policy.marketShockRedPct) return 'red'
  if (change <= policy.marketShockOrangePct) return 'orange'
  return null
}

function marketBreadthLevel(advanceRatio: number | null, policy: RiskConfig['portfolio']): CanonicalMarketRiskLevel | null {
  if (advanceRatio == null) return null
  if (advanceRatio <= policy.breadthBlackAdvanceRatio) return 'black'
  if (advanceRatio <= policy.breadthRedAdvanceRatio) return 'red'
  if (advanceRatio <= policy.breadthOrangeAdvanceRatio) return 'orange'
  return null
}

function regimeRiskLevel(regimeState: MarketRegimeState | null, constructiveVolatile: boolean): CanonicalMarketRiskLevel | null {
  if (regimeState?.family === 'bear') return 'red'
  if (regimeState?.family === 'volatile') return constructiveVolatile ? 'green' : 'orange'
  if (regimeState?.family === 'sideways') return 'yellow'
  if (regimeState?.family === 'bull') return 'green'
  return null
}

export const MARKET_RISK_POLICY_VERSION = 'market-direction-stress-v3'
export const HMM_INPUT_CONTRACT = '8b6542b50ea5c57c768e76bd517712e42579141cc1533169f2046cffce1a5e5f'

function constructiveVolatile(input: CanonicalMarketRiskInputs, shock: CanonicalMarketRiskLevel | null,
  breadth: CanonicalMarketRiskLevel | null): boolean {
  if (input.regimeState?.family !== 'volatile' || shock || breadth || !(input.quality?.status==='complete'||input.quality?.status==='bounded'&&input.quality.known_score===input.quality.upper_score)) return false
  const alignment=finiteNumber(input.breadth?.bull_alignment_pct)
  const advances=finiteNumber(input.breadth?.advance_ratio)
  if(alignment==null||alignment<55||alignment>100||advances==null||advances<.58||advances>1)return false
  const ordinary = (value: unknown) => ['green','yellow'].includes(normalizeCanonicalMarketRiskLevel(value) ?? '')
  if (!ordinary(input.factorPacket?.level) || !ordinary(input.marketRiskRows[0]?.risk_level)) return false
  const evidence = (input.regimeState.regime_evidence as any)?.evidence
  const trend = evidence?.price_trend, global = evidence?.global_risk
  const bias = finiteNumber(trend?.metrics?.twii_bias_20d), return5d = finiteNumber(trend?.metrics?.twii_return_5d)
  const vol10d=finiteNumber(evidence?.atr_vturn?.metrics?.realized_vol_10d)
  if(vol10d==null || vol10d<=0 || 3*vol10d>=Math.abs(input.policy.marketShockOrangePct))return false
  // This stress proxy is not a claimed portfolio VaR. Relief needs trend/global evidence and non-acute realized volatility.
  return trend?.status === 'available' && trend?.stance === 'bullish' && bias != null && bias > 0
    && return5d != null && return5d > 0 && global?.status === 'available' && global?.stance === 'bullish'
}

export function buildCanonicalMarketRiskContext(input: CanonicalMarketRiskInputs): CanonicalMarketRiskContext {
  const rows = [...input.marketRiskRows]
    .filter((row) => String(row.date ?? '').trim())
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
  const latest = rows[0] ?? null
  const previous = rows[1] ?? null
  const marketRiskDate = latest ? String(latest.date) : null
  const factorPacketDate = input.factorPacket?.date ?? null
  const breadthDate = input.breadth?.date ? String(input.breadth.date) : null
  const regimeDate = input.regimeState?.run_date ?? null
  const blockers: string[] = []

  if (!latest) blockers.push('market_risk_missing')
  if (!previous && !input.quality) blockers.push('market_risk_previous_close_missing')
  if (!input.factorPacket) blockers.push('market_regime_factor_packet_missing')
  if (!input.breadth) blockers.push('market_breadth_missing')
  if (!input.regimeState) blockers.push('market_regime_state_missing')
  if (input.expectedSession && marketRiskDate !== input.expectedSession) blockers.push('market_risk_expected_session_mismatch')
  if (marketRiskDate && factorPacketDate !== marketRiskDate) blockers.push('factor_packet_date_mismatch')
  if (marketRiskDate && breadthDate !== marketRiskDate) blockers.push('market_breadth_date_mismatch')
  if (marketRiskDate && regimeDate !== marketRiskDate) blockers.push('market_regime_date_mismatch')

  let benchmarkRows:any[]=[]
  try{benchmarkRows=JSON.parse(input.quality?.json??'null')?.sources?.benchmark?.sessions??[]}catch{}
  const hasBenchmark=Array.isArray(benchmarkRows)&&benchmarkRows.length>=21
  const currentClose = finiteNumber(hasBenchmark?benchmarkRows.at(-1)?.close:latest?.twii_close)
  const previousClose = finiteNumber(hasBenchmark?benchmarkRows.at(-2)?.close:previous?.twii_close)
  if(hasBenchmark && (benchmarkRows.at(-1)?.date!==marketRiskDate || currentClose!==finiteNumber(latest?.twii_close)
    ||input.expectedPreviousSession && benchmarkRows.at(-2)?.date!==input.expectedPreviousSession))blockers.push('market_risk_benchmark_price_lineage_mismatch')
  if (currentClose == null || currentClose <= 0) blockers.push('market_risk_twii_close_missing')
  if (previousClose == null || previousClose <= 0) blockers.push('market_risk_previous_twii_close_missing')
  const advanceRatio = finiteNumber(input.breadth?.advance_ratio)
  const alignmentPct = finiteNumber(input.breadth?.bull_alignment_pct)
  const bullAlignmentRatio = alignmentPct==null ? null : alignmentPct/100
  if (advanceRatio == null || advanceRatio < 0 || advanceRatio > 1) blockers.push('market_breadth_advance_ratio_missing')
  if(bullAlignmentRatio==null||bullAlignmentRatio<0||bullAlignmentRatio>1)blockers.push('market_breadth_alignment_missing')

  const quality=input.quality
  if(!quality||quality.schema_version!=='market-risk-quality-v1'||quality.date!==marketRiskDate||!['complete','bounded'].includes(quality.status)
    ||!Number.isFinite(quality.known_score)||!Number.isFinite(quality.upper_score)||quality.known_score<0||quality.upper_score<quality.known_score||quality.upper_score>100
    ||quality.upper_score!==finiteNumber(latest?.risk_score)||!/^[a-f0-9]{64}$/.test(quality.checksum))blockers.push('market_risk_quality_unverified')
  const provenance=(input.regimeState?.regime_evidence as any)?.hmm_provenance
  const model=provenance?.model
  if(input.regimeState?.source!=='hmm'||provenance?.input_contract!==HMM_INPUT_CONTRACT||provenance?.feature_date!==marketRiskDate
    ||provenance?.risk_quality_checksum!==quality?.checksum||model?.input_contract!==HMM_INPUT_CONTRACT||!/^[a-f0-9]{64}$/.test(model?.sha256??'')||!/^\d+$/.test(model?.generation??'')
    ||!/^[a-f0-9]{64}$/.test(provenance?.input_checksum??''))blockers.push('hmm_model_input_contract_unverified')

  if(input.decisionAsOfMs!==undefined){
    const computed=Date.parse(input.regimeState?.computed_at??''),asof=Date.parse(provenance?.inference_as_of??''),trained=Date.parse(model?.trained_at??'')
    if(!Number.isFinite(computed)||!Number.isFinite(asof)||!Number.isFinite(trained)||trained>asof||asof>computed||computed>input.decisionAsOfMs||input.decisionAsOfMs-trained>9*86400000)blockers.push('hmm_inference_clock_unverified')
  }

  const dailyChangePct = currentClose != null && previousClose != null && previousClose > 0
    ? ((currentClose / previousClose) - 1) * 100
    : null
  const factorPacketLevel = normalizeCanonicalMarketRiskLevel(input.factorPacket?.level)
  const storedRiskLevel = normalizeCanonicalMarketRiskLevel(latest?.risk_level)
  const shockLevel = marketShockLevel(dailyChangePct, input.policy)
  const breadthLevel = marketBreadthLevel(advanceRatio, input.policy)
  if (factorPacketLevel == null) blockers.push('factor_packet_level_invalid')
  if (storedRiskLevel == null) blockers.push('market_risk_level_invalid')
  const caps = ['black','red','orange','yellow','green'].map(level => targetExposureCap(level as CanonicalMarketRiskLevel,input.policy))
  if (caps.some((value,index) => !Number.isFinite(value) || value < 0 || value > 1 || index > 0 && value < caps[index-1])) blockers.push('risk_exposure_policy_invalid')
  const relief = constructiveVolatile({...input,marketRiskRows:rows},shockLevel,breadthLevel)
  const regimeLevel = regimeRiskLevel(input.regimeState,relief)
  const level = maxLevel([factorPacketLevel, storedRiskLevel, shockLevel, breadthLevel, regimeLevel])
  const packetScore = finiteNumber(input.factorPacket?.score)
  const storedScore = finiteNumber(latest?.risk_score)
  const score = packetScore == null ? storedScore : storedScore == null ? packetScore : Math.max(packetScore, storedScore)
  const reasons = [
    relief ? 'volatile_direction_confirmed_no_stress' : null,
    factorPacketLevel ? `factor_packet=${factorPacketLevel}:${packetScore ?? 'na'}` : null,
    storedRiskLevel ? `stored_risk=${storedRiskLevel}:${storedScore ?? 'na'}` : null,
    shockLevel ? `market_shock=${shockLevel}:return_1d=${dailyChangePct?.toFixed(2)}%` : null,
    breadthLevel ? `market_breadth=${breadthLevel}:advance_ratio=${advanceRatio?.toFixed(4)}` : null,
    regimeLevel ? `regime=${regimeLevel}:${input.regimeState?.family ?? 'unknown'}` : null,
  ].filter((reason): reason is string => Boolean(reason))
  const status = blockers.length === 0 ? 'ready' : 'blocked'

  return {
    status,
    date: marketRiskDate,
    level: status === 'ready' ? level : 'black',
    score: status === 'ready' ? score : null,
    targetExposureCap: status === 'ready' ? targetExposureCap(level, input.policy) : null,
    deRiskExistingPositions: status === 'ready' && LEVEL_RANK[level] >= LEVEL_RANK.orange,
    haltNewBuys: status === 'blocked' || level === 'black',
    dailyChangePct,
    advanceRatio,
    bullAlignmentRatio,
    regimeFamily: input.regimeState?.family ?? null,
    factorPacketLevel,
    storedRiskLevel,
    breadthLevel,
    shockLevel,
    reasons,
    blockers: [...new Set(blockers)],
    lineage: {
      owner: 'canonical_market_risk_runtime_v3',
      qualityChecksum:quality?.checksum??null,
      hmmModelSha256:model?.sha256??null,
      hmmInputChecksum:provenance?.input_checksum??null,
      policyVersion: MARKET_RISK_POLICY_VERSION,
      expectedSession: input.expectedSession ?? null,
      expectedPreviousSession:input.expectedPreviousSession??null,
      factorPacketDate,
      marketRiskDate,
      breadthDate,
      regimeDate,
    },
  }
}

export async function resolveCanonicalMarketRisk(
  databases: CanonicalMarketRiskDatabases,
  kv: KVNamespace | undefined,
  riskConfig: RiskConfig,
): Promise<CanonicalMarketRiskContext> {
  if (!kv) {
    return buildCanonicalMarketRiskContext({
      marketRiskRows: [],
      factorPacket: null,
      breadth: null,
      regimeState: null,
      policy: riskConfig.portfolio,
    })
  }
  try {
    const decisionDate = new Date(paperExecutionNow()+8*3600000).toISOString().slice(0,10)
    const expectedSession = await getPrevTradingDay(databases.core,kv,decisionDate)
    const expectedPreviousSession=await getPrevTradingDay(databases.core,kv,expectedSession)
    const [{ results: marketRiskRows }, factorPacket, breadth, rawQuality] = await Promise.all([
      databases.core.prepare(
        'SELECT date, twii_close, risk_score, risk_level FROM market_risk ORDER BY date DESC LIMIT 2',
      ).all<MarketRiskRow>(),
      loadMarketRegimeFactorPacket(databases.market).catch(() => null),
      databases.market.prepare(
        'SELECT date, advance_ratio, bull_alignment_pct FROM market_breadth ORDER BY date DESC LIMIT 1',
      ).first<MarketBreadthRow>().catch(() => null),
      databases.core.prepare('SELECT * FROM market_risk_quality_v1 WHERE date=?').bind(expectedSession).first<NonNullable<CanonicalMarketRiskInputs['quality']>>().catch(()=>null),
    ])
    let quality: CanonicalMarketRiskInputs['quality']=null
    if(rawQuality){
      try{
        const decoded=JSON.parse(rawQuality.json)
        const benchmark=decoded.sources?.benchmark,sessions=benchmark?.sessions
        const validBenchmark=Array.isArray(sessions)&&sessions.length===21&&sessions.at(-1)?.date===expectedSession
          &&sessions.at(-2)?.date===expectedPreviousSession
          &&['finlab.taiex_total_index','twse.mi_5mins_hist.official'].includes(benchmark?.source)
          &&sessions.every((row:any,index:number)=>Number.isFinite(row.close)&&row.close>0&&row.source===benchmark.source&&(index===0||row.date>sessions[index-1].date))
        if(validBenchmark&&await riskPacketChecksum(decoded)===rawQuality.checksum && decoded.date===rawQuality.date && decoded.status===rawQuality.status
          &&decoded.known_score===rawQuality.known_score&&decoded.upper_score===rawQuality.upper_score
          &&decoded.schema_version===rawQuality.schema_version && Array.isArray(decoded.critical_missing)&&decoded.critical_missing.length===0
          &&Array.isArray(decoded.missing)&&(decoded.status!=='complete'||decoded.missing.length===0))quality=rawQuality
      }catch{ /* corrupt records remain unavailable */ }
    }
    // The latest market session survives weekends; the short-lived KV pointer may not.
    // Read the exact dated, checksum-verified history without writing or selecting another date.
    const rawDate = marketRiskRows?.[0]?.date
    const riskDate = typeof rawDate === 'string' ? rawDate : null
    const regimeState = riskDate
      ? await readMarketRegimeStateHistory(databases.market, riskDate)
        ?? await readMarketRegimeStateForDate(kv, riskDate)
      : null
    return buildCanonicalMarketRiskContext({
      decisionAsOfMs:paperExecutionNow(),
      expectedSession,
      expectedPreviousSession,
      quality,
      marketRiskRows: marketRiskRows ?? [],
      factorPacket,
      breadth,
      regimeState,
      policy: riskConfig.portfolio,
    })
  } catch (error) {
    const blocked = buildCanonicalMarketRiskContext({
      marketRiskRows: [],
      factorPacket: null,
      breadth: null,
      regimeState: null,
      policy: riskConfig.portfolio,
    })
    blocked.blockers.push(`canonical_market_risk_read_error:${error instanceof Error ? error.message : String(error)}`)
    return blocked
  }
}
