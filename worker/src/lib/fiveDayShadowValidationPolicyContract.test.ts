import assert from 'node:assert/strict'
import fs from 'node:fs'

const policy = JSON.parse(fs.readFileSync('../infra/stockvision-five-day-shadow-validation.v2.json', 'utf8'))
const serialized = JSON.stringify(policy)

assert.equal(policy.schema_version, 'stockvision-five-day-shadow-validation-v2')
assert.equal(policy.production_effect, false)
assert.equal(policy.counting_policy.rolling_operational_days, 5)
assert.equal(policy.counting_policy.comparison_evidence_clocks_are_independent, true)
assert.equal(policy.counting_policy.keep_monitoring_after_five_passes, true)
assert.deepEqual(
  policy.comparison_lanes.map((lane: any) => lane.mechanism).sort(),
  ['execution_parity', 'rfs_allocator', 'shadow_a'],
)
assert(policy.comparison_lanes.every((lane: any) => lane.auto_promote === false))
assert.equal(policy.comparison_lanes.some((lane: any) => lane.mechanism === 'state_space_overlay'), false)
assert(serialized.includes('State-space overlay active maturity clock or daily production compute after negative incremental OOS validation'))
assert(serialized.includes('core, market, learning, ops, execution, paper and research'))
assert(serialized.includes('no top-k truncation'))
assert(serialized.includes('retired hand-written regime multiplier has no runtime or telemetry consumer'))
assert(serialized.includes('Paper Kelly is inactive without a promoted checksum-bound calibration artifact'))
assert(serialized.includes('L1.5 V5 counts only current-semantic immutable evidence'))
assert(serialized.includes('Multi-horizon formal-owner head'))
assert(serialized.includes('fixed-symbol assertions for 4541, 2441 or 6712'))
assert(serialized.includes('missing evidence from an explicitly disabled comparison lane as a global failure'))

console.log('five-day shadow validation v2 policy contract passed')
