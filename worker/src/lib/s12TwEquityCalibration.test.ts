import { readFileSync } from 'node:fs'
import {
  applyS12TwCalibrationArtifact,
  resolveS12TwCalibrationArtifact,
  s12TwEntryCohortFromState,
  type S12TwCalibrationArtifact,
} from './s12TwEquityCalibration'
import { DEFAULT_S12_TIMING_POLICY } from './s12IntradayStructure'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const schema = readFileSync('schema.sql', 'utf8')
const migration = readFileSync('migration_s12_tw_calibration_v2_2026_07_11.sql', 'utf8')
const source = readFileSync('src/lib/s12TwEquityCalibration.ts', 'utf8')
const replaySource = readFileSync('src/lib/s12ReplayTradeOutcome.ts', 'utf8')
const splitReadModels = readFileSync('src/lib/s12ReplaySplitReadModels.ts', 'utf8')
assert(schema.includes('CREATE TABLE IF NOT EXISTS s12_tw_calibration_artifacts'), 'base schema must include calibration artifacts')
assert(migration.includes('idx_s12_tw_calibration_active'), 'production migration must include the active-artifact resolver index')
assert(!source.match(/JOIN\s+stocks/i), 'Learning calibration must not issue an illegal cross-D1 stocks join')
assert(source.includes("COALESCE(NULLIF(TRIM(o.market), ''), 'UNKNOWN') AS market"), 'calibration evidence must read the market identity persisted with the replay outcome')
assert(splitReadModels.includes('loadCoreStockIdentitiesBySymbols'), 'split replay producer must load stock identities from the Core D1 owner')
assert(splitReadModels.includes('market: row.market ?? identity?.market ?? null'), 'split replay producer must attach the Core market identity before persistence')
assert(replaySource.includes('symbol, market, signal_date, trade_date'), 'replay persistence must snapshot market identity into the Learning-owned outcome row')
assert(replaySource.includes('market: row.market ?? null'), 'replay runner must carry the split Core market identity into every outcome')
assert(source.includes("replay_diagnostics.replay_engine_signature"), 'calibration must reject replay rows from incompatible engines')
assert(source.includes('S12_REPLAY_ENGINE_SIGNATURE'), 'calibration and replay must share one engine-signature owner')
assert(source.includes('CALIBRATION_EVIDENCE_PAGE_SIZE = 128'), 'calibration evidence must be loaded in memory-bounded pages')
assert(source.includes('SELECT COALESCE(MAX(o.id), 0) AS max_id'), 'calibration must capture an immutable upper cursor before page one')
assert(source.includes('WHERE o.id > ?') && source.includes('AND o.id <= ?'), 'calibration evidence pagination must stay inside its keyset snapshot')
assert(source.includes("AS assessment_detail"), 'calibration must project only the compact assessment scalar')
assert(!source.includes('o.max_adverse_pct, o.detail_json'), 'calibration must not materialize the full replay JSON payload')
const atomicCommit = source.slice(
  source.indexOf('export async function commitS12TwCalibrationAtomically'),
  source.indexOf('export async function runS12TwCalibration'),
)
assert(atomicCommit.includes('await db.batch(statements)'), 'S12 promotion must commit through one D1 transaction')
assert(!atomicCommit.includes('.run()'), 'S12 promotion must not fall back to torn direct writes')
assert(atomicCommit.indexOf('DELETE FROM s12_tw_calibration_artifacts') < atomicCommit.indexOf('UPDATE s12_tw_calibration_artifacts'), 'incomplete-run cleanup must be the first optional batch statement')
assert(atomicCommit.indexOf('INSERT OR REPLACE INTO s12_tw_calibration_artifacts') < atomicCommit.indexOf('INSERT OR REPLACE INTO s12_tw_calibration_runs'), 'canonical run receipt must be the final batch statement')

function artifact(
  id: string,
  marketSegment: string,
  alphaBucket: string | null,
  entryTimeBucket: S12TwCalibrationArtifact['scope']['entryTimeBucket'],
  entryCohort: S12TwCalibrationArtifact['scope']['entryCohort'] = 'reaction_ready',
): S12TwCalibrationArtifact {
  return {
    artifactId: id,
    runId: 'run-1',
    status: 'approved',
    cadence: 'weekly',
    scope: { marketSegment, entryCohort, alphaBucket, entryTimeBucket },
    policy: {
      limitedMutationMinScore: 5,
      maxStopRiskPct: 0.035,
      sessionAcceptanceMinMoveAtr: 0.42,
      sessionAcceptanceMinClosePosition: 0.78,
    },
    exit: { tp1MfeQuantile: 0.04, tp2MfeQuantile: 0.08, stopMaeQuantile: 0.02, minNetProfitR: 0.25 },
    validationStart: '2026-04-01',
    validationEnd: '2026-07-07',
    sampleCount: 80,
    dateCount: 20,
    metrics: { return_basis: 'net_after_roundtrip_cost', return_unit: 'r_multiple', roundtrip_cost_bps: 18 },
    createdAt: '2026-07-08T00:00:00.000Z',
    approvedAt: '2026-07-08T00:00:00.000Z',
  }
}

const artifacts = [
  artifact('listed-peer', 'LISTED', null, null),
  artifact('listed-alpha', 'LISTED', 'high', null),
  artifact('listed-alpha-opening', 'LISTED', 'high', 'opening'),
]
const legacyGrossArtifact = {
  ...artifacts[0],
  artifactId: 'legacy-gross-r',
  metrics: {},
}
assert(resolveS12TwCalibrationArtifact([legacyGrossArtifact], {
  entryCohort: 'reaction_ready', marketSegment: 'LISTED', alphaBucket: null, entryTimeBucket: null,
}) == null, 'serving resolver must reject legacy gross-R artifacts without the canonical net-R contract')

assert(resolveS12TwCalibrationArtifact(artifacts, {
  entryCohort: 'reaction_ready',
  marketSegment: 'LISTED',
  alphaBucket: 'high',
  entryTimeBucket: 'opening',
})?.artifactId === 'listed-alpha-opening', 'resolver must prefer the exact peer/time scope')

assert(resolveS12TwCalibrationArtifact(artifacts, {
  entryCohort: 'reaction_ready',
  marketSegment: 'LISTED',
  alphaBucket: 'high',
  entryTimeBucket: 'mid_session',
})?.artifactId === 'listed-alpha', 'resolver must fall back to the same alpha peer before market peer')

assert(resolveS12TwCalibrationArtifact(artifacts, {
  entryCohort: 'reaction_ready',
  marketSegment: 'OTC',
  alphaBucket: 'high',
  entryTimeBucket: 'opening',
}) == null, 'resolver must not use a cross-market global artifact')

assert(resolveS12TwCalibrationArtifact(artifacts, {
  entryCohort: 'reaction_ready',
  marketSegment: 'LISTED',
  alphaBucket: 'high',
  entryTimeBucket: 'opening',
  asOfDate: '2026-07-07',
}) == null, 'historical replay must reject artifacts trained through or after the replay date')

const limited = artifact('listed-limited', 'LISTED', 'high', 'opening', 'limited_takeover_ready')
assert(resolveS12TwCalibrationArtifact([...artifacts, limited], {
  entryCohort: 'limited_takeover_ready', marketSegment: 'LISTED', alphaBucket: 'high', entryTimeBucket: 'opening',
})?.artifactId === 'listed-limited', 'limited takeover must resolve its own cohort artifact')
assert(resolveS12TwCalibrationArtifact(artifacts, {
  marketSegment: 'LISTED', alphaBucket: 'high', entryTimeBucket: 'opening',
}) == null, 'resolver must reject requests without an explicit entry cohort')

assert(s12TwEntryCohortFromState('reaction_ready') === 'reaction_ready', 'explicit full-reaction state must preserve its cohort')
assert(s12TwEntryCohortFromState('limited_takeover_ready') === 'limited_takeover_ready', 'explicit limited state must preserve its cohort')
assert(s12TwEntryCohortFromState(null) === undefined, 'missing lifecycle state must not guess an S12 calibration cohort')

const policy = applyS12TwCalibrationArtifact(DEFAULT_S12_TIMING_POLICY, artifacts[0])
assert(policy.limitedMutationMinScore === 5, 'approved policy must override the static baseline')
assert(policy.maxStopRiskPct === 0.035, 'approved stop-risk calibration must be active')
assert(policy.sessionAcceptanceMinMoveAtr === 0.42, 'approved whole-session move calibration must be active')
assert(policy.sessionAcceptanceMinClosePosition === 0.78, 'approved whole-session close-position calibration must be active')
assert(policy.fullCoverageSession60Bars === 3, 'calibration must preserve the TW 60M session contract')

console.log('s12TwEquityCalibration tests passed')
