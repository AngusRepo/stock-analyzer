import {
  buildP7ModelUpgradeReviewPacket,
  listModelUpgradeCandidates,
  validateP7ModelUpgradeTrack,
} from './modelUpgradeResearchTrack'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const result = validateP7ModelUpgradeTrack()
  assert(result.ok, `P7 model upgrade track should be valid: ${result.errors.join(',')}`)
}

{
  const allIds = listModelUpgradeCandidates().map((candidate) => String(candidate.id))
  assert(!allIds.includes('TimesFM25'), 'TimesFM25 migration benchmark should not remain in active model-upgrade track')
}

{
  const benchmark = listModelUpgradeCandidates('benchmark_only')
  const ids = benchmark.map((candidate) => String(candidate.id))
  assert(!ids.includes('TabM'), 'TabM should no longer be benchmark-only')
  assert(!ids.includes('iTransformer'), 'iTransformer should no longer be benchmark-only')
  assert(!ids.includes('TimesFM'), 'TimesFM should no longer be benchmark-only')
  assert(!ids.includes('Moirai'), 'Moirai should be removed because HF weights are non-commercial')
  assert(benchmark.every((candidate) => !candidate.can_predict), 'benchmark candidates must not run production prediction')
  assert(benchmark.every((candidate) => !candidate.can_vote), 'benchmark candidates must not vote')
  assert(benchmark.every((candidate) => candidate.vote_weight === 0), 'benchmark candidates must have zero vote weight')
}

{
  const shadow = listModelUpgradeCandidates('shadow_challenger')
  assert(shadow.some((candidate) => candidate.id === 'ResidualMLP'), 'ResidualMLP should stay in shadow challenger track')
  assert(!shadow.some((candidate) => candidate.id === 'GNN'), 'GNN should not stay in shadow challenger track')
  assert(shadow.every((candidate) => candidate.can_predict), 'shadow challengers may produce shadow predictions')
  assert(shadow.every((candidate) => !candidate.can_vote), 'shadow challengers must not vote')
}

{
  const productionSlots = listModelUpgradeCandidates('production_slot_member')
  const ids = productionSlots.map((candidate) => candidate.id).sort().join(',')
  assert(ids === 'DLinear,GNN,PatchTST,TabM,TimesFM,iTransformer', `production slot targets mismatch: ${ids}`)
  assert(productionSlots.every((candidate) => candidate.can_predict), 'production slot targets must be prediction-capable')
  assert(productionSlots.every((candidate) => candidate.can_vote), 'production slot targets must be vote-capable')
  assert(productionSlots.every((candidate) => candidate.vote_weight > 0), 'production slot targets must have nominal vote weight')
  assert(productionSlots.every((candidate) => candidate.evidence_required.includes('production_artifact')), 'production slots must require production_artifact evidence')
}

{
  const ga = listModelUpgradeCandidates('meta_optimizer').find((candidate) => candidate.id === 'GAOptimizer')
  assert(ga, 'GAOptimizer should be registered as meta optimizer')
  assert(!ga!.can_predict && !ga!.can_vote, 'GAOptimizer must not be treated as an alpha model')
  assert(ga!.evidence_required.includes('monte_carlo_plateau'), 'GAOptimizer should require Monte Carlo plateau evidence')
}

{
  const packet = buildP7ModelUpgradeReviewPacket()
  assert(packet.includes('production_slot_member votes only through artifact-backed serving'), 'review packet should clarify production slot serving gate')
  assert(packet.includes('benchmark-only is not challenger'), 'review packet should clarify benchmark vs challenger')
}
