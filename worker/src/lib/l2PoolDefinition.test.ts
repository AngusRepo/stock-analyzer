import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { buildL2PoolDefinitionReceipt, type L2PoolDefinitionInput } from './l2PoolDefinition'
import { L15_ADMISSION_RULE_VERSION, resolveL15AdmissionStrategyIds } from './multiStrategyPleRouter'
import { STRATEGY_SPEC_VERSION, type StrategySpec } from './strategySpec'

const input = (): L2PoolDefinitionInput => ({
  admissionRuleVersion: L15_ADMISSION_RULE_VERSION,
  routeScoreFormulaVersion: 'formula-v1',
  strategyRegistryChecksum: 'sha256:registry',
  admissionStrategyIds: ['trend', 'breakout'],
  regimeActiveStrategyIds: ['breakout'],
  staticPolicy: { l0_min_price: 10, l0_max_price: 500 },
  dailyParams: { regime: 'bull', evidenceMode: 'live', productionStrategyWeights: { breakout: 1, trend: 1 }, evaluationStrategyWeights: { breakout: 1 } },
  sourceUniverseCount: 800,
  l15SlateSymbols: ['2330', '2317', '6669'],
  safetyExcludedSymbols: ['6669'],
  poolSymbols: ['2317', '2330'],
})

test('receipt is deterministic and order independent', async () => {
  const a = await buildL2PoolDefinitionReceipt(input())
  const shuffled = input()
  shuffled.admissionStrategyIds.reverse()
  shuffled.poolSymbols.reverse()
  shuffled.staticPolicy = { l0_max_price: 500, l0_min_price: 10 }
  shuffled.dailyParams.productionStrategyWeights = { trend: 1, breakout: 1 }
  const b = await buildL2PoolDefinitionReceipt(shuffled)
  assert.equal(a.pool_definition_hash, b.pool_definition_hash)
  assert.equal(a.pool_members_checksum, b.pool_members_checksum)
  assert.deepEqual(a.admission_strategy_ids, ['breakout', 'trend'])
  assert.equal(a.pool_size, 2); assert.equal(a.l15_slate_size, 3); assert.equal(a.safety_excluded_count, 1)
  assert.equal(a.enforcement, 'evidence_only_not_gate')
})

test('rule hash moves with the rule, daily params only move the definition hash', async () => {
  const base = await buildL2PoolDefinitionReceipt(input())
  const bear = input(); bear.dailyParams.regime = 'bear'
  const regimeShift = await buildL2PoolDefinitionReceipt(bear)
  assert.equal(regimeShift.rule_hash, base.rule_hash)
  assert.notEqual(regimeShift.pool_definition_hash, base.pool_definition_hash)
  const added = input(); added.admissionStrategyIds.push('value')
  const ruleShift = await buildL2PoolDefinitionReceipt(added)
  assert.notEqual(ruleShift.rule_hash, base.rule_hash)
  const policy = input(); policy.staticPolicy.l0_min_price = 12
  assert.notEqual((await buildL2PoolDefinitionReceipt(policy)).rule_hash, base.rule_hash)
  const members = input(); members.poolSymbols.push('2454')
  const memberShift = await buildL2PoolDefinitionReceipt(members)
  assert.equal(memberShift.pool_definition_hash, base.pool_definition_hash, 'membership is data, not definition')
  assert.notEqual(memberShift.pool_members_checksum, base.pool_members_checksum)
})

test('admission strategy ids follow the router production-owner rule', () => {
  const spec = (id: string, extra: Partial<StrategySpec> = {}) => ({
    id, version: STRATEGY_SPEC_VERSION, name: id, status: 'active', owner: 'strategy',
    familyId: 'TREND_RECLAIM_CONTINUATION', variantId: id, ownerType: 'strategy', promotionStatus: 'production',
    alphaBucket: 'trend_following', supportedRegimes: ['bull'], thesis: 'test', thresholds: { minPrice: 10 },
    candidatePolicy: { poolQuota: 4, costBudget: 4 }, riskNotes: ['test'], createdBy: 'p5_strategy_governance', ...extra,
  }) as StrategySpec
  const specs = [spec('a'), spec('b', { supportedRegimes: ['bear'] }), spec('c', { status: 'shadow' }), spec('d')]
  const ids = resolveL15AdmissionStrategyIds(specs, { regime: 'bull', productionStrategyWeights: { a: 1, b: 1, c: 1, d: 0 } })
  assert.deepEqual(ids.admissionStrategyIds, ['a', 'b'])
  assert.deepEqual(ids.regimeActiveStrategyIds, ['a'])
})

test('screener persists the receipt in the existing funnel metadata', () => {
  const screener = fs.readFileSync('src/lib/marketScreener.ts', 'utf8')
  assert(screener.includes('        l2PoolDefinition,\n'), 'receipt must ride in screener_funnel_runs.metadata')
  assert(!/CREATE TABLE/i.test(fs.readFileSync('src/lib/l2PoolDefinition.ts', 'utf8')), 'no new D1 table')
})
