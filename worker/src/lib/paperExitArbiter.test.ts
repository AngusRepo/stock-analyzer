import { arbitratePaperExit, type PaperExitCandidate } from './paperExitArbiter'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const baselineHold: PaperExitCandidate = {
  source: 'current_policy',
  action: 'hold',
  priority: 'HOLD',
  reason: 'no trigger',
}

const baselineHardStop: PaperExitCandidate = {
  source: 'current_policy',
  action: 'full_sell',
  priority: 'HARD_STOP',
  reason: 'Hard stop -10.2%',
}

const reviewFull: PaperExitCandidate = {
  source: 'holding_review',
  action: 'full_sell',
  priority: 'HOLDING_REVIEW_FULL',
  reason: 'main force exit score=0.91',
}

const reviewTighten: PaperExitCandidate = {
  source: 'holding_review',
  action: 'tighten_trail',
  priority: 'HOLDING_REVIEW_TIGHTEN',
  reason: 'giveback risk',
  newTrailingStop: 128,
}

{
  const chosen = arbitratePaperExit([baselineHardStop, reviewFull])
  assert(chosen.source === 'current_policy', 'hard stop must outrank holding review full exit')
  assert(chosen.priority === 'HARD_STOP', 'hard stop priority should be preserved')
}

{
  const chosen = arbitratePaperExit([baselineHold, reviewTighten])
  assert(chosen.source === 'holding_review', 'holding review tighten should beat baseline hold')
  assert(chosen.action === 'tighten_trail', 'tighten candidate should stay a tighten action')
}

{
  const chosen = arbitratePaperExit([reviewTighten, baselineHold], {
    currentTrailingStop: 130,
  })
  assert(chosen.action === 'hold', 'arbiter must not allow holding review to loosen an existing trail')
  assert(chosen.reason.includes('would_loosen_trailing_stop'), 'loosened trail rejection should be visible')
}

