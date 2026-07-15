import { readFileSync } from 'node:fs'
import {
  applyS12TwCalibrationArtifact,
  resolveS12TwCalibrationArtifact,
  type S12TwCalibrationArtifact,
} from './s12TwEquityCalibration'
import { DEFAULT_S12_TIMING_POLICY } from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const schema = readFileSync('schema.sql', 'utf8')
const migration = readFileSync('migration_s12_tw_calibration_v2_2026_07_11.sql', 'utf8')
const source = readFileSync('src/lib/s12TwEquityCalibration.ts', 'utf8')
assert(schema.includes('CREATE TABLE IF NOT EXISTS s12_tw_calibration_artifacts'), 'base schema must include calibration artifacts')
assert(migration.includes('idx_s12_tw_calibration_active'), 'production migration must include the active-artifact resolver index')
assert(source.includes('LEFT JOIN stocks s ON s.symbol = o.symbol'), 'calibration evidence must recover missing historical market segments from stocks')
assert(source.includes("replay_diagnostics.replay_engine_signature"), 'calibration must reject replay rows from incompatible engines')
assert(source.includes('S12_REPLAY_ENGINE_SIGNATURE'), 'calibration and replay must share one engine-signature owner')

function artifact(
  id: string,
  marketSegment: string,
  alphaBucket: string | null,
  entryTimeBucket: S12TwCalibrationArtifact['scope']['entryTimeBucket'],
): S12TwCalibrationArtifact {
  return {
    artifactId: id,
    runId: 'run-1',
    status: 'approved',
    cadence: 'weekly',
    scope: { marketSegment, alphaBucket, entryTimeBucket },
    policy: { limitedMutationMinScore: 5, maxStopRiskPct: 0.035 },
    exit: { tp1MfeQuantile: 0.04, tp2MfeQuantile: 0.08, stopMaeQuantile: 0.02, minNetProfitR: 0.25 },
    validationStart: '2026-04-01',
    validationEnd: '2026-07-07',
    sampleCount: 80,
    dateCount: 20,
    metrics: {},
    createdAt: '2026-07-08T00:00:00.000Z',
    approvedAt: '2026-07-08T00:00:00.000Z',
  }
}

const artifacts = [
  artifact('listed-peer', 'LISTED', null, null),
  artifact('listed-alpha', 'LISTED', 'high', null),
  artifact('listed-alpha-opening', 'LISTED', 'high', 'opening'),
]

assert(resolveS12TwCalibrationArtifact(artifacts, {
  marketSegment: 'LISTED',
  alphaBucket: 'high',
  entryTimeBucket: 'opening',
})?.artifactId === 'listed-alpha-opening', 'resolver must prefer the exact peer/time scope')

assert(resolveS12TwCalibrationArtifact(artifacts, {
  marketSegment: 'LISTED',
  alphaBucket: 'high',
  entryTimeBucket: 'mid_session',
})?.artifactId === 'listed-alpha', 'resolver must fall back to the same alpha peer before market peer')

assert(resolveS12TwCalibrationArtifact(artifacts, {
  marketSegment: 'OTC',
  alphaBucket: 'high',
  entryTimeBucket: 'opening',
}) == null, 'resolver must not use a cross-market global artifact')

assert(resolveS12TwCalibrationArtifact(artifacts, {
  marketSegment: 'LISTED',
  alphaBucket: 'high',
  entryTimeBucket: 'opening',
  asOfDate: '2026-07-07',
}) == null, 'historical replay must reject artifacts trained through or after the replay date')

const policy = applyS12TwCalibrationArtifact(DEFAULT_S12_TIMING_POLICY, artifacts[0])
assert(policy.limitedMutationMinScore === 5, 'approved policy must override the static baseline')
assert(policy.maxStopRiskPct === 0.035, 'approved stop-risk calibration must be active')
assert(policy.fullCoverageSession60Bars === 3, 'calibration must preserve the TW 60M session contract')

console.log('s12TwEquityCalibration tests passed')
