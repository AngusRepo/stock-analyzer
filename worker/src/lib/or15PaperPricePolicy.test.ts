import { assessOr15PaperPrice, resolveOr15PaperExitTargets } from './or15PaperPricePolicy'

function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message)
}

const valid = assessOr15PaperPrice({
  referenceEntry: 178.63, proposedBuy: 179.5, structuralStop: 170,
  modelTp1: 178.63, modelTp2: 189.29, maxChasePct: 0.018,
})
assert(valid.action === 'pass' && valid.maxBuyPrice === 181.5, '2221 A entry must fit a bounded selected-plan chase')
assert(valid.modelTp1State === 'crossed_before_entry', 'crossed ML TP1 must not be presented as a future target')
assert(assessOr15PaperPrice({ referenceEntry: 178.63, proposedBuy: 182, structuralStop: 170,
  modelTp1: 178.63, modelTp2: 189.29, maxChasePct: 0.018 }).reason === 'or15_above_selection_max_buy',
  'a hot quote cannot silently lift the selected-plan max buy')
assert(assessOr15PaperPrice({ referenceEntry: 178.63, proposedBuy: 179.5, structuralStop: 170,
  modelTp1: 178.63, modelTp2: 179, maxChasePct: 0.018 }).reason === 'or15_selection_tp2_exhausted',
  'exhausted selected-plan TP2 must block a new Paper entry')
assert(assessOr15PaperPrice({ referenceEntry: 178.63, proposedBuy: 179.5, structuralStop: 180,
  modelTp1: 178.63, modelTp2: 189.29, maxChasePct: 0.018 }).reason === 'or15_invalid_structural_stop',
  'A stop must remain below the proposed buy')

const rebased = resolveOr15PaperExitTargets({ fillPrice: 179.5, selectedTp1: 178.63,
  selectedTp2: 189.29, atrTp1: 185, atrTp2: 200, isNetProfitable: price => price > 180.5 })
assert(rebased?.tp1 === 189.29 && rebased.tp2 === 200 && rebased.tp1Source === 'selected_tp2_promoted',
  'crossed selection TP1 must retain selected TP2 as first valid milestone')
const unchanged = resolveOr15PaperExitTargets({ fillPrice: 100, selectedTp1: 110,
  selectedTp2: 120, atrTp1: 112, atrTp2: 125, isNetProfitable: price => price > 101 })
assert(unchanged?.tp1 === 110 && unchanged.tp2 === 120 && unchanged.tp2Source === 'selected_tp2',
  'valid selected TP1 and TP2 must remain active')
assert(resolveOr15PaperExitTargets({ fillPrice: 179.5, selectedTp1: 178.63,
  selectedTp2: 189.29, atrTp1: 185, atrTp2: 188, isNetProfitable: price => price > 180.5 }) == null,
  'an A entry without two ordered profitable exit milestones must fail closed')
