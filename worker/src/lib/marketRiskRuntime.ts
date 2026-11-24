import { riskPacketChecksum } from './riskPacketCodec'
import { HMM_MAX_AGE_MS } from './hmmLifecycle'
import { getPrevTradingDay } from './paperMarketData'
import { paperExecutionNow } from './paperExecutionScope'
import type { RiskConfig } from './riskConfig'
import { riskScoringPolicy } from './riskConfig'
import type { MarketRegimeState } from './marketRegimeState'
import { hmmProvenanceShapeValid, readHmmRegimeFamiliesBefore, readMarketRegimeStateForDate, readMarketRegimeStateHistory } from './marketRegimeState'
import type { MarketRegimeFactorPacket } from './marketRegimeFactorPacket'
import { loadMarketRegimeFactorPacket } from './marketRegimeFactorPacket'
import type { StoredRiskV2Result } from './marketRiskStressV2'
import { marketRiskLevelPolicy, storedRiskV2FromQuality } from './marketRiskStressV2'

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
  storedRiskLevel: CanonicalMarketRiskLevel | null          // stored v2 (each factor group once)
  storedRiskLevelV1: CanonicalMarketRiskLevel | null        // frozen market_risk.risk_level, reference only
  storedRiskScoreV2: number | null
  regimeFamilyRaw: string | null                            // today's HMM family before session confirmation
  breadthLevel: CanonicalMarketRiskLevel | null
  shockLevel: CanonicalMarketRiskLevel | null
  reasons: string[]
  blockers: string[]
  lineage: {
    owner: 'canonical_market_risk_runtime_v1' | 'canonical_market_risk_runtime_v2' | 'canonical_market_risk_runtime_v3' | 'canonical_market_risk_runtime_v4'
    policyVersion?: string
    expectedPreviousSession?: string | null
    expectedSession?: string | null
    factorPacketDate: string | null
    marketRiskDate: string | null
    breadthDate: string | null
    qualityChecksum?: string | null
    hmmModelSha256?: string | null
    hmmModelGeneration?: string | null
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
  storedRiskV2?: StoredRiskV2Result | null
  // HMM families of the sessions before the market-risk date, oldest first (null = no verified HMM state).
  regimeHistory?: Array<{ date: string; family: string | null }> | null
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

export function targetExposureCap(level: CanonicalMarketRiskLevel, policy: RiskConfig['portfolio']): number {
  if (level === 'black') return policy.blackTargetExposure
  if (level === 'red') return policy.redTargetExposure
  if (level === 'orange') return policy.orangeTargetExposure
  if (level === 'yellow') return policy.yellowTargetExposure
  return policy.greenTargetExposure
}

export function marketShockLevel(changePct: number | null, policy: RiskConfig['portfolio']): CanonicalMarketRiskLevel | null {
  if (changePct == null) return null
  const change = changePct / 100
  if (change <= policy.marketShockBlackPct) return 'black'
  if (change <= policy.marketShockRedPct) return 'red'
  if (change <= policy.marketShockOrangePct) return 'orange'
  return null
}

export function marketBreadthLevel(advanceRatio: number | null, policy: RiskConfig['portfolio']): CanonicalMarketRiskLevel | null {
  if (advanceRatio == null) return null
  if (advanceRatio <= policy.breadthBlackAdvanceRatio) return 'black'
  if (advanceRatio <= policy.breadthRedAdvanceRatio) return 'red'
  if (advanceRatio <= policy.breadthOrangeAdvanceRatio) return 'orange'
  return null
}

function regimeRiskLevel(family: string | null, constructiveVolatile: boolean): CanonicalMarketRiskLevel | null {
  if (family === 'bear') return 'red'
  if (family === 'volatile') return constructiveVolatile ? 'green' : 'orange'
  if (family === 'sideways') return 'yellow'
  if (family === 'bull') return 'green'
  return null
}

/**
 * A family takes effect once it has been observed on `sessions` consecutive sessions; until then the previous
 * confirmed family stays in force; a session without a verified family neither confirms nor resets. When no
 * family reaches `sessions` inside the window, the window cannot say which family is in force, so the more
 * severe of the oldest known family and today's raw family is used (never the milder one). Without any
 * verified family today's raw family is used, which is the unconfirmed (sessions=1) behaviour.
 */
const REGIME_SEVERITY: Record<string, number> = { bull: 1, sideways: 2, volatile: 3, bear: 4 }
export function confirmRegimeFamily(families: Array<string | null>, sessions: number): string | null {
  if (!families.length) return null
  const today = families[families.length - 1]
  // A missing session (null) neither confirms nor breaks a run, so an HMM gap cannot delay a bear switch.
  let confirmed: string | null = null, previous: string | null = null, run = 0
  for (const family of families) {
    if (family == null) continue
    run = family === previous ? run + 1 : 1
    previous = family
    if (run >= sessions) confirmed = family
  }
  if (confirmed != null) return confirmed
  const seed = families.find(family => family != null) ?? null
  if (seed == null || today == null) return seed ?? today
  return (REGIME_SEVERITY[today] ?? 0) >= (REGIME_SEVERITY[seed] ?? 0) ? today : seed
}

/**
 * The level owner: max over factor packet, stored v2, one-day shock, one-day breadth and the confirmed HMM
 * family. A stored black that no fast indicator (shock or breadth >= red) confirms on the same session is
 * capped at red, so a slow 20-day indicator cannot keep black through a V-shaped rebound.
 */
export function combineMarketRiskLevel(input: {
  factorPacketLevel: CanonicalMarketRiskLevel | null
  storedRiskLevel: CanonicalMarketRiskLevel | null
  shockLevel: CanonicalMarketRiskLevel | null
  breadthLevel: CanonicalMarketRiskLevel | null
  regimeFamily: string | null
  constructiveVolatile: boolean
  storedBlackRequiresFastConfirmation: boolean
}): { level: CanonicalMarketRiskLevel; storedEffectiveLevel: CanonicalMarketRiskLevel | null; regimeLevel: CanonicalMarketRiskLevel | null; storedBlackCapped: boolean } {
  const fastConfirmed = [input.shockLevel, input.breadthLevel].some(level => level != null && LEVEL_RANK[level] >= LEVEL_RANK.red)
  const storedBlackCapped = input.storedBlackRequiresFastConfirmation && input.storedRiskLevel === 'black' && !fastConfirmed
  const storedEffectiveLevel = storedBlackCapped ? 'red' : input.storedRiskLevel
  const regimeLevel = regimeRiskLevel(input.regimeFamily, input.constructiveVolatile)
  return {
    level: maxLevel([input.factorPacketLevel, storedEffectiveLevel, input.shockLevel, input.breadthLevel, regimeLevel]),
    storedEffectiveLevel,
    regimeLevel,
    storedBlackCapped,
  }
}

export const MARKET_RISK_POLICY_VERSION = 'market-direction-stress-v4'
export const REGIME_CONFIRMATION_LOOKBACK_SESSIONS = 10
export const HMM_INPUT_CONTRACT = '8b6542b50ea5c57c768e76bd517712e42579141cc1533169f2046cffce1a5e5f'

function constructiveVolatile(input: CanonicalMarketRiskInputs, shock: CanonicalMarketRiskLevel | null,
  breadth: CanonicalMarketRiskLevel | null): boolean {
  if (input.regimeState?.family !== 'volatile' || shock || breadth || !(input.quality?.status==='complete'||input.quality?.status==='bounded'&&input.quality.known_score===input.quality.upper_score)) return false
  const alignment=finiteNumber(input.breadth?.bull_alignment_pct)
  const advances=finiteNumber(input.breadth?.advance_ratio)
  if(alignment==null||alignment<55||alignment>100||advances==null||advances<.58||advances>1)return false
  const ordinary = (value: unknown) => ['green','yellow'].includes(normalizeCanonicalMarketRiskLevel(value) ?? '')
  if (!ordinary(input.factorPacket?.level) || !ordinary(input.storedRiskV2?.level)) return false
  const evidence = (input.regimeState.regime_evidence as any)?.evidence
  const trend = evidence?.price_trend, global = evidence?.global_risk
  const bias = finiteNumber(trend?.metrics?.twii_bias_20d), return5d = finiteNumber(trend?.metrics?.twii_return_5d)
  const vol10d=finiteNumber(evidence?.atr_vturn?.metrics?.realized_vol_10d)
  if(vol10d==null || vol10d<=0 || 3*vol10d>=Math.abs(input.policy.marketShockOrangePct))return false
  // This stress proxy is not a claimed portfolio VaR. Relief needs trend/global evidence and non-acute realized volatility.
  return trend?.status === 'available' && trend?.stance === 'bullish' && bias != null && bias > 0
    && return5d != null && return5d > 0 && global?.status === 'available' && global?.stance === 'bullish'
}

/**
 * Blockers that come only from trading:risk_config being unavailable. They stop anything that adds risk (new
 * buys, size-ups); de-risking existing positions still runs on the built-in defaults (what main used), at the
 * most conservative of the canonical level and main's level components.
 */
export const RISK_CONFIG_DEGRADED_BLOCKERS: readonly string[] = ['risk_config_unavailable', 'factor_packet_built_without_risk_config']

export function buildCanonicalMarketRiskContext(rawInput: CanonicalMarketRiskInputs): CanonicalMarketRiskContext {
  const configUnavailable = rawInput.policy.configUnavailable === true
  const input: CanonicalMarketRiskInputs = configUnavailable ? { ...rawInput, policy: riskScoringPolicy(rawInput.policy) } : rawInput
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
  if(!marketRiskDate||!hmmProvenanceShapeValid(input.regimeState,marketRiskDate,HMM_INPUT_CONTRACT)
    ||provenance?.risk_quality_checksum!==quality?.checksum)blockers.push('hmm_model_input_contract_unverified')

  if(input.decisionAsOfMs!==undefined){
    const computed=Date.parse(input.regimeState?.computed_at??''),asof=Date.parse(provenance?.inference_as_of??''),trained=Date.parse(model?.trained_at??'')
    if(!Number.isFinite(computed)||!Number.isFinite(asof)||!Number.isFinite(trained)||trained>asof||asof>computed||computed>input.decisionAsOfMs||input.decisionAsOfMs-trained>HMM_MAX_AGE_MS)blockers.push('hmm_inference_clock_unverified')
  }

  const dailyChangePct = currentClose != null && previousClose != null && previousClose > 0
    ? ((currentClose / previousClose) - 1) * 100
    : null
  const factorPacketLevel = normalizeCanonicalMarketRiskLevel(input.factorPacket?.level)
  const storedRiskLevelV1 = normalizeCanonicalMarketRiskLevel(latest?.risk_level)
  const storedRiskV2 = input.storedRiskV2 ?? null
  const storedRiskLevel = normalizeCanonicalMarketRiskLevel(storedRiskV2?.level)
  const shockLevel = marketShockLevel(dailyChangePct, input.policy)
  const breadthLevel = marketBreadthLevel(advanceRatio, input.policy)
  if (factorPacketLevel == null) blockers.push('factor_packet_level_invalid')
  if (storedRiskLevelV1 == null) blockers.push('market_risk_level_invalid')
  if (configUnavailable) blockers.push('risk_config_unavailable')
  else if (!marketRiskLevelPolicy(input.policy)) blockers.push('risk_level_policy_invalid')
  // A packet materialized while KV was unavailable was scored on built-in defaults: never trusted for new risk.
  if ((input.factorPacket?.lineage as any)?.risk_config === 'unavailable_builtin_defaults') blockers.push('factor_packet_built_without_risk_config')
  if (!storedRiskV2) blockers.push('stored_risk_v2_missing')
  else if (storedRiskV2.date !== marketRiskDate || storedRiskV2.status === 'blocked' || storedRiskLevel == null || !Number.isFinite(storedRiskV2.calibrated_score)) blockers.push('stored_risk_v2_invalid')
  const confirmSessions = input.policy.regimeConfirmSessions
  if (!Number.isSafeInteger(confirmSessions) || confirmSessions < 1 || confirmSessions > REGIME_CONFIRMATION_LOOKBACK_SESSIONS) blockers.push('regime_confirmation_policy_invalid')
  const caps = ['black','red','orange','yellow','green'].map(level => targetExposureCap(level as CanonicalMarketRiskLevel,input.policy))
  if (caps.some((value,index) => !Number.isFinite(value) || value < 0 || value > 1 || index > 0 && value < caps[index-1])) blockers.push('risk_exposure_policy_invalid')
  const floorCaps = (['black','red','orange','yellow','green'] as const).map(level => (input.policy.slotFloorCapByLevel as any)?.[level])
  if (floorCaps.some((value,index) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1 || index > 0 && value < floorCaps[index-1]))
    blockers.push('slot_floor_policy_invalid')
  if (typeof input.policy.blackHaltsNewBuys !== 'boolean') blockers.push('black_halt_policy_invalid')
  const regimeFamilyRaw = input.regimeState?.family ?? null
  const regimeFamily = confirmRegimeFamily([...(input.regimeHistory ?? []).map(row => row.family), regimeFamilyRaw], confirmSessions)
  // Relief needs today's raw state to be the constructive volatile state, and volatile to be the confirmed family.
  const relief = regimeFamily === 'volatile' && constructiveVolatile({...input,marketRiskRows:rows},shockLevel,breadthLevel)
  const combined = combineMarketRiskLevel({
    factorPacketLevel, storedRiskLevel, shockLevel, breadthLevel, regimeFamily, constructiveVolatile: relief,
    storedBlackRequiresFastConfirmation: input.policy.storedBlackRequiresFastConfirmation === true,
  })
  const { level, regimeLevel } = combined
  const packetScore = finiteNumber(input.factorPacket?.score)
  // Stored v2 enters the score on the v1 scale, so score consumers keep their calibration.
  const storedScore = finiteNumber(storedRiskV2?.calibrated_score)
  const score = packetScore == null ? storedScore : storedScore == null ? packetScore : Math.max(packetScore, storedScore)
  const reasons = [
    relief ? 'volatile_direction_confirmed_no_stress' : null,
    factorPacketLevel ? `factor_packet=${factorPacketLevel}:${packetScore ?? 'na'}` : null,
    storedRiskLevel ? `stored_risk_v2=${storedRiskLevel}:${storedRiskV2?.score ?? 'na'}` : null,
    combined.storedBlackCapped ? 'stored_black_unconfirmed_by_fast_indicator_capped_red' : null,
    shockLevel ? `market_shock=${shockLevel}:return_1d=${dailyChangePct?.toFixed(2)}%` : null,
    breadthLevel ? `market_breadth=${breadthLevel}:advance_ratio=${advanceRatio?.toFixed(4)}` : null,
    regimeLevel ? `regime=${regimeLevel}:${regimeFamily ?? 'unknown'}` : null,
    regimeFamily !== regimeFamilyRaw ? `regime_unconfirmed_raw=${regimeFamilyRaw ?? 'unknown'}` : null,
    input.regimeHistory === null ? 'regime_confirmation_history_unavailable' : null,
  ].filter((reason): reason is string => Boolean(reason))
  const status = blockers.length === 0 ? 'ready' : 'blocked'
  // Only config-unavailable blockers: new risk stays halted, de-risking runs at the most conservative of the
  // canonical level and main's components (packet, v1, uncapped v2, HMM family without volatile relief).
  const degraded = status === 'blocked' && blockers.every(blocker => RISK_CONFIG_DEGRADED_BLOCKERS.includes(blocker))
  const deRiskLevel = degraded ? maxLevel([level, factorPacketLevel, storedRiskLevel, storedRiskLevelV1,
    regimeRiskLevel(regimeFamilyRaw, false), regimeRiskLevel(regimeFamily, false)]) : null
  if (deRiskLevel) reasons.push(`risk_config_degraded_derisk_level=${deRiskLevel}`)

  return {
    status,
    date: marketRiskDate,
    level: status === 'ready' ? level : 'black',
    score: status === 'ready' ? score : null,
    targetExposureCap: status === 'ready' ? targetExposureCap(level, input.policy)
      : deRiskLevel ? targetExposureCap(deRiskLevel, input.policy) : null,
    deRiskExistingPositions: status === 'ready' ? LEVEL_RANK[level] >= LEVEL_RANK.orange
      : deRiskLevel != null && LEVEL_RANK[deRiskLevel] >= LEVEL_RANK.orange,
    haltNewBuys: status === 'blocked' || level === 'black' && input.policy.blackHaltsNewBuys !== false,
    dailyChangePct,
    advanceRatio,
    bullAlignmentRatio,
    regimeFamily,
    regimeFamilyRaw,
    factorPacketLevel,
    storedRiskLevel,
    storedRiskLevelV1,
    storedRiskScoreV2: storedRiskV2?.score ?? null,
    breadthLevel,
    shockLevel,
    reasons,
    blockers: [...new Set(blockers)],
    lineage: {
      owner: 'canonical_market_risk_runtime_v4',
      qualityChecksum:quality?.checksum??null,

      hmmModelSha256:model?.sha256??null,
      hmmModelGeneration:model?.generation??null,
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
    let storedRiskV2: StoredRiskV2Result | null = null
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
          &&Array.isArray(decoded.missing)&&(decoded.status!=='complete'||decoded.missing.length===0)){
          quality=rawQuality
          // v2 is recomputed from the checksum-verified receipt, never read from a separately written row.
          storedRiskV2=storedRiskV2FromQuality(decoded,riskScoringPolicy(riskConfig.portfolio))
        }
      }catch{ /* corrupt records remain unavailable */ }
    }
    // The latest market session survives weekends; the short-lived KV pointer may not.
    // Read the exact dated, checksum-verified history without writing or selecting another date.
    const rawDate = marketRiskRows?.[0]?.date
    const riskDate = typeof rawDate === 'string' ? rawDate : null
    const [regimeState, regimeHistory] = riskDate
      ? await Promise.all([
        readMarketRegimeStateHistory(databases.market, riskDate).then(state => state ?? readMarketRegimeStateForDate(kv, riskDate)),
        // Without history the confirmation falls back to today's raw family and says so in reasons.
        readHmmRegimeFamiliesBefore(databases.market, riskDate, REGIME_CONFIRMATION_LOOKBACK_SESSIONS, HMM_INPUT_CONTRACT).catch(() => null),
      ])
      : [null, null]
    return buildCanonicalMarketRiskContext({
      decisionAsOfMs:paperExecutionNow(),
      expectedSession,
      expectedPreviousSession,
      quality,
      storedRiskV2,
      regimeHistory,
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
