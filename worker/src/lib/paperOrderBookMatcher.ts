import type { AuthoritativeExecutionSnapshot, ExecutionBookObservation } from './authoritativeExecutionSnapshot'
import { normalizeTwFilledSharesForRequestedOrder, normalizeTwLimitPrice } from './twMarketRules'

export interface PaperDepthFillLevel {
  price: number
  visibleShares: number
  filledShares: number
}

export interface PaperDepthMatch {
  schemaVersion: 'paper_depth_match_v1'
  snapshotId: string
  side: 'buy' | 'sell'
  status: 'filled' | 'partial' | 'resting' | 'blocked'
  reason: string
  requestedShares: number
  filledShares: number
  restingShares: number
  averageFillPrice: number | null
  selectedSource: string | null
  volumeUnit: 'lots' | 'shares' | null
  levels: PaperDepthFillLevel[]
}

function selectedObservation(snapshot: AuthoritativeExecutionSnapshot): ExecutionBookObservation | null {
  return snapshot.observations.find((observation) => observation.source === snapshot.selectedSource && observation.lotType === snapshot.lotType) ?? null
}

function visibleShares(volume: number, observation: ExecutionBookObservation, snapshot: AuthoritativeExecutionSnapshot): number {
  const normalized = Math.max(0, Math.floor(Number(volume)))
  const unit = observation.volumeUnit ?? (snapshot.lotType === 'board_lot' ? 'lots' : 'shares')
  return unit === 'lots' ? normalized * 1000 : normalized
}

export function matchPaperOrderAgainstAuthoritativeDepth(input: {
  snapshot: AuthoritativeExecutionSnapshot
  requestedShares: number
  limitPrice: number
}): PaperDepthMatch {
  const { snapshot } = input
  const requestedShares = Math.max(0, Math.floor(Number(input.requestedShares)))
  const limitPrice = normalizeTwLimitPrice(input.limitPrice, snapshot.side)
  const blocked = (reason: string): PaperDepthMatch => ({
    schemaVersion: 'paper_depth_match_v1',
    snapshotId: snapshot.snapshotId,
    side: snapshot.side,
    status: 'blocked',
    reason,
    requestedShares,
    filledShares: 0,
    restingShares: requestedShares,
    averageFillPrice: null,
    selectedSource: snapshot.selectedSource,
    volumeUnit: null,
    levels: [],
  })
  if (snapshot.status !== 'ready' || snapshot.hardMismatch) return blocked(`authoritative_snapshot_not_ready:${snapshot.reason}`)
  if (requestedShares <= 0) return blocked('requested_shares_invalid')
  const observation = selectedObservation(snapshot)
  if (!observation) return blocked('selected_depth_observation_missing')

  const prices = snapshot.side === 'buy' ? observation.askPrices ?? [] : observation.bidPrices ?? []
  const volumes = snapshot.side === 'buy' ? observation.askVolumes ?? [] : observation.bidVolumes ?? []
  const marketable = (price: number) => snapshot.side === 'buy' ? price <= limitPrice : price >= limitPrice
  const levels: PaperDepthFillLevel[] = []
  let rawFilled = 0
  let fillValue = 0
  for (let index = 0; index < Math.min(prices.length, volumes.length, 5); index += 1) {
    const price = Number(prices[index])
    if (!Number.isFinite(price) || price <= 0 || !marketable(price)) break
    const available = visibleShares(volumes[index], observation, snapshot)
    if (available <= 0) continue
    const take = Math.min(requestedShares - rawFilled, available)
    if (take <= 0) break
    levels.push({ price, visibleShares: available, filledShares: take })
    rawFilled += take
    fillValue += price * take
    if (rawFilled >= requestedShares) break
  }

  const filledShares = normalizeTwFilledSharesForRequestedOrder(requestedShares, rawFilled)
  if (filledShares <= 0) {
    return {
      ...blocked(prices.length === 0 || volumes.length === 0 ? 'authoritative_depth_missing' : 'no_marketable_visible_depth'),
      status: 'resting',
      reason: prices.length === 0 || volumes.length === 0 ? 'authoritative_depth_missing' : 'no_marketable_visible_depth',
      volumeUnit: observation.volumeUnit ?? (snapshot.lotType === 'board_lot' ? 'lots' : 'shares'),
    }
  }
  const usableLevels = levels.map((level) => {
    let remaining = filledShares - levels.slice(0, levels.indexOf(level)).reduce((sum, item) => sum + item.filledShares, 0)
    return { ...level, filledShares: Math.min(level.filledShares, Math.max(0, remaining)) }
  }).filter((level) => level.filledShares > 0)
  const normalizedValue = usableLevels.reduce((sum, level) => sum + level.price * level.filledShares, 0)
  const restingShares = requestedShares - filledShares
  return {
    schemaVersion: 'paper_depth_match_v1',
    snapshotId: snapshot.snapshotId,
    side: snapshot.side,
    status: restingShares > 0 ? 'partial' : 'filled',
    reason: restingShares > 0 ? 'visible_depth_partial_fill_remaining_resting' : 'visible_depth_fully_filled',
    requestedShares,
    filledShares,
    restingShares,
    averageFillPrice: normalizedValue > 0 ? normalizedValue / filledShares : fillValue / rawFilled,
    selectedSource: snapshot.selectedSource,
    volumeUnit: observation.volumeUnit ?? (snapshot.lotType === 'board_lot' ? 'lots' : 'shares'),
    levels: usableLevels,
  }
}
