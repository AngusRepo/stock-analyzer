import { getTwTickSize, normalizeTwLimitPrice, type TwOrderLotType } from './twMarketRules'

export interface ExecutionBookObservation {
  source: 'shioaji_hub' | 'finlab_l5'
  lotType: TwOrderLotType
  bid: number | null
  ask: number | null
  bidVolume?: number | null
  askVolume?: number | null
  bidPrices?: number[]
  askPrices?: number[]
  bidVolumes?: number[]
  askVolumes?: number[]
  volumeUnit?: 'lots' | 'shares'
  sourceTime?: string | null
  receivedAt?: string | null
  ageMs?: number | null
  sessionEpoch?: number | null
}

export interface AuthoritativeExecutionSnapshot {
  schemaVersion: 'authoritative_execution_snapshot_v2'
  snapshotId: string
  createdAt: string
  side: 'buy' | 'sell'
  status: 'ready' | 'blocked'
  reason: string
  lotType: TwOrderLotType
  normalizedLimitPrice: number
  tickSize: number
  maxAgeMs: number
  selectedSource: ExecutionBookObservation['source'] | null
  selectedSourceTime: string | null
  selectedReceivedAt: string | null
  sessionEpoch: number | null
  sourceAgreement: 'none' | 'single_source' | 'agreed' | 'disagreed'
  bid: number | null
  ask: number | null
  bidVolume: number | null
  askVolume: number | null
  ageMs: number | null
  disagreementTicks: number | null
  hardMismatch: boolean
  observations: ExecutionBookObservation[]
}

function stableSnapshotId(parts: Array<string | number | null | undefined>): string {
  const text = parts.map((part) => String(part ?? '')).join('|')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `aes-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function normalizeObservation(observation: ExecutionBookObservation, nowMs: number): ExecutionBookObservation {
  const normalizePrices = (values: number[] | undefined): number[] => (values ?? [])
    .map((value) => positive(value))
    .filter((value): value is number => value != null)
    .slice(0, 5)
  const normalizeVolumes = (values: number[] | undefined): number[] => (values ?? [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .slice(0, 5)
  const bidPrices = normalizePrices(observation.bidPrices)
  const askPrices = normalizePrices(observation.askPrices)
  const bidVolumes = normalizeVolumes(observation.bidVolumes)
  const askVolumes = normalizeVolumes(observation.askVolumes)
  const bid = positive(observation.bid) ?? bidPrices[0] ?? null
  const ask = positive(observation.ask) ?? askPrices[0] ?? null
  const bidVolume = positive(observation.bidVolume) ?? bidVolumes[0] ?? null
  const askVolume = positive(observation.askVolume) ?? askVolumes[0] ?? null
  return {
    ...observation,
    bid,
    ask,
    bidVolume,
    askVolume,
    bidPrices: bidPrices.length > 0 ? bidPrices : bid == null ? [] : [bid],
    askPrices: askPrices.length > 0 ? askPrices : ask == null ? [] : [ask],
    bidVolumes: bidVolumes.length > 0 ? bidVolumes : bidVolume == null ? [] : [bidVolume],
    askVolumes: askVolumes.length > 0 ? askVolumes : askVolume == null ? [] : [askVolume],
    volumeUnit: observation.volumeUnit ?? (observation.lotType === 'board_lot' ? 'lots' : 'shares'),
    ageMs: normalizedAge(observation, nowMs),
  }
}

function snapshotBase(input: {
  side: 'buy' | 'sell'
  lotType: TwOrderLotType
  limitPrice: number
  maxAgeMs: number
  nowMs: number
  observations: ExecutionBookObservation[]
  fresh: ExecutionBookObservation[]
}) {
  const selected = [...input.fresh].sort((left, right) => Number(left.ageMs) - Number(right.ageMs))[0] ?? null
  const createdAt = new Date(input.nowMs).toISOString()
  return {
    schemaVersion: 'authoritative_execution_snapshot_v2' as const,
    snapshotId: stableSnapshotId([
      input.side,
      input.lotType,
      input.limitPrice,
      createdAt,
      selected?.source,
      selected?.sourceTime,
      selected?.sessionEpoch,
    ]),
    createdAt,
    side: input.side,
    lotType: input.lotType,
    normalizedLimitPrice: input.limitPrice,
    tickSize: getTwTickSize(input.limitPrice),
    maxAgeMs: input.maxAgeMs,
    selectedSourceTime: selected?.sourceTime ?? null,
    selectedReceivedAt: selected?.receivedAt ?? null,
    sessionEpoch: selected?.sessionEpoch ?? null,
    observations: input.observations,
  }
}

function positive(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function normalizedAge(observation: ExecutionBookObservation, nowMs: number): number | null {
  const explicit = Number(observation.ageMs)
  if (Number.isFinite(explicit) && explicit >= 0) return explicit
  const text = observation.sourceTime ?? observation.receivedAt
  if (!text) return null
  const timestamp = new Date(text).getTime()
  return Number.isFinite(timestamp) ? Math.max(0, nowMs - timestamp) : null
}

export function resolveAuthoritativeBuyExecutionSnapshot(input: {
  limitPrice: number
  lotType: TwOrderLotType
  observations: Array<ExecutionBookObservation | null | undefined>
  maxAgeMs?: number
  maxDisagreementTicks?: number
  nowMs?: number
}): AuthoritativeExecutionSnapshot {
  const nowMs = input.nowMs ?? Date.now()
  const maxAgeMs = Math.max(100, Number(input.maxAgeMs ?? 1500))
  const maxDisagreementTicks = Math.max(0, Number(input.maxDisagreementTicks ?? 1))
  const limitPrice = normalizeTwLimitPrice(input.limitPrice, 'buy')
  const observations = input.observations
    .filter((observation): observation is ExecutionBookObservation => observation != null)
    .map((observation) => normalizeObservation(observation, nowMs))
  const matchingLot = observations.filter((observation) => observation.lotType === input.lotType)
  const fresh = matchingLot.filter((observation) => {
    const bid = positive(observation.bid)
    const ask = positive(observation.ask)
    return bid != null && ask != null && observation.ageMs != null && observation.ageMs <= maxAgeMs
  })

  const base = snapshotBase({ side: 'buy', lotType: input.lotType, limitPrice, maxAgeMs, nowMs, observations, fresh })
  if (fresh.length === 0) {
    return {
      ...base,
      status: 'blocked',
      reason: matchingLot.length === 0 ? 'execution_book_unavailable' : 'execution_book_stale_or_incomplete',
      sourceAgreement: 'none',
      selectedSource: null,
      selectedSourceTime: null,
      selectedReceivedAt: null,
      sessionEpoch: null,
      bid: null,
      ask: null,
      bidVolume: null,
      askVolume: null,
      ageMs: null,
      disagreementTicks: null,
      hardMismatch: false,
    }
  }

  const selected = [...fresh].sort((left, right) => Number(left.ageMs) - Number(right.ageMs))[0]
  const selectedAsk = positive(selected.ask)!
  const selectedBid = positive(selected.bid)!
  const askValues = fresh.map((observation) => positive(observation.ask)!).filter((value) => value != null)
  const maxAsk = Math.max(...askValues)
  const minAsk = Math.min(...askValues)
  const disagreementTicks = askValues.length > 1
    ? Math.round(Math.abs(maxAsk - minAsk) / getTwTickSize(Math.max(maxAsk, minAsk)))
    : 0
  const oneSourceMarketable = fresh.some((observation) => positive(observation.ask)! <= limitPrice)
  const oneSourceNotMarketable = fresh.some((observation) => positive(observation.ask)! > limitPrice)
  const hardMismatch = oneSourceMarketable && oneSourceNotMarketable
  const sourceAgreement = fresh.length === 1 ? 'single_source' : disagreementTicks === 0 ? 'agreed' : 'disagreed'

  if (hardMismatch || disagreementTicks > maxDisagreementTicks) {
    return {
      ...base,
      status: 'blocked',
      reason: hardMismatch ? 'buy_fill_below_fresh_best_ask' : 'execution_source_disagreement',
      sourceAgreement: 'disagreed',
      selectedSource: selected.source,
      bid: selectedBid,
      ask: selectedAsk,
      bidVolume: positive(selected.bidVolume),
      askVolume: positive(selected.askVolume),
      ageMs: selected.ageMs ?? null,
      disagreementTicks,
      hardMismatch,
    }
  }

  if (selectedAsk > limitPrice) {
    return {
      ...base,
      status: 'blocked',
      reason: `authoritative_ask_above_limit:${selectedAsk.toFixed(2)}_gt_${limitPrice.toFixed(2)}`,
      sourceAgreement,
      selectedSource: selected.source,
      bid: selectedBid,
      ask: selectedAsk,
      bidVolume: positive(selected.bidVolume),
      askVolume: positive(selected.askVolume),
      ageMs: selected.ageMs ?? null,
      disagreementTicks,
      hardMismatch: false,
    }
  }

  return {
    ...base,
    status: 'ready',
    reason: 'authoritative_execution_book_ready',
    sourceAgreement,
    selectedSource: selected.source,
    bid: selectedBid,
    ask: selectedAsk,
    bidVolume: positive(selected.bidVolume),
    askVolume: positive(selected.askVolume),
    ageMs: selected.ageMs ?? null,
    disagreementTicks,
    hardMismatch: false,
  }
}

export function resolveAuthoritativeSellExecutionSnapshot(input: {
  limitPrice: number
  lotType: TwOrderLotType
  observations: Array<ExecutionBookObservation | null | undefined>
  maxAgeMs?: number
  maxDisagreementTicks?: number
  nowMs?: number
}): AuthoritativeExecutionSnapshot {
  const nowMs = input.nowMs ?? Date.now()
  const maxAgeMs = Math.max(100, Number(input.maxAgeMs ?? 1500))
  const maxDisagreementTicks = Math.max(0, Number(input.maxDisagreementTicks ?? 1))
  const limitPrice = normalizeTwLimitPrice(input.limitPrice, 'sell')
  const observations = input.observations
    .filter((observation): observation is ExecutionBookObservation => observation != null)
    .map((observation) => normalizeObservation(observation, nowMs))
  const matchingLot = observations.filter((observation) => observation.lotType === input.lotType)
  const fresh = matchingLot.filter((observation) => {
    const bid = positive(observation.bid)
    const ask = positive(observation.ask)
    return bid != null && ask != null && observation.ageMs != null && observation.ageMs <= maxAgeMs
  })
  const base = snapshotBase({ side: 'sell', lotType: input.lotType, limitPrice, maxAgeMs, nowMs, observations, fresh })
  if (fresh.length === 0) {
    return {
      ...base,
      status: 'blocked',
      reason: matchingLot.length === 0 ? 'execution_book_unavailable' : 'execution_book_stale_or_incomplete',
      sourceAgreement: 'none',
      selectedSource: null,
      selectedSourceTime: null,
      selectedReceivedAt: null,
      sessionEpoch: null,
      bid: null,
      ask: null,
      bidVolume: null,
      askVolume: null,
      ageMs: null,
      disagreementTicks: null,
      hardMismatch: false,
    }
  }
  const selected = [...fresh].sort((left, right) => Number(left.ageMs) - Number(right.ageMs))[0]
  const selectedBid = positive(selected.bid)!
  const selectedAsk = positive(selected.ask)!
  const bids = fresh.map((observation) => positive(observation.bid)!).filter((value) => value != null)
  const maxBid = Math.max(...bids)
  const minBid = Math.min(...bids)
  const disagreementTicks = bids.length > 1
    ? Math.round(Math.abs(maxBid - minBid) / getTwTickSize(Math.max(maxBid, minBid)))
    : 0
  const oneSourceMarketable = fresh.some((observation) => positive(observation.bid)! >= limitPrice)
  const oneSourceNotMarketable = fresh.some((observation) => positive(observation.bid)! < limitPrice)
  const hardMismatch = oneSourceMarketable && oneSourceNotMarketable
  const sourceAgreement = fresh.length === 1 ? 'single_source' : disagreementTicks === 0 ? 'agreed' : 'disagreed'
  const result = {
    ...base,
    selectedSource: selected.source,
    bid: selectedBid,
    ask: selectedAsk,
    bidVolume: positive(selected.bidVolume),
    askVolume: positive(selected.askVolume),
    ageMs: selected.ageMs ?? null,
    disagreementTicks,
  }
  if (hardMismatch || disagreementTicks > maxDisagreementTicks) {
    return {
      ...result,
      status: 'blocked',
      reason: hardMismatch ? 'sell_fill_above_fresh_best_bid' : 'execution_source_disagreement',
      sourceAgreement: 'disagreed',
      hardMismatch,
    }
  }
  if (selectedBid < limitPrice) {
    return {
      ...result,
      status: 'blocked',
      reason: `authoritative_bid_below_limit:${selectedBid.toFixed(2)}_lt_${limitPrice.toFixed(2)}`,
      sourceAgreement,
      hardMismatch: false,
    }
  }
  return {
    ...result,
    status: 'ready',
    reason: 'authoritative_execution_book_ready',
    sourceAgreement,
    hardMismatch: false,
  }
}
