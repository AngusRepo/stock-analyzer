import assert from 'node:assert/strict'
import { assertCanonicalL15SeedIdentity } from './marketScreener'
import { recordPostRouteExternalVeto } from './screenerPostOverlaySeed'
import { classifyExternalEvidenceRisk } from './newsThemeRiskOverlay'
import { readFileSync } from 'node:fs'

// Original flow removed 2317 on a real classified veto, then failed final
// reconciliation because only DelistingMonitor wrote a safety receipt.
const route = [{ symbol: '2330' }, { symbol: '2317' }]
const excluded = new Set<string>()
const risk = classifyExternalEvidenceRisk({ source_id: 'official_rss',
  decision_effect: 'veto', title: 'official trading halt', source_quality_score: .9, entity_linking_confidence: .9 })!
assert.equal(risk.action, 'veto')
assert.throws(() => assertCanonicalL15SeedIdentity({ routeSymbols: route.map(r => r.symbol), finalSymbols: ['2330'] }),
  /unexplained_exclusion=2317/)
recordPostRouteExternalVeto('2317', { symbol: '2317', ...risk, evidence: [] }, route, excluded)
assert.doesNotThrow(() => assertCanonicalL15SeedIdentity({
  routeSymbols: route.map(r => r.symbol), finalSymbols: ['2330'], safetyExcludedSymbols: excluded }))
recordPostRouteExternalVeto('2454', { symbol: '2454', ...risk, evidence: [] }, route, excluded)
assert.deepEqual([...excluded], ['2317'], 'veto outside actual route must not create an invalid receipt')
recordPostRouteExternalVeto('2330', { symbol: '2330', action: 'penalize', penalty: -5, flags: [], evidence: [] }, route, excluded)
assert.deepEqual([...excluded], ['2317'], 'penalty is not an exclusion')
assert.throws(() => assertCanonicalL15SeedIdentity({
  routeSymbols: route.map(r => r.symbol), finalSymbols: [], safetyExcludedSymbols: excluded }), /unexplained_exclusion=2330/)
const source = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
assert(source.includes('scored, overlayEligibleSymbols, evidenceRisk, layer2CoarseQueueSeed, postL15SafetyExcludedSymbols)'),
  'actual screener passes its real route and safety receipt set to the shared risk owner')
const shared = readFileSync(new URL('./screenerPostRouteOverlays.ts', import.meta.url), 'utf8')
const vetoBranch = shared.slice(shared.indexOf("if (overlay.action === 'veto')"), shared.indexOf('scored.splice(i, 1)', shared.indexOf("if (overlay.action === 'veto')")))
assert(vetoBranch.includes('recordPostRouteExternalVeto(c.symbol, overlay, layer2CoarseQueueSeed, postL15SafetyExcludedSymbols)'),
  'actual risk removal must feed the same final reconciliation set')

assert.doesNotThrow(() => assertCanonicalL15SeedIdentity({
  routeSymbols: ['2330', '2317'],
  finalSymbols: ['2330', '2317'],
}))

assert.doesNotThrow(() => assertCanonicalL15SeedIdentity({
  routeSymbols: ['2330', '2317'],
  finalSymbols: ['2330'],
  safetyExcludedSymbols: ['2317'],
}))

assert.throws(
  () => assertCanonicalL15SeedIdentity({
    routeSymbols: ['2330', '2317'],
    finalSymbols: ['2330'],
  }),
  /unexplained_exclusion=2317/,
)

assert.throws(
  () => assertCanonicalL15SeedIdentity({
    routeSymbols: ['2330'],
    finalSymbols: ['2330', '2317'],
  }),
  /missing_route=2317/,
)

assert.throws(
  () => assertCanonicalL15SeedIdentity({
    routeSymbols: ['2330', '2317'],
    finalSymbols: ['2330'],
    safetyExcludedSymbols: ['2330'],
  }),
  /unexplained_exclusion=2317:invalid_safety_receipt=2330/,
)

console.log('screener canonical seed identity tests passed')
