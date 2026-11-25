/**
 * Stored market risk v2: every factor group is counted once.
 *
 * Member severities reuse the frozen v1 point table (market_risk.risk_score keeps v1 semantics and is
 * never rewritten), except two unit fixes: foreign_net_5d triggers on any 5-day net sell (sign only, see
 * `foreignNet5dTrigger`) and margin_ratio uses KV percent cuts of margin balance / margin limit. A group contributes max(member severity) × group cap; the total is rescaled to 0–100
 * over the active caps. Levels use `riskLevelThresholds.storedV2`, calibrated so the v2 level distribution
 * matches the v1 stored distribution. `calibrated_score` maps the v2 score onto the v1 scale piecewise
 * linearly through the two threshold sets, so score consumers keep the v1 scale.
 */
import type { RiskConfig, StoredRiskV2Policy } from './riskConfig'
import { canonicalRiskJson, riskPacketChecksum } from './riskPacketCodec'

export type RiskLevel = 'green' | 'yellow' | 'orange' | 'red' | 'black'
export const RISK_LEVELS: readonly RiskLevel[] = ['green', 'yellow', 'orange', 'red', 'black']
export const STORED_RISK_V2_SCHEMA = 'market-risk-stress-v2'
export type StoredRiskV2Group = keyof StoredRiskV2Policy['groupCaps']
export type StoredRiskV2MissingPolicy = 'upper_bound' | 'omit'

export function validRiskLevelThresholds(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4
    && value.every((cut, index) => typeof cut === 'number' && Number.isFinite(cut) && cut >= 0 && cut <= 100
      && (index === 0 || cut > value[index - 1]))
}

/** Each cut is the inclusive upper bound of green, yellow, orange and red; above the last is black. */
export function scoreToRiskLevel(score: number, thresholds: readonly number[]): RiskLevel {
  for (let index = 0; index < 4; index += 1) if (score <= thresholds[index]) return RISK_LEVELS[index]
  return 'black'
}

export function validStoredRiskV2Policy(policy: unknown): policy is StoredRiskV2Policy {
  const p = policy as StoredRiskV2Policy | null
  const caps = p?.groupCaps
  const capValues = caps ? [caps.volatility, caps.trend, caps.flow, caps.leverage, caps.breadth] : []
  const named = ['volatility', 'trend', 'flow', 'leverage', 'breadth']
  // Unknown group keys would change the rescale denominator without a group behind them: reject.
  return !!p && !!caps && Object.keys(caps).every(key => named.includes(key)) && capValues.length === 5 && capValues.every(cap => typeof cap === 'number' && Number.isFinite(cap) && cap >= 0)
    && capValues.reduce((sum, cap) => sum + cap, 0) > 0
    && p.foreignNet5dTrigger === 'net_sell'
    && typeof p.marginRatioPct?.elevated === 'number' && typeof p.marginRatioPct?.extreme === 'number'
    && Number.isFinite(p.marginRatioPct.elevated) && p.marginRatioPct.extreme > p.marginRatioPct.elevated && p.marginRatioPct.elevated > 0
}

/** Null when any threshold set or the v2 policy is unusable; the runtime then fails closed. */
export function marketRiskLevelPolicy(portfolio: RiskConfig['portfolio']) {
  if (portfolio.configUnavailable === true) return null   // KV unreadable: never score with program defaults
  const thresholds = portfolio.riskLevelThresholds
  if (!validRiskLevelThresholds(thresholds?.storedV1) || !validRiskLevelThresholds(thresholds?.storedV2)
    || !validRiskLevelThresholds(thresholds?.factorPacket) || !validStoredRiskV2Policy(portfolio.storedRiskV2)
    || typeof portfolio.storedBlackRequiresFastConfirmation !== 'boolean') return null
  return { storedV1: thresholds.storedV1, storedV2: thresholds.storedV2, factorPacket: thresholds.factorPacket, storedRiskV2: portfolio.storedRiskV2 }
}

/** Monotone piecewise-linear map from the v2 scale to the v1 scale through matching threshold cuts. */
export function calibrateStoredRiskV2Score(score: number, v2: readonly number[], v1: readonly number[]): number {
  const from = [0, ...v2, 100], to = [0, ...v1, 100]
  for (let index = 1; index < from.length; index += 1) {
    if (score <= from[index]) {
      const span = from[index] - from[index - 1]
      const value = span <= 0 ? to[index] : to[index - 1] + (score - from[index - 1]) / span * (to[index] - to[index - 1])
      return Math.round(value * 10) / 10
    }
  }
  return 100
}

export interface StoredRiskV2Inputs {
  vix?: unknown
  twiiVol20?: unknown
  twiiBias?: unknown
  foreignConsecutiveSell?: unknown
  foreignNet5d?: unknown
  marginRatio?: unknown
  adlTrend?: unknown
  bullAlignmentPct?: unknown
}

export interface StoredRiskV2Member {
  value: number | string | null
  severity: number
  missing: boolean
}

export interface StoredRiskV2Result {
  schema_version: typeof STORED_RISK_V2_SCHEMA
  date: string
  status: 'complete' | 'bounded' | 'blocked'
  score: number
  calibrated_score: number
  level: RiskLevel
  groups: Record<StoredRiskV2Group, { cap: number; severity: number; points: number; members: Record<string, StoredRiskV2Member> }>
  missing: string[]
  missing_policy: StoredRiskV2MissingPolicy
  policy: { group_caps: StoredRiskV2Policy['groupCaps']; foreign_net_5d_trigger: StoredRiskV2Policy['foreignNet5dTrigger']; margin_ratio_pct: StoredRiskV2Policy['marginRatioPct']; thresholds: number[]; v1_thresholds: number[] }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

// Severities are the frozen v1 points divided by each member's v1 maximum.
const vixSeverity = (vix: number) => vix >= 40 ? 1 : vix >= 30 ? 25 / 35 : vix >= 20 ? 15 / 35 : vix >= 15 ? 5 / 35 : 0
const volSeverity = (vol: number) => vol >= 40 ? 1 : vol >= 25 ? 12 / 20 : vol >= 18 ? 6 / 20 : 0
const biasSeverity = (bias: number) => Math.abs(bias) >= 10 ? 1 : Math.abs(bias) >= 6 ? 8 / 15 : Math.abs(bias) >= 3 ? 3 / 15 : 0
const sellStreakSeverity = (days: number) => days <= -5 ? 1 : days <= -3 ? 12 / 20 : days <= -1 ? 5 / 20 : 0
const alignmentSeverity = (pct: number) => pct < 20 ? 1 : pct < 30 ? 0.5 : 0

/**
 * `upper_bound` (production) scores a missing member at full severity, like market-risk-quality-v1; a bounded
 * margin receipt scores its upper ratio. `omit` scores missing members 0 and is only for replaying rows written
 * before the quality receipt existed, when v1 itself added nothing for absent inputs.
 */
export function computeStoredRiskV2(input: {
  date: string
  inputs: StoredRiskV2Inputs
  marginSource?: unknown
  thresholds: readonly number[]
  v1Thresholds: readonly number[]
  policy: StoredRiskV2Policy
  missingPolicy?: StoredRiskV2MissingPolicy
  /** The v1 quality receipt status; a blocked receipt (critical input such as twii_close missing) stays blocked. */
  qualityStatus?: unknown
}): StoredRiskV2Result {
  const missingPolicy = input.missingPolicy ?? 'upper_bound'
  const data = input.inputs ?? {}
  const missing: string[] = []
  const absent = missingPolicy === 'upper_bound' ? 1 : 0
  const member = (key: string, value: unknown, valid: boolean, severity: () => number): StoredRiskV2Member => {
    if (!valid) missing.push(key)
    return { value: finite(value) || typeof value === 'string' ? value as number | string : null, severity: valid ? severity() : absent, missing: !valid }
  }
  const vix = data.vix, vol = data.twiiVol20, bias = data.twiiBias, net = data.foreignNet5d
  const margin = data.marginRatio, adl = data.adlTrend, alignment = data.bullAlignmentPct
  const flowValid = finite(net)
  const marginValid = finite(margin) && margin >= 0
  const receipt = input.marginSource as { status?: unknown; ratio_lower?: unknown; ratio_upper?: unknown } | null | undefined
  const marginBound = receipt?.status === 'bounded' && finite(receipt.ratio_lower) && finite(receipt.ratio_upper)
    && receipt.ratio_lower >= 0 && receipt.ratio_upper >= receipt.ratio_lower ? receipt.ratio_upper : null
  const marginCuts = input.policy.marginRatioPct
  const marginSeverity = (ratio: number) => ratio >= marginCuts.extreme ? 1 : ratio >= marginCuts.elevated ? 0.5 : 0
  const boundedMargin = (upper: number): StoredRiskV2Member => {
    missing.push('margin_ratio')
    return { value: upper, severity: marginSeverity(upper), missing: true }
  }
  const members: Record<StoredRiskV2Group, Record<string, StoredRiskV2Member>> = {
    volatility: {
      vix: member('vix', vix, finite(vix) && vix > 0, () => vixSeverity(vix as number)),
      twii_vol20: member('twii_vol20', vol, finite(vol) && vol >= 0, () => volSeverity(vol as number)),
    },
    trend: { twii_bias: member('twii_bias', bias, finite(bias), () => biasSeverity(bias as number)) },
    flow: {
      // The v1 receipt marks the whole foreign-flow source missing when the 5-day net is absent.
      foreign_consecutive_sell: member('foreign_consecutive_sell', data.foreignConsecutiveSell, flowValid,
        () => sellStreakSeverity(finite(data.foreignConsecutiveSell) ? data.foreignConsecutiveSell : 0)),
      foreign_net_5d: member('foreign_net_5d', net, flowValid, () => (net as number) < 0 ? 1 : 0),
    },
    leverage: {
      margin_ratio: marginValid || marginBound == null || missingPolicy === 'omit'
        ? member('margin_ratio', margin, marginValid, () => marginSeverity(margin as number))
        : boundedMargin(marginBound),
    },
    breadth: {
      adl_trend: member('adl_trend', adl, ['up', 'flat', 'down'].includes(String(adl ?? '')), () => adl === 'down' ? 1 : 0),
      bull_alignment_pct: member('bull_alignment_pct', alignment, finite(alignment) && alignment >= 0 && alignment <= 100,
        () => alignmentSeverity(alignment as number)),
    },
  }
  const caps = input.policy.groupCaps
  const activeCap = (Object.keys(members) as StoredRiskV2Group[]).reduce((sum, group) => sum + caps[group], 0)
  let total = 0
  const groups = {} as StoredRiskV2Result['groups']
  for (const group of Object.keys(members) as StoredRiskV2Group[]) {
    const severity = Math.max(...Object.values(members[group]).map(item => item.severity))
    const points = severity * caps[group]
    total += points
    groups[group] = { cap: caps[group], severity: Math.round(severity * 10000) / 10000, points: Math.round(points * 100) / 100, members: members[group] }
  }
  const score = Math.round(total * 100 / activeCap * 10) / 10
  return {
    schema_version: STORED_RISK_V2_SCHEMA,
    date: input.date,
    status: input.qualityStatus === 'blocked' ? 'blocked' : missing.length ? 'bounded' : 'complete',
    score,
    calibrated_score: calibrateStoredRiskV2Score(score, input.thresholds, input.v1Thresholds),
    level: scoreToRiskLevel(score, input.thresholds),
    groups,
    missing,
    missing_policy: missingPolicy,
    policy: {
      group_caps: { ...caps },
      foreign_net_5d_trigger: input.policy.foreignNet5dTrigger,
      margin_ratio_pct: { ...input.policy.marginRatioPct },
      thresholds: [...input.thresholds],
      v1_thresholds: [...input.v1Thresholds],
    },
  }
}

/** v2 from a decoded market-risk-quality-v1 receipt (its `inputs` and margin source). */
export function storedRiskV2FromQuality(decoded: any, portfolio: RiskConfig['portfolio']): StoredRiskV2Result | null {
  const levels = marketRiskLevelPolicy(portfolio)
  if (!levels || !decoded || typeof decoded.date !== 'string' || !decoded.inputs || typeof decoded.inputs !== 'object') return null
  return computeStoredRiskV2({
    date: decoded.date,
    inputs: decoded.inputs,
    marginSource: decoded.sources?.margin,
    thresholds: levels.storedV2,
    v1Thresholds: levels.storedV1,
    policy: levels.storedRiskV2,
    qualityStatus: decoded.status,
  })
}

export interface StoredRiskV2DriftResult {
  date: string | null
  /** False when the stored row is not what its own quality receipt and echoed KV policy recompute to. */
  ok: boolean
  mismatches: string[]
  /** The KV policy echoed in the row differs from the current KV (expected after a KV change; not a drift). */
  policyChanged: boolean
  /** Level the runtime would derive today from the same receipt under the current KV. */
  currentLevel: RiskLevel | null
}

/**
 * Drift check for a market_risk_stress_v2 row: its columns, checksum and quality checksum must agree with the
 * json, and the json must equal a recompute of the quality receipt under the KV policy echoed in the row (the
 * KV of the write). The runtime never reads this row (it recomputes from the receipt with the current KV), so a
 * mismatch means the audit row no longer describes what the code computes and must alert.
 */
export async function storedRiskV2Drift(
  row: Record<string, any> | null | undefined,
  quality: Record<string, any> | null | undefined,
  currentPortfolio: RiskConfig['portfolio'],
): Promise<StoredRiskV2DriftResult> {
  const mismatches: string[] = []
  const date = typeof row?.date === 'string' ? row.date : null
  const result = (policyChanged = false, currentLevel: RiskLevel | null = null): StoredRiskV2DriftResult =>
    ({ date, ok: mismatches.length === 0, mismatches, policyChanged, currentLevel })
  if (!row || !quality) { mismatches.push(row ? 'quality_missing' : 'row_missing'); return result() }
  let stored: any, receipt: any
  try { stored = JSON.parse(row.json) } catch { mismatches.push('json_invalid'); return result() }
  try { receipt = JSON.parse(quality.json) } catch { mismatches.push('quality_json_invalid'); return result() }
  if (await riskPacketChecksum(stored) !== row.checksum) mismatches.push('checksum')
  if (await riskPacketChecksum(receipt) !== quality.checksum) mismatches.push('quality_checksum_invalid')
  if (row.quality_checksum !== quality.checksum) mismatches.push('quality_checksum')
  for (const key of ['date', 'schema_version', 'status', 'score', 'calibrated_score', 'level'])
    if (stored?.[key] !== row[key]) mismatches.push('column_' + key)
  if (receipt?.date !== row.date) mismatches.push('quality_date')
  const echoed = stored?.policy
  const policy = { groupCaps: echoed?.group_caps, foreignNet5dTrigger: echoed?.foreign_net_5d_trigger, marginRatioPct: echoed?.margin_ratio_pct }
  if (!validStoredRiskV2Policy(policy) || !validRiskLevelThresholds(echoed?.thresholds) || !validRiskLevelThresholds(echoed?.v1_thresholds)
    || !['upper_bound', 'omit'].includes(stored?.missing_policy) || !receipt?.inputs || typeof receipt.inputs !== 'object') {
    mismatches.push('echoed_policy_invalid')
    return result()
  }
  const recomputed = computeStoredRiskV2({
    date: row.date, inputs: receipt.inputs, marginSource: receipt.sources?.margin, thresholds: echoed.thresholds,
    v1Thresholds: echoed.v1_thresholds, policy, missingPolicy: stored.missing_policy, qualityStatus: receipt.status,
  })
  if (canonicalRiskJson(recomputed) !== canonicalRiskJson(stored)) {
    for (const key of ['score', 'calibrated_score', 'level', 'status', 'missing', 'groups'] as const)
      if (canonicalRiskJson(recomputed[key]) !== canonicalRiskJson(stored[key])) mismatches.push('recompute_' + key)
    if (!mismatches.some(item => item.startsWith('recompute_'))) mismatches.push('recompute_json')
  }
  const current = storedRiskV2FromQuality(receipt, currentPortfolio)
  if (!current) mismatches.push('current_policy_invalid')
  return result(!current || canonicalRiskJson(current.policy) !== canonicalRiskJson(stored.policy), current?.level ?? null)
}
