import type { Bindings } from '../types'
import { databaseForDataDomain } from './dataDomainRegistry'

export const PAPER_KELLY_CALIBRATION_VERSION = 'paper-kelly-pav-v1' as const
export const PAPER_KELLY_MIN_OBSERVATIONS = 60
export const PAPER_KELLY_MIN_DATES = 12
export const PAPER_KELLY_MIN_TRAIN_OBSERVATIONS = 40
export const PAPER_KELLY_MIN_OOS_OBSERVATIONS = 15
export const PAPER_KELLY_PURGE_DATES = 2
export const PAPER_KELLY_OOS_DATES = 4

type PaperOrderRow = {
  id: number | string
  symbol: string
  side: string
  shares: number | string
  price: number | string
  commission: number | string | null
  tax: number | string | null
  source: string | null
  confidence: number | string | null
  note: string | null
  created_at: string
}

export type PaperKellyObservation = {
  observationId: string
  buyOrderId: number
  sellOrderId: number
  symbol: string
  signalDate: string
  outcomeDate: string
  confidence: number
  confidenceSemantic: string
  netReturn: number
  matchedShares: number
}

export type PaperKellyCalibrationBin = {
  lowerConfidence: number
  upperConfidence: number
  calibratedProbability: number
  sampleCount: number
}

export type PaperKellyCalibrationArtifact = {
  artifactId: string
  runId: string
  method: typeof PAPER_KELLY_CALIBRATION_VERSION
  knowledgeCutoffDate: string
  trainedThroughDate: string
  confidenceSemantic: string
  bins: PaperKellyCalibrationBin[]
  averageWinReturn: number
  averageLossReturn: number
  fractionalKelly: number
  maxKellyPct: number
  sourceChecksum: string
  payloadChecksum: string
}

export type PaperKellyCalibrationResult = {
  runId: string
  status: 'pending_maturity' | 'rejected' | 'approved' | 'promoted'
  confidenceSemantic: string | null
  sampleCount: number
  dateCount: number
  trainDates: string[]
  purgeDates: string[]
  oosDates: string[]
  sourceChecksum: string
  artifact: PaperKellyCalibrationArtifact | null
  gates: Record<string, boolean>
  metrics: {
    rawBrier: number | null
    calibratedBrier: number | null
    oosMeanLogGrowth: number | null
    oosMaxDrawdown: number | null
  }
}

function finite(value: unknown): number | null {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function round8(value: number): number {
  return Number(value.toFixed(8))
}

async function sha256(payload: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload))
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

function confidenceSemanticFromNote(note: unknown): string | null {
  if (typeof note !== 'string' || !note.trim()) return null
  try {
    const parsed = JSON.parse(note) as Record<string, unknown>
    const semantic = String(parsed.ml_confidence_semantic ?? '').trim()
    return semantic || null
  } catch {
    return null
  }
}

export function buildPaperKellyObservations(rows: readonly PaperOrderRow[]): PaperKellyObservation[] {
  type BuyLot = {
    id: number
    symbol: string
    remainingShares: number
    originalShares: number
    price: number
    commissionPerShare: number
    confidence: number
    confidenceSemantic: string
    createdAt: string
  }
  const queues = new Map<string, BuyLot[]>()
  const observations: PaperKellyObservation[] = []
  for (const row of [...rows].sort((left, right) => (
    String(left.created_at).localeCompare(String(right.created_at)) || Number(left.id) - Number(right.id)
  ))) {
    const shares = Math.max(0, Math.floor(finite(row.shares) ?? 0))
    const price = finite(row.price)
    if (!(shares > 0) || !(price != null && price > 0)) continue
    const side = String(row.side ?? '').toLowerCase()
    if (side === 'buy') {
      if (String(row.source ?? '') !== 'auto_ml') continue
      const confidence = finite(row.confidence)
      const confidenceSemantic = confidenceSemanticFromNote(row.note)
      if (confidence == null || confidence < 0 || confidence > 1 || !confidenceSemantic) continue
      const queue = queues.get(row.symbol) ?? []
      queue.push({
        id: Number(row.id),
        symbol: row.symbol,
        remainingShares: shares,
        originalShares: shares,
        price,
        commissionPerShare: Math.max(0, finite(row.commission) ?? 0) / shares,
        confidence,
        confidenceSemantic,
        createdAt: row.created_at,
      })
      queues.set(row.symbol, queue)
      continue
    }
    if (side !== 'sell') continue
    const queue = queues.get(row.symbol) ?? []
    let remaining = shares
    const sellCostPerShare = (Math.max(0, finite(row.commission) ?? 0) + Math.max(0, finite(row.tax) ?? 0)) / shares
    let leg = 0
    while (remaining > 0 && queue.length > 0) {
      const buy = queue[0]
      const matched = Math.min(remaining, buy.remainingShares)
      const entryCost = buy.price + buy.commissionPerShare
      const exitProceeds = price - sellCostPerShare
      const netReturn = entryCost > 0 ? exitProceeds / entryCost - 1 : Number.NaN
      if (Number.isFinite(netReturn)) {
        observations.push({
          observationId: `${buy.id}:${Number(row.id)}:${leg}`,
          buyOrderId: buy.id,
          sellOrderId: Number(row.id),
          symbol: row.symbol,
          signalDate: String(buy.createdAt).slice(0, 10),
          outcomeDate: String(row.created_at).slice(0, 10),
          confidence: buy.confidence,
          confidenceSemantic: buy.confidenceSemantic,
          netReturn: round8(netReturn),
          matchedShares: matched,
        })
      }
      buy.remainingShares -= matched
      remaining -= matched
      leg += 1
      if (buy.remainingShares <= 0) queue.shift()
    }
  }
  return observations.sort((left, right) => (
    left.outcomeDate.localeCompare(right.outcomeDate) || left.observationId.localeCompare(right.observationId)
  ))
}

export function fitPavCalibrationBins(observations: readonly PaperKellyObservation[]): PaperKellyCalibrationBin[] {
  type Block = { lower: number; upper: number; wins: number; count: number }
  const grouped = new Map<number, { wins: number; count: number }>()
  for (const row of observations) {
    const current = grouped.get(row.confidence) ?? { wins: 0, count: 0 }
    current.wins += row.netReturn > 0 ? 1 : 0
    current.count += 1
    grouped.set(row.confidence, current)
  }
  const blocks: Block[] = []
  for (const confidence of [...grouped.keys()].sort((left, right) => left - right)) {
    const group = grouped.get(confidence)!
    blocks.push({ lower: confidence, upper: confidence, wins: group.wins, count: group.count })
    while (blocks.length >= 2) {
      const right = blocks.at(-1)!
      const left = blocks.at(-2)!
      if (left.wins / left.count <= right.wins / right.count) break
      blocks.splice(-2, 2, {
        lower: left.lower,
        upper: right.upper,
        wins: left.wins + right.wins,
        count: left.count + right.count,
      })
    }
  }
  return blocks.map((block) => ({
    lowerConfidence: round8(block.lower),
    upperConfidence: round8(block.upper),
    calibratedProbability: round8(block.wins / block.count),
    sampleCount: block.count,
  }))
}

export function calibratedProbability(
  bins: readonly PaperKellyCalibrationBin[],
  confidence: number,
): number | null {
  if (!bins.length || !Number.isFinite(confidence)) return null
  return (bins.find((bin) => confidence <= bin.upperConfidence) ?? bins.at(-1)!).calibratedProbability
}

function kellyFraction(
  probability: number,
  averageWinReturn: number,
  averageLossReturn: number,
  fractionalKelly: number,
  maxKellyPct: number,
): number {
  if (!(averageWinReturn > 0) || !(averageLossReturn > 0)) return 0
  const payoffRatio = averageWinReturn / averageLossReturn
  const fullKelly = (probability * payoffRatio - (1 - probability)) / payoffRatio
  return round8(Math.max(0, Math.min(maxKellyPct, fullKelly * fractionalKelly)))
}

function artifactPayloadWithoutChecksum(artifact: Omit<PaperKellyCalibrationArtifact, 'payloadChecksum'>): Record<string, unknown> {
  return {
    artifactId: artifact.artifactId,
    runId: artifact.runId,
    method: artifact.method,
    knowledgeCutoffDate: artifact.knowledgeCutoffDate,
    trainedThroughDate: artifact.trainedThroughDate,
    confidenceSemantic: artifact.confidenceSemantic,
    bins: artifact.bins,
    averageWinReturn: artifact.averageWinReturn,
    averageLossReturn: artifact.averageLossReturn,
    fractionalKelly: artifact.fractionalKelly,
    maxKellyPct: artifact.maxKellyPct,
    sourceChecksum: artifact.sourceChecksum,
  }
}

export async function evaluatePaperKellyCalibration(input: {
  observations: readonly PaperKellyObservation[]
  knowledgeCutoffDate: string
  allowPromotion?: boolean
}): Promise<PaperKellyCalibrationResult> {
  const available = [...input.observations]
    .filter((row) => row.outcomeDate < input.knowledgeCutoffDate)
    .sort((left, right) => left.outcomeDate.localeCompare(right.outcomeDate) || left.observationId.localeCompare(right.observationId))
  const confidenceSemantic = available.at(-1)?.confidenceSemantic ?? null
  const observations = confidenceSemantic
    ? available.filter((row) => row.confidenceSemantic === confidenceSemantic)
    : []
  const sourceChecksum = await sha256(JSON.stringify(observations))
  const dates = [...new Set(observations.map((row) => row.outcomeDate))].sort()
  const oosStart = Math.max(0, dates.length - PAPER_KELLY_OOS_DATES)
  const trainEnd = Math.max(0, oosStart - PAPER_KELLY_PURGE_DATES)
  const trainDates = dates.slice(0, trainEnd)
  const purgeDates = dates.slice(trainEnd, oosStart)
  const oosDates = dates.slice(oosStart)
  const train = observations.filter((row) => trainDates.includes(row.outcomeDate))
  const oos = observations.filter((row) => oosDates.includes(row.outcomeDate))
  const bins = fitPavCalibrationBins(train)
  const wins = train.filter((row) => row.netReturn > 0).map((row) => row.netReturn)
  const losses = train.filter((row) => row.netReturn <= 0).map((row) => Math.abs(row.netReturn))
  const averageWinReturn = wins.length ? wins.reduce((sum, value) => sum + value, 0) / wins.length : 0
  const averageLossReturn = losses.length ? losses.reduce((sum, value) => sum + value, 0) / losses.length : 0
  const rawBrier = oos.length
    ? oos.reduce((sum, row) => sum + (row.confidence - (row.netReturn > 0 ? 1 : 0)) ** 2, 0) / oos.length
    : null
  const calibratedBrier = oos.length && bins.length
    ? oos.reduce((sum, row) => {
      const probability = calibratedProbability(bins, row.confidence) ?? row.confidence
      return sum + (probability - (row.netReturn > 0 ? 1 : 0)) ** 2
    }, 0) / oos.length
    : null
  let wealth = 1
  let peak = 1
  let maxDrawdown = 0
  const logGrowth: number[] = []
  for (const row of oos) {
    const probability = calibratedProbability(bins, row.confidence)
    if (probability == null) continue
    const fraction = kellyFraction(probability, averageWinReturn, averageLossReturn, 0.5, 0.15)
    const gross = 1 + fraction * row.netReturn
    if (!(gross > 0)) continue
    wealth *= gross
    peak = Math.max(peak, wealth)
    maxDrawdown = Math.max(maxDrawdown, 1 - wealth / peak)
    logGrowth.push(Math.log(gross))
  }
  const meanLogGrowth = logGrowth.length
    ? logGrowth.reduce((sum, value) => sum + value, 0) / logGrowth.length
    : null
  const maturityGates = {
    enough_total_observations: observations.length >= PAPER_KELLY_MIN_OBSERVATIONS,
    enough_outcome_dates: dates.length >= PAPER_KELLY_MIN_DATES,
    enough_train_observations: train.length >= PAPER_KELLY_MIN_TRAIN_OBSERVATIONS,
    purge_gap_complete: purgeDates.length === PAPER_KELLY_PURGE_DATES,
    enough_oos_observations: oos.length >= PAPER_KELLY_MIN_OOS_OBSERVATIONS,
    calibration_has_multiple_bins: bins.length >= 2,
    train_has_wins_and_losses: wins.length > 0 && losses.length > 0,
  }
  const performanceGates = {
    calibrated_brier_not_worse: calibratedBrier != null && rawBrier != null && calibratedBrier <= rawBrier + 1e-12,
    oos_log_growth_non_negative: meanLogGrowth != null && meanLogGrowth >= 0,
    oos_max_drawdown_within_cap: logGrowth.length > 0 && maxDrawdown <= 0.15,
  }
  const gates = { ...maturityGates, ...performanceGates }
  const maturityReady = Object.values(maturityGates).every(Boolean)
  const passed = maturityReady && Object.values(performanceGates).every(Boolean)
  const status = !maturityReady ? 'pending_maturity' : !passed ? 'rejected' : input.allowPromotion === true ? 'promoted' : 'approved'
  const provisionalRunId = `${PAPER_KELLY_CALIBRATION_VERSION}-${input.knowledgeCutoffDate}-${sourceChecksum.slice(0, 20)}-${status}`
  let artifact: PaperKellyCalibrationArtifact | null = null
  if (bins.length && wins.length && losses.length && trainDates.length) {
    const artifactId = `${provisionalRunId}:artifact`
    const withoutChecksum: Omit<PaperKellyCalibrationArtifact, 'payloadChecksum'> = {
      artifactId,
      runId: provisionalRunId,
      method: PAPER_KELLY_CALIBRATION_VERSION,
      knowledgeCutoffDate: input.knowledgeCutoffDate,
      trainedThroughDate: trainDates.at(-1)!,
      confidenceSemantic: confidenceSemantic!,
      bins,
      averageWinReturn: round8(averageWinReturn),
      averageLossReturn: round8(averageLossReturn),
      fractionalKelly: 0.5,
      maxKellyPct: 0.15,
      sourceChecksum,
    }
    artifact = { ...withoutChecksum, payloadChecksum: await sha256(JSON.stringify(artifactPayloadWithoutChecksum(withoutChecksum))) }
  }
  return {
    runId: provisionalRunId,
    status,
    confidenceSemantic,
    sampleCount: observations.length,
    dateCount: dates.length,
    trainDates,
    purgeDates,
    oosDates,
    sourceChecksum,
    artifact,
    gates,
    metrics: {
      rawBrier: rawBrier == null ? null : round8(rawBrier),
      calibratedBrier: calibratedBrier == null ? null : round8(calibratedBrier),
      oosMeanLogGrowth: meanLogGrowth == null ? null : round8(meanLogGrowth),
      oosMaxDrawdown: logGrowth.length ? round8(maxDrawdown) : null,
    },
  }
}

export async function refreshPaperKellyCalibration(
  env: Bindings,
  input: { knowledgeCutoffDate: string; allowPromotion?: boolean },
): Promise<PaperKellyCalibrationResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.knowledgeCutoffDate)) throw new Error('invalid_paper_kelly_cutoff')
  const db = databaseForDataDomain(env, 'paper')
  const orders = await db.prepare(`
    SELECT id, symbol, side, shares, price, commission, tax, source, confidence, note, created_at
      FROM paper_orders
     WHERE account_id=1 AND substr(created_at, 1, 10) < ?
     ORDER BY created_at, id
  `).bind(input.knowledgeCutoffDate).all<PaperOrderRow>()
  const result = await evaluatePaperKellyCalibration({
    observations: buildPaperKellyObservations(orders.results ?? []),
    knowledgeCutoffDate: input.knowledgeCutoffDate,
    allowPromotion: input.allowPromotion,
  })
  const artifactChecksum = result.artifact?.payloadChecksum ?? await sha256('null')
  const statements: D1PreparedStatement[] = [db.prepare(`
    INSERT OR IGNORE INTO paper_kelly_calibration_runs_v1 (
      run_id, artifact_version, knowledge_cutoff_date, status, confidence_semantic, sample_count, date_count,
      train_dates_json, purge_dates_json, oos_dates_json, source_checksum,
      artifact_checksum, gates_json, metrics_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    result.runId,
    PAPER_KELLY_CALIBRATION_VERSION,
    input.knowledgeCutoffDate,
    result.status,
    result.confidenceSemantic,
    result.sampleCount,
    result.dateCount,
    JSON.stringify(result.trainDates),
    JSON.stringify(result.purgeDates),
    JSON.stringify(result.oosDates),
    result.sourceChecksum,
    artifactChecksum,
    JSON.stringify({ ...result.gates, production_effect: result.status === 'promoted', real_order_effect: false }),
    JSON.stringify(result.metrics),
  )]
  if (result.artifact) {
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO paper_kelly_calibration_artifacts_v1 (
        artifact_id, run_id, method, knowledge_cutoff_date, trained_through_date,
        confidence_semantic, bins_json, average_win_return, average_loss_return, fractional_kelly,
        max_kelly_pct, source_checksum, payload_checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      result.artifact.artifactId,
      result.artifact.runId,
      result.artifact.method,
      result.artifact.knowledgeCutoffDate,
      result.artifact.trainedThroughDate,
      result.artifact.confidenceSemantic,
      JSON.stringify(result.artifact.bins),
      result.artifact.averageWinReturn,
      result.artifact.averageLossReturn,
      result.artifact.fractionalKelly,
      result.artifact.maxKellyPct,
      result.artifact.sourceChecksum,
      result.artifact.payloadChecksum,
    ))
  }
  if (result.status === 'promoted' && result.artifact) {
    statements.push(db.prepare(`
      INSERT INTO paper_kelly_calibration_head_v1 (
        singleton_id, run_id, artifact_id, artifact_checksum, knowledge_cutoff_date
      ) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(singleton_id) DO UPDATE SET
        run_id=excluded.run_id, artifact_id=excluded.artifact_id,
        artifact_checksum=excluded.artifact_checksum, knowledge_cutoff_date=excluded.knowledge_cutoff_date,
        promoted_at=CURRENT_TIMESTAMP
      WHERE paper_kelly_calibration_head_v1.knowledge_cutoff_date <= excluded.knowledge_cutoff_date
    `).bind(result.runId, result.artifact.artifactId, result.artifact.payloadChecksum, input.knowledgeCutoffDate))
  }
  await db.batch(statements)
  const readback = await db.prepare(`
    SELECT r.status, r.artifact_checksum, COUNT(a.artifact_id) artifact_count
      FROM paper_kelly_calibration_runs_v1 r
      LEFT JOIN paper_kelly_calibration_artifacts_v1 a ON a.run_id=r.run_id
     WHERE r.run_id=? GROUP BY r.run_id
  `).bind(result.runId).first<{ status: string; artifact_checksum: string; artifact_count: number | string }>()
  const expectedArtifactCount = result.artifact ? 1 : 0
  if (readback?.status !== result.status || readback.artifact_checksum !== artifactChecksum
    || Number(readback.artifact_count) !== expectedArtifactCount) {
    throw new Error('paper_kelly_calibration_readback_mismatch')
  }
  return result
}

export async function loadPromotedPaperKellyCalibrationBefore(
  db: D1Database,
  decisionDate: string,
): Promise<PaperKellyCalibrationArtifact | null> {
  const row = await db.prepare(`
    SELECT a.artifact_id, a.run_id, a.method, a.knowledge_cutoff_date, a.trained_through_date,
           a.confidence_semantic, a.bins_json, a.average_win_return, a.average_loss_return, a.fractional_kelly,
           a.max_kelly_pct, a.source_checksum, a.payload_checksum,
           h.artifact_checksum
      FROM paper_kelly_calibration_head_v1 h
      JOIN paper_kelly_calibration_runs_v1 r ON r.run_id=h.run_id
      JOIN paper_kelly_calibration_artifacts_v1 a ON a.artifact_id=h.artifact_id AND a.run_id=r.run_id
     WHERE h.singleton_id=1 AND r.status='promoted' AND r.knowledge_cutoff_date < ?
       AND r.artifact_checksum=h.artifact_checksum AND a.payload_checksum=h.artifact_checksum
  `).bind(decisionDate).first<{
    artifact_id: string
    run_id: string
    method: string
    knowledge_cutoff_date: string
    trained_through_date: string
    confidence_semantic: string
    bins_json: string
    average_win_return: number | string
    average_loss_return: number | string
    fractional_kelly: number | string
    max_kelly_pct: number | string
    source_checksum: string
    payload_checksum: string
    artifact_checksum: string
  }>()
  if (!row || row.method !== PAPER_KELLY_CALIBRATION_VERSION) return null
  let bins: PaperKellyCalibrationBin[]
  try {
    bins = JSON.parse(row.bins_json) as PaperKellyCalibrationBin[]
  } catch {
    return null
  }
  if (!Array.isArray(bins) || bins.length < 2) return null
  const artifact: PaperKellyCalibrationArtifact = {
    artifactId: row.artifact_id,
    runId: row.run_id,
    method: PAPER_KELLY_CALIBRATION_VERSION,
    knowledgeCutoffDate: row.knowledge_cutoff_date,
    trainedThroughDate: row.trained_through_date,
    confidenceSemantic: row.confidence_semantic,
    bins,
    averageWinReturn: Number(row.average_win_return),
    averageLossReturn: Number(row.average_loss_return),
    fractionalKelly: Number(row.fractional_kelly),
    maxKellyPct: Number(row.max_kelly_pct),
    sourceChecksum: row.source_checksum,
    payloadChecksum: row.payload_checksum,
  }
  const binsValid = artifact.bins.every((bin, index) => (
    Number.isFinite(bin.lowerConfidence) && Number.isFinite(bin.upperConfidence)
    && bin.lowerConfidence <= bin.upperConfidence
    && Number.isFinite(bin.calibratedProbability)
    && bin.calibratedProbability >= 0 && bin.calibratedProbability <= 1
    && Number.isInteger(bin.sampleCount) && bin.sampleCount > 0
    && (index === 0 || artifact.bins[index - 1].upperConfidence < bin.lowerConfidence)
    && (index === 0 || artifact.bins[index - 1].calibratedProbability <= bin.calibratedProbability)
  ))
  if (!binsValid || !artifact.confidenceSemantic) return null
  const expected = await sha256(JSON.stringify(artifactPayloadWithoutChecksum(artifact)))
  return expected === artifact.payloadChecksum ? artifact : null
}

export function resolvePaperKellyPct(
  artifact: PaperKellyCalibrationArtifact | null,
  confidence: number,
  runtimeMaxKellyPct = 0.15,
  confidenceSemantic?: string | null,
): { pct: number; info: string; artifactId: string } | null {
  if (!artifact || !confidenceSemantic || confidenceSemantic !== artifact.confidenceSemantic) return null
  const probability = calibratedProbability(artifact.bins, confidence)
  if (probability == null) return null
  const pct = kellyFraction(
    probability,
    artifact.averageWinReturn,
    artifact.averageLossReturn,
    artifact.fractionalKelly,
    Math.min(artifact.maxKellyPct, runtimeMaxKellyPct),
  )
  if (!(pct > 0)) return null
  const payoffRatio = artifact.averageWinReturn / artifact.averageLossReturn
  return {
    pct,
    artifactId: artifact.artifactId,
    info: `artifact=${artifact.artifactId} calibrated_p=${probability.toFixed(4)} empirical_b=${payoffRatio.toFixed(4)} fractional_kelly=${artifact.fractionalKelly.toFixed(2)} cap=${pct.toFixed(4)}`,
  }
}
