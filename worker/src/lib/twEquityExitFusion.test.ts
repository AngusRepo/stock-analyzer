import {
  extractTwEquityExitFusionAnchorsFromOrderNote,
  isTwEquityExitFusionEligible,
  migrateCanonicalLifecycleExitFusionV2,
  resolveTwEquityExitFusionV2,
} from './twEquityExitFusion'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const legacyLifecycle = {
  version: 'canonical_trade_lifecycle_v1',
  owners: { exit: 's12_position_decision_v1' },
  entry: {
    entryPrice: 137.5,
    source: 's12_assist_entry',
    s12: {
      ready: true,
      invalidated: false,
      exitPlan: {
        tp1: 138,
        tp1Source: '15m_previous_high',
        mainExit: 146,
        mainExitSource: '1h_supply_zone',
      },
    },
  },
  exit: {
    tp1: 138,
    tp2: 150,
    atr14: 3.5,
    tpMultiplier: 2,
    tp2Multiplier: 2,
    anchors: { atrTp1: 144.5, atrTp2: 151.5, mlTp1: 145.5, mlTp2: 152.5 },
  },
}

const targets = resolveTwEquityExitFusionV2(legacyLifecycle)
assert(targets.nearPressureTp1 === 138, '15m previous high must remain near-pressure evidence')
assert(targets.nearPressureTp1Source === '15m_previous_high', 'near-pressure provenance must be preserved')
assert(targets.runnerTp1 === 145, 'runner TP1 must use the median of ATR and ML anchors')
assert(targets.runnerTp2 === 151.5, 'runner TP2 must use the median of valid runner anchors')
assert(targets.runnerTp1Source === 'tw_equity_runner_median_v2', 'multi-owner runner must expose median provenance')

const migrated = JSON.parse(migrateCanonicalLifecycleExitFusionV2(legacyLifecycle, targets) ?? '{}')
assert(migrated.owners.exit === 'tw_equity_exit_fusion_v2', 'migration must transfer exit ownership to fusion V2')
assert(migrated.exit.tp1 === 145, 'migration must not persist the 15m pressure as executable TP1')
assert(migrated.entry.s12.exitPlan.tp1 === 138, 'migration must preserve S12 pressure evidence')
assert(migrated.exit.anchors.mlTp1 === 145.5, 'migration must persist recovered/resolved anchors')

const recovered = extractTwEquityExitFusionAnchorsFromOrderNote(JSON.stringify({
  atr_tp1: 168.9089,
  atr_tp2: 200.3179,
  ml_t1: 157.32,
  ml_t2: 173.14,
}))
const recoveredTargets = resolveTwEquityExitFusionV2({
  ...legacyLifecycle,
  exit: { ...legacyLifecycle.exit, anchors: undefined, atr14: 8.7857142857, tpMultiplier: 3.575, tp2Multiplier: 2 },
}, recovered)
assert(recoveredTargets.runnerTp1 === 163.5, 'legacy S12 lifecycle must recover and TW-tick normalize ML/ATR TP1 anchors')
assert(recoveredTargets.runnerTp2 === 187, 'legacy S12 lifecycle must recover and TW-tick normalize ML/ATR TP2 anchors')
assert(recoveredTargets.recoveredAnchorCount === 4, 'resolver must report recovered anchors for lazy persistence')

const duplicateAtr = resolveTwEquityExitFusionV2({
  ...legacyLifecycle,
  exit: {
    ...legacyLifecycle.exit,
    tp1: 175.4625,
    tp2: 209.425,
    anchors: { atrTp1: 175.4625, atrTp2: 209.425, mlTp1: 186.43, mlTp2: 203.53 },
  },
})
assert(duplicateAtr.runnerTp1 === 181, 'legacy TP equal to ATR anchor must not double-weight ATR TP1')
assert(duplicateAtr.runnerTp2 === 206.5, 'legacy TP equal to ATR anchor must not double-weight ATR TP2')

const nonS12 = resolveTwEquityExitFusionV2({
  version: 'canonical_trade_lifecycle_v1',
  owners: { exit: 'paper_sltp_atr_trailing_v1' },
  entry: { entryPrice: 100, s12: null },
  exit: { tp1: 106 },
})
assert(nonS12.runnerTp1 == null, 'non-S12 positions must remain under the existing SLTP contract')

const setupOnlyLifecycle = {
  version: 'canonical_trade_lifecycle_v1',
  owners: { exit: 's12_position_decision_v1' },
  entry: { entryPrice: 141.5, source: 'pre_trade_plan', s12: { ready: false, invalidated: false } },
  exit: { tp1: 175.4625, tp2: 209.425 },
}
assert(!isTwEquityExitFusionEligible(setupOnlyLifecycle), 'setup-only S12 context must not own position exits')
assert(resolveTwEquityExitFusionV2(setupOnlyLifecycle).runnerTp1 == null, 'setup-only S12 context must keep paper SLTP targets')

console.log('twEquityExitFusion tests passed')
