import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const paperExecutionEvents = readFileSync('src/lib/paperExecutionEvents.ts', 'utf8')

assert(paperEntryTasks.includes('buildIntradayTechnicalSnapshot'), 'intraday execution should build dynamic technical snapshots')
assert(paperEntryTasks.includes('resolveIntradayTechnicalDecision'), 'intraday execution should turn snapshots into pre-trade technical decisions')
assert(paperEntryTasks.includes('effectiveTechnicalDecision'), 'pre-trade policy should consume the effective technical owner')
assert(paperEntryTasks.includes('S12_INTRADAY_PRIMARY_OWNER_ENABLED'), 'S12 primary owner must be feature flagged')
assert(paperEntryTasks.includes('s12PrimaryStructureOwnerActive'), 'S12 primary owner must be able to replace overlapping intraday technical vetoes')
assert(
  paperEntryTasks.includes('(s12Assessment.ready || s12Assessment.invalidated)') &&
  paperEntryTasks.includes('s12_structure_advisory_waiting'),
  'S12 must stay advisory until the intraday structure is ready or invalidated',
)
assert(
  readFileSync('src/lib/s12IntradayStructure.ts', 'utf8').includes("policy: 'advisory_until_long_reaction_bearish_defense_or_invalidated'") &&
  readFileSync('src/lib/s12IntradayStructure.ts', 'utf8').includes('takeover_role'),
  'S12 assessment must expose takeover maturity role, policy, and blocker telemetry',
)
assert(paperEntryTasks.includes('s12PrimaryMomentumContext'), 'S12 ready owner must replace overlapping momentum direction gates')
assert(paperEntryTasks.includes('slope5min: null') && paperEntryTasks.includes('rangePosition: null'), 'S12 ready owner should clear slope/range vetoes while keeping liquidity gates')
assert(paperEntryTasks.includes('resolveS12AssistedExitInputs'), 'S12-assisted fills must resolve structure-first exit inputs')
assert(paperEntryTasks.includes('effectiveInitialStop') && paperEntryTasks.includes('effectiveTp1Price') && paperEntryTasks.includes('effectiveTp2Price'), 'paper positions should persist effective S12/ATR stop and TP inputs')
assert(paperEntryTasks.includes("'s12_structure_exit_plan'"), 'S12-assisted order notes should expose structure exit input source')
assert(paperEntryTasks.includes('canonical_trade_lifecycle'), 'paper order notes should persist canonical trade lifecycle for UI and audits')
assert(paperEntryTasks.includes("'intraday_technical_decision'"), 'intraday execution should persist active technical decision events')
assert(paperEntryTasks.includes('INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED'), 'dynamic technical guard must be feature flagged')
assert(paperEntryTasks.includes('enabledFlag(env.INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED, true)'), 'dynamic technical guard should default on unless explicitly disabled')
assert(paperExecutionEvents.includes("'intraday_technical_decision'"), 'paper execution event contract should allow intraday technical decision events')
