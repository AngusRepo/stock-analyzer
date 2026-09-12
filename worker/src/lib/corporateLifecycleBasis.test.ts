import assert from 'node:assert/strict'
import test from 'node:test'
import { adjustCanonicalCorporatePriceBasis } from './canonicalTradeLifecycle'
import { resolveTwEquityExitFusionV2 } from './twEquityExitFusion'

test('corporate repricing transforms all active price owners, not ratios or historical input', () => {
  const original = { version: 'canonical_trade_lifecycle_v1', owners: { exit: 'tw_equity_exit_fusion_v2' },
    entry: { entryPrice: 100, stopLoss: 90, chaseCeiling: 105,
      s12: { structureStop: 91, rMultiple: 2, quality: { priceVsVwapPct: 3,
        vwapContext: { session: 95, confluenceWidthPct: .4 } },
        exitPlan: { tp1: 120, mainExit: 140, trailingInitial: 92 } } },
    exit: { initialStop: 90, trailingStop: 92, tp1: 120, tp2: 140, atr14: 10,
      stopMultiplier: 2, tpMultiplier: 2, tp2Multiplier: 2, anchors: { atrTp1: 120, mlTp2: null } } }
  const repriced = JSON.parse(adjustCanonicalCorporatePriceBasis(original, .5, ['cash', 'stock'])!)
  assert.equal(original.entry.entryPrice, 100)
  assert.equal(repriced.entry.entryPrice, 50)
  assert.equal(repriced.entry.s12.exitPlan.trailingInitial, 46)
  assert.equal(repriced.entry.s12.quality.vwapContext.session, 47.5)
  assert.equal(repriced.entry.s12.quality.vwapContext.confluenceWidthPct, .4)
  assert.equal(repriced.entry.s12.rMultiple, 2)
  assert.equal(repriced.exit.stopMultiplier, 2)
  // The immutable old order-note anchor is also repriced when used as fallback.
  const resolved = resolveTwEquityExitFusionV2(repriced, { atrTp2: 140, mlTp1: 120, mlTp2: 140 })
  assert.deepEqual(resolved.anchors, { atrTp1: 60, atrTp2: 70, mlTp1: 60, mlTp2: 70 })
  assert.equal(resolved.runnerTp1, 60)
  assert.equal(resolved.runnerTp2, 70)
  assert.throws(() => adjustCanonicalCorporatePriceBasis(repriced, .5, ['cash']), /repeated/)
  assert.throws(() => adjustCanonicalCorporatePriceBasis({ version: 'unknown' }, .5, ['cash']), /version_unknown/)
})
