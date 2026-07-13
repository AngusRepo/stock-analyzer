import { getTwTickSize, normalizeTwLimitPrice, type TwOrderLotType } from './twMarketRules'

export interface ExecutionBookObservation {
  source: 'shioaji_hub' | 'finlab_l5'
  lotType: TwOrderLotType
  bid: number | null
  ask: number | null
  bidVolume?: number | null
  askVolume?: number | null
  sourceTime?: string | null
  receivedAt?: string | null
  ageMs?: number | null
}

export interface AuthoritativeExecutionSnapshot {
  schemaVersion: 'authoritative_execution_snapshot_v1'
  status: 'ready' | 'blocked'
  reason: string
  lotType: TwOrderLotType
  selectedSource: ExecutionBookObservation['source'] | null
  bid: number | null
  ask: number | null
  bidVolume: number | null
  askVolume: number | null
  ageMs: number | null
  disagreementTicks: number | null
  hardMismatch: boolean
  observations: ExecutionBookObservation[]
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
    .map((observation) => ({ ...observation, ageMs: normalizedAge(observation, nowMs) }))
  const matchingLot = observations.filter((observation) => observation.lotType === input.lotType)
  const fresh = matchingLot.filter((observation) => {
    const bid = positive(observation.bid)
    const ask = positive(observation.ask)
    return bid != null && ask != null && observation.ageMs != null && observation.ageMs <= maxAgeMs
  })

  const base = {
    schemaVersion: 'authoritative_execution_snapshot_v1' as const,
    lotType: input.lotType,
    observations,
  }
  if (fresh.length === 0) {
    return {
      ...base,
      status: 'blocked',
      reason: matchingLot.length === 0 ? 'execution_book_unavailable' : 'execution_book_stale_or_incomplete',
      selectedSource: null,
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

  if (hardMismatch || disagreementTicks > maxDisagreementTicks) {
    return {
      ...base,
      status: 'blocked',
      reason: hardMismatch ? 'buy_fill_below_fresh_best_ask' : 'execution_source_disagreement',
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
    .map((observation) => ({ ...observation, ageMs: normalizedAge(observation, nowMs) }))
  const matchingLot = observations.filter((observation) => observation.lotType === input.lotType)
  const fresh = matchingLot.filter((observation) => {
    const bid = positive(observation.bid)
    const ask = positive(observation.ask)
    return bid != null && ask != null && observation.ageMs != null && observation.ageMs <= maxAgeMs
  })
  const base = {
    schemaVersion: 'authoritative_execution_snapshot_v1' as const,
    lotType: input.lotType,
    observations,
  }
  if (fresh.length === 0) {
    return {
      ...base,
      status: 'blocked',
      reason: matchingLot.length === 0 ? 'execution_book_unavailable' : 'execution_book_stale_or_incomplete',
      selectedSource: null,
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
      hardMismatch,
    }
  }
  if (selectedBid < limitPrice) {
    return {
      ...result,
      status: 'blocked',
      reason: `authoritative_bid_below_limit:${selectedBid.toFixed(2)}_lt_${limitPrice.toFixed(2)}`,
      hardMismatch: false,
    }
  }
  return {
    ...result,
    status: 'ready',
    reason: 'authoritative_execution_book_ready',
    hardMismatch: false,
  }
}
