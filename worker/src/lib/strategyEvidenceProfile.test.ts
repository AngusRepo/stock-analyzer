import assert from 'node:assert/strict'

import {
  CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS,
  buildStrategyEvidenceProfile,
  listStrategyEvidenceProfiles,
} from './strategyEvidenceProfile'
import { DEFAULT_STRATEGY_SPECS } from './strategySpec'

const eligibleSpecs = DEFAULT_STRATEGY_SPECS.filter((spec) =>
  spec.status === 'active' || spec.status === 'candidate' || spec.status === 'shadow')
const profiles = listStrategyEvidenceProfiles()

assert.equal(profiles.length, eligibleSpecs.length, 'every active/candidate/shadow strategy needs an evidence profile')
assert.deepEqual(
  profiles.map((profile) => profile.strategy_id).sort(),
  eligibleSpecs.map((spec) => spec.id).sort(),
  'profile registry must cover the strategy registry exactly',
)

for (const spec of eligibleSpecs) {
  const profile = buildStrategyEvidenceProfile(spec)
  assert.deepEqual(profile.supported_regimes, spec.supportedRegimes, `${spec.id} must retain its own regime scope`)
  assert.deepEqual(
    profile.available_outcome_horizon_days,
    [CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS],
    `${spec.id} must not claim unmaterialized multi-horizon outcomes`,
  )
  assert.equal(profile.production_authority, 'shadow_only', `${spec.id} profile cannot mutate production gates`)
  assert(profile.required_metrics.length >= 5, `${spec.id} needs a strategy-specific metric bundle`)
  assert(profile.evaluation_horizon_days.includes(profile.primary_horizon_days))
  assert.equal(
    profile.outcome_contract_status,
    profile.primary_horizon_days === CURRENT_CANONICAL_OUTCOME_HORIZON_DAYS
      ? 'fixed_5d_available'
      : 'multi_horizon_pending',
  )
}

const breakout = profiles.find((profile) => profile.strategy_id === 'breakout_vol_expansion_seed_v1')!
const reversion = profiles.find((profile) => profile.strategy_id === 'finlab_ai_skill_reversion_value_v1')!
const defensive = profiles.find((profile) => profile.strategy_id === 'defensive_accumulation_seed_v1')!

assert.equal(breakout.primary_horizon_days, 5)
assert(breakout.required_metrics.includes('false_breakout_rate'))
assert(breakout.required_metrics.includes('tail_loss_cvar95'))

assert.equal(reversion.primary_horizon_days, 3)
assert.equal(reversion.outcome_contract_status, 'multi_horizon_pending')
assert(reversion.required_metrics.includes('time_to_reversion'))
assert(reversion.required_metrics.includes('maximum_adverse_excursion'))

assert.equal(defensive.primary_horizon_days, 10)
assert.equal(defensive.outcome_contract_status, 'multi_horizon_pending')
assert(defensive.required_metrics.includes('downside_capture'))
assert(defensive.required_metrics.includes('crowding_decay'))

assert.notDeepEqual(
  breakout.required_metrics,
  reversion.required_metrics,
  'different strategy mechanisms must not share one generic metric gate',
)
