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
  const benchmark = listModelUpgradeCandidates('benchmark_only')
  const ids = benchmark.map((candidate) => String(candidate.id))
  assert(ids.includes('TabM'), 'TabM should be tracked as benchmark-only')
  assert(ids.includes('iTransformer'), 'iTransformer should be tracked as benchmark-only')
  assert(ids.includes('TimesFM'), 'TimesFM should be tracked as benchmark-only')
  assert(!ids.includes('Moirai'), 'Moirai should be removed because HF weights are non-commercial')
  assert(benchmark.every((candidate) => !candidate.can_predict), 'benchmark candidates must not run production prediction')
  assert(benchmark.every((candidate) => !candidate.can_vote), 'benchmark candidates must not vote')
  assert(benchmark.every((candidate) => candidate.vote_weight === 0), 'benchmark candidates must have zero vote weight')
}

{
  const shadow = listModelUpgradeCandidates('shadow_challenger')
  assert(shadow.some((candidate) => candidate.id === 'ResidualMLP'), 'ResidualMLP should stay in shadow challenger track')
  assert(shadow.some((candidate) => candidate.id === 'GNN'), 'GNN should stay in shadow challenger track')
  assert(shadow.every((candidate) => candidate.can_predict), 'shadow challengers may produce shadow predictions')
  assert(shadow.every((candidate) => !candidate.can_vote), 'shadow challengers must not vote')
}

{
  const chronosMembers = listModelUpgradeCandidates('production_slot_member')
  assert(chronosMembers.length === 2, 'Chronos-2 zero-shot and LoRA should be the only production slot members')
  assert(chronosMembers.every((candidate) => candidate.parent_slot === 'Chronos'), 'Chronos members must stay inside one Chronos slot')
  assert(chronosMembers.every((candidate) => !candidate.can_promote_directly), 'Chronos members must not bypass lifecycle evidence')
}

{
  const ga = listModelUpgradeCandidates('meta_optimizer').find((candidate) => candidate.id === 'GAOptimizer')
  assert(ga, 'GAOptimizer should be registered as meta optimizer')
  assert(!ga!.can_predict && !ga!.can_vote, 'GAOptimizer must not be treated as an alpha model')
  assert(ga!.evidence_required.includes('monte_carlo_plateau'), 'GAOptimizer should require Monte Carlo plateau evidence')
}

{
  const packet = buildP7ModelUpgradeReviewPacket()
  assert(packet.includes('benchmark-only is not challenger'), 'review packet should clarify benchmark vs challenger')
  assert(packet.includes('Chronos members keep one Chronos slot'), 'review packet should clarify Chronos denominator')
}
