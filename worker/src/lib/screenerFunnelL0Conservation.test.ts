import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  L0_DROP_REASON_CONFIG_VERSION,
  L0_DROP_REASON_CONSERVATION_RUN_VERSION,
  L0_DROP_REASON_CONSERVATION_SCHEMA_VERSION,
  L0_DROP_PRIMARY_REASON_TAXONOMY,
  buildL0DropReasonConservation,
  compactL0DropReasonConservationReceipt,
  type BuildL0DropReasonConservationInput,
  type ScreenerFunnelRow,
} from './screenerFunnelEvidence'

const sourceUniverseSymbols = ['2603', '2330', '1216', '1101']
const rows: ScreenerFunnelRow[] = [
  {
    symbol: '2603',
    stage: 'universe',
    decision: 'DROP',
    reason_code: ' PRICE_OUT_OF_RANGE ',
  },
  {
    symbol: '2330',
    stage: 'universe',
    decision: 'pass',
    reason_code: 'hard_filters_passed',
  },
  {
    symbol: '1216',
    stage: 'universe',
    decision: 'drop',
    reason_code: 'hard_trading_restriction_block',
    evidence: JSON.stringify({ restriction_subreason: 'disposition_stock' }),
  },
  {
    symbol: '1101',
    stage: 'universe',
    decision: 'drop',
    reason_code: 'price_out_of_range',
  },
  {
    symbol: '2330',
    stage: 'scoring',
    decision: 'pass',
    reason_code: 'scored',
  },
]

const report = buildL0DropReasonConservation({ sourceUniverseSymbols, rows })
assert.equal(report.schema_version, L0_DROP_REASON_CONSERVATION_SCHEMA_VERSION)
assert.equal(report.run_version, L0_DROP_REASON_CONSERVATION_RUN_VERSION)
assert.equal(report.config_version, L0_DROP_REASON_CONFIG_VERSION)
assert.equal(report.source_universe, 4)
assert.equal(report.pass, 1)
assert.equal(report.drop, 3)
assert.equal(report.source_universe, report.pass + report.drop)
assert.deepEqual(report.primary_reason_counts, {
  hard_trading_restriction_block: 1,
  price_out_of_range: 2,
})
assert.equal(
  Object.values(report.primary_reason_counts).reduce((sum, count) => sum + count, 0),
  report.drop,
)
assert.deepEqual(report.restriction_subreason_counts, { disposition_stock: 1 })
assert.deepEqual(report.primary_reason_precedence, L0_DROP_PRIMARY_REASON_TAXONOMY)
assert.deepEqual(report.drop_assignments, [
  { symbol: '1101', primary_reason: 'price_out_of_range' },
  {
    symbol: '1216',
    primary_reason: 'hard_trading_restriction_block',
    restriction_subreason: 'disposition_stock',
  },
  { symbol: '2603', primary_reason: 'price_out_of_range' },
])
assert.deepEqual(report.conservation, {
  source_universe_equals_pass_plus_drop: true,
  primary_reason_counts_equal_drop: true,
  every_drop_has_exactly_one_primary_reason: true,
})

const receipt = compactL0DropReasonConservationReceipt(report)
assert.equal(receipt.drop_assignment_count, report.drop)
assert.equal(
  'drop_assignments' in receipt,
  false,
  'compact metadata receipt must not duplicate per-symbol funnel evidence',
)

const reorderedReport = buildL0DropReasonConservation({
  sourceUniverseSymbols: [...sourceUniverseSymbols].reverse(),
  rows: [...rows].reverse(),
})
assert.equal(
  JSON.stringify(reorderedReport),
  JSON.stringify(report),
  'input ordering must not change the deterministic conservation report',
)

function expectContractError(
  input: BuildL0DropReasonConservationInput,
  expected: RegExp,
): void {
  assert.throws(() => buildL0DropReasonConservation(input), expected)
}

expectContractError(
  { sourceUniverseSymbols: ['2330', '2317'], rows: [rows[1]] },
  /l0_drop_reason_terminal_outcome_missing:2317/,
)
expectContractError(
  {
    sourceUniverseSymbols: ['2603'],
    rows: [rows[0], { ...rows[0], reason_code: 'zero_volume' }],
  },
  /l0_drop_reason_multiple_terminal_outcomes:2603/,
)
expectContractError(
  {
    sourceUniverseSymbols: ['2603'],
    rows: [{ symbol: '2603', stage: 'universe', decision: 'drop' }],
  },
  /l0_drop_reason_primary_reason_missing:2603/,
)
expectContractError(
  {
    sourceUniverseSymbols: ['2603'],
    rows: [{
      symbol: '2603',
      stage: 'universe',
      decision: 'drop',
      reason_code: 'price_out_of_range|zero_volume',
    }],
  },
  /l0_drop_reason_primary_reason_invalid:2603/,
)
expectContractError(
  {
    sourceUniverseSymbols: ['2603'],
    rows: [{
      symbol: '2603',
      stage: 'universe',
      decision: 'drop',
      reason_code: 'unversioned_reason',
    }],
  },
  /l0_drop_reason_primary_reason_unknown:2603:unversioned_reason/,
)
expectContractError(
  {
    sourceUniverseSymbols: ['2330'],
    rows: [{ symbol: '2317', stage: 'universe', decision: 'pass' }],
  },
  /l0_drop_reason_outcome_outside_source_universe:2317/,
)
expectContractError(
  {
    sourceUniverseSymbols: ['2330'],
    rows: [{ symbol: '2330', stage: 'universe', decision: 'observe' }],
  },
  /l0_drop_reason_invalid_terminal_decision:2330:observe/,
)
expectContractError(
  {
    sourceUniverseSymbols: ['1216'],
    rows: [{
      symbol: '1216',
      stage: 'universe',
      decision: 'drop',
      reason_code: 'price_out_of_range',
      evidence: { restriction_subreason: 'disposition_stock' },
    }],
  },
  /l0_drop_reason_restriction_subreason_without_restriction_primary:1216/,
)
expectContractError(
  { sourceUniverseSymbols: ['2330', ' 2330 '], rows: [rows[1]] },
  /l0_drop_reason_duplicate_source_symbols:2330/,
)

const scaledSymbols = Array.from(
  { length: 1442 },
  (_, index) => `S${String(index + 1).padStart(4, '0')}`,
)
const scaledReport = buildL0DropReasonConservation({
  sourceUniverseSymbols: scaledSymbols,
  rows: scaledSymbols.map((symbol, index) => ({
    symbol,
    stage: 'universe',
    decision: 'drop',
    reason_code: L0_DROP_PRIMARY_REASON_TAXONOMY[
      index % L0_DROP_PRIMARY_REASON_TAXONOMY.length
    ],
  })),
})
assert.equal(scaledReport.source_universe, 1442)
assert.equal(scaledReport.pass, 0)
assert.equal(scaledReport.drop, 1442)
assert.equal(
  Object.values(scaledReport.primary_reason_counts).reduce((sum, count) => sum + count, 0),
  1442,
)
const scaledReceipt = compactL0DropReasonConservationReceipt(scaledReport)
assert.equal(scaledReceipt.drop_assignment_count, 1442)
assert.equal('drop_assignments' in scaledReceipt, false)
assert.ok(
  JSON.stringify(scaledReceipt).length < 5000,
  '1442-row compact receipt must remain bounded for D1 run metadata',
)

const producerSource = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
assert.match(
  producerSource,
  /if \(prices\.length < 3\) \{[\s\S]*?reasonCode: 'insufficient_price_history'/,
  'every short-history source symbol must receive a terminal L0 drop row',
)
assert.match(
  producerSource,
  /buildL0DropReasonConservation\(\{[\s\S]*?sourceUniverseSymbols: data\.prices\.keys\(\)[\s\S]*?\.filter\(\(item\) => item\.stage === 'universe'\)/,
  'production conservation must use the true source universe and L0 terminal rows',
)
assert.match(
  producerSource,
  /compactL0DropReasonConservationReceipt\([\s\S]*?l0DropReasonConservation: l0DropReasonConservationReceipt/,
  'production funnel metadata must persist only the compact receipt',
)
assert.ok(
  producerSource.indexOf('buildL0DropReasonConservation({')
    < producerSource.indexOf('await writeScreenerFunnel(env, {'),
  'conservation must validate before funnel persistence',
)
assert.match(producerSource, /const artifactPayload = \{\s*metadata: metadataWithRouteRecovery,/)
assert.match(producerSource, /const metadata = JSON\.stringify\(metadataWithRouteRecovery\)/)

console.log('screener funnel L0 conservation tests passed')
