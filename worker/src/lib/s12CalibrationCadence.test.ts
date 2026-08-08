import assert from 'node:assert/strict'
import { resolveS12CalibrationCadence } from './s12CalibrationCadence'

assert.equal(resolveS12CalibrationCadence('weekly', '2026-08-02'), 'weekly')
assert.equal(resolveS12CalibrationCadence('monthly', '2026-08-09'), 'monthly')
assert.equal(resolveS12CalibrationCadence('regime_shift', '2026-08-09'), 'regime_shift')
assert.equal(resolveS12CalibrationCadence('auto', '2026-08-02'), 'monthly')
assert.equal(resolveS12CalibrationCadence('auto', '2026-03-08'), 'monthly')
assert.equal(resolveS12CalibrationCadence('auto', '2026-08-09'), 'weekly')
assert.equal(resolveS12CalibrationCadence('auto', 'invalid'), 'weekly')

console.log('S12 calibration cadence tests passed')
