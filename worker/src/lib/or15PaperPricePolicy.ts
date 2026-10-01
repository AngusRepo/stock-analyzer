import { normalizeTwLimitPrice } from './twMarketRules'

export interface Or15PaperPriceDecision {
  action: 'pass' | 'defer'
  reason: string
  maxBuyPrice: number | null
  modelTp1State: 'valid' | 'crossed_before_entry' | 'missing'
}

function positive(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null
}

/** Bound a Paper A breakout to the selected plan; never derive its ceiling from the live quote. */
export function assessOr15PaperPrice(input: {
  referenceEntry: number | null | undefined
  proposedBuy: number
  structuralStop: number | null | undefined
  modelTp1: number | null | undefined
  modelTp2: number | null | undefined
  maxChasePct: number
}): Or15PaperPriceDecision {
  const reference = positive(input.referenceEntry)
  const proposed = positive(input.proposedBuy)
  const stop = positive(input.structuralStop)
  const tp1 = positive(input.modelTp1)
  const tp2 = positive(input.modelTp2)
  const chase = Number(input.maxChasePct)
  const modelTp1State = tp1 == null ? 'missing' : proposed != null && tp1 > proposed ? 'valid' : 'crossed_before_entry'
  if (reference == null || proposed == null || !Number.isFinite(chase) || chase < 0 || chase > 0.03) {
    return { action: 'defer', reason: 'or15_invalid_selection_price_plan', maxBuyPrice: null, modelTp1State }
  }
  const maxBuyPrice = normalizeTwLimitPrice(reference * (1 + chase), 'buy')
  if (proposed > maxBuyPrice) {
    return { action: 'defer', reason: 'or15_above_selection_max_buy', maxBuyPrice, modelTp1State }
  }
  if (stop == null || stop >= proposed) {
    return { action: 'defer', reason: 'or15_invalid_structural_stop', maxBuyPrice, modelTp1State }
  }
  if (tp1 == null) {
    return { action: 'defer', reason: 'or15_selection_tp1_missing', maxBuyPrice, modelTp1State }
  }
  if (tp2 == null || tp2 <= proposed) {
    return { action: 'defer', reason: 'or15_selection_tp2_exhausted', maxBuyPrice, modelTp1State }
  }
  return { action: 'pass', reason: 'or15_selection_price_plan_valid', maxBuyPrice, modelTp1State }
}

export interface Or15PaperExitTargets {
  tp1: number
  tp2: number
  tp1Source: 'selected_tp1' | 'selected_tp2_promoted'
  tp2Source: 'selected_tp2' | 'atr_extension'
}

/** A crossed selection TP1 remains an audit anchor; the next valid level becomes the first exit milestone. */
export function resolveOr15PaperExitTargets(input: {
  fillPrice: number
  selectedTp1: number | null | undefined
  selectedTp2: number | null | undefined
  atrTp1: number
  atrTp2: number
  isNetProfitable: (sellPrice: number) => boolean
}): Or15PaperExitTargets | null {
  const profitable = (price: number | null | undefined): price is number =>
    price != null && Number.isFinite(price) && price > input.fillPrice && input.isNetProfitable(price)
  const selectedTp1Valid = profitable(input.selectedTp1)
  const selectedTp2Valid = profitable(input.selectedTp2)
  if (!selectedTp1Valid && !selectedTp2Valid) return null
  const tp1 = selectedTp1Valid ? input.selectedTp1! : input.selectedTp2!
  const tp2Source = selectedTp2Valid && input.selectedTp2! > tp1 ? 'selected_tp2' : 'atr_extension'
  const tp2 = tp2Source === 'selected_tp2' ? input.selectedTp2! :
    [input.atrTp1, input.atrTp2].filter(price => profitable(price) && price > tp1).at(-1)
  if (tp2 == null || tp2 <= tp1) return null
  return {
    tp1,
    tp2,
    tp1Source: selectedTp1Valid ? 'selected_tp1' : 'selected_tp2_promoted',
    tp2Source,
  }
}
