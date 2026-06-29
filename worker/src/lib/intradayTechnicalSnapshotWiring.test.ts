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
  readFileSync('src/lib/s12IntradayStructure.ts', 'utf8').includes("policy: 'advisory_until_reaction_ready_or_invalidated'") &&
  readFileSync('src/lib/s12IntradayStructure.ts', 'utf8').includes('takeover_eligible'),
  'S12 assessment must expose takeover maturity policy and blocker telemetry',
)
assert(paperEntryTasks.includes('s12PrimaryMomentumContext'), 'S12 ready owner must replace overlapping momentum direction gates')
assert(paperEntryTasks.includes('slope5min: null') && paperEntryTasks.includes('rangePosition: null'), 'S12 ready owner should clear slope/range vetoes while keeping liquidity gates')
assert(paperEntryTasks.includes("'intraday_technical_decision'"), 'intraday execution should persist active technical decision events')
assert(paperEntryTasks.includes('INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED'), 'dynamic technical guard must be feature flagged')
assert(paperEntryTasks.includes('enabledFlag(env.INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED, true)'), 'dynamic technical guard should default on unless explicitly disabled')
assert(paperExecutionEvents.includes("'intraday_technical_decision'"), 'paper execution event contract should allow intraday technical decision events')
