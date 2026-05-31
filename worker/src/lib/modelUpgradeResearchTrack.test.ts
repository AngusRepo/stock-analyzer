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
  const formal = listModelUpgradeCandidates('layer3_formal_family_slot')
  const ids = formal.map((candidate) => String(candidate.id))
  assert(ids.join(',') === 'TabM,GNN,iTransformer,TimesFM', 'Layer 3 formal slots should be the only experiment-seeded model-upgrade lane')
  assert(formal.every((candidate) => candidate.parent_slot?.startsWith('Layer3.CoreFamily.')), 'formal slots must declare their Layer 3 family branch')
  assert(formal.every((candidate) => candidate.requires_review_packet), 'formal slots require review packets before artifact promotion')
  assert(formal.every((candidate) => !candidate.can_promote_directly), 'formal slots must not bypass promotion governance')
  const active = formal.filter((candidate) => candidate.id === 'GNN' || candidate.id === 'TimesFM')
  const blocked = formal.filter((candidate) => candidate.id === 'TabM' || candidate.id === 'iTransformer')
  assert(active.every((candidate) => candidate.can_predict && candidate.can_vote), 'GNN and TimesFM should be active Layer 3 production adapters')
  assert(blocked.every((candidate) => !candidate.can_vote), 'TabM and iTransformer must not vote until an artifact is approved and registered')
}

{
  const retired = listModelUpgradeCandidates('retired')
  const ids = retired.map((candidate) => String(candidate.id))
  assert(!ids.includes('FT-Transformer'), 'FT-Transformer should be removed instead of kept as comparator')
  assert(ids.includes('ResidualMLP'), 'ResidualMLP should be retired after TabM was selected for the tabular-neural branch')
  assert(ids.includes('Chronos'), 'Chronos should be retired from alpha vote after the sequence-family refactor')
  assert(retired.every((candidate) => !candidate.requires_review_packet), 'retired models must not seed new review lanes')
  assert(retired.every((candidate) => !candidate.can_predict && !candidate.can_vote), 'retired models must not predict or vote')
}

{
  const ga = listModelUpgradeCandidates('meta_optimizer').find((candidate) => candidate.id === 'GAOptimizer')
  assert(ga, 'GAOptimizer should be registered as meta optimizer')
  assert(!ga!.can_predict && !ga!.can_vote, 'GAOptimizer must not be treated as an alpha model')
  assert(ga!.evidence_required.includes('monte_carlo_plateau'), 'GAOptimizer should require Monte Carlo plateau evidence')
}

{
  const overlays = listModelUpgradeCandidates('state_space_overlay')
  assert(overlays.map((candidate) => candidate.id).join(',') === 'KalmanFilter,MarkovSwitching', 'only Kalman/Markov belong to state-space overlays')
  assert(overlays.every((candidate) => candidate.vote_weight === 0), 'state-space overlays must not count as alpha votes')
}

{
  const packet = buildP7ModelUpgradeReviewPacket()
  assert(packet.includes('GNN and TimesFM are active formal production adapters'), 'review packet should clarify active formal adapter governance')
  assert(packet.includes('retired models do not seed new experiments'), 'review packet should clarify retired model behavior')
}
