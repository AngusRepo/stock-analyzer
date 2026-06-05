import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const paperExecutionEvents = readFileSync('src/lib/paperExecutionEvents.ts', 'utf8')

assert(paperEntryTasks.includes('buildIntradayTechnicalSnapshot'), 'intraday execution should build dynamic technical snapshots')
assert(paperEntryTasks.includes('resolveIntradayTechnicalDecision'), 'intraday execution should turn snapshots into pre-trade technical decisions')
assert(paperEntryTasks.includes('technical: intradayTechnicalDecision'), 'pre-trade policy should consume intraday technical decisions')
assert(paperEntryTasks.includes("'intraday_technical_decision'"), 'intraday execution should persist active technical decision events')
assert(paperEntryTasks.includes('INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED'), 'dynamic technical guard must be feature flagged')
assert(paperEntryTasks.includes('enabledFlag(env.INTRADAY_DYNAMIC_TECHNICAL_GUARD_ENABLED, true)'), 'dynamic technical guard should default on unless explicitly disabled')
assert(paperExecutionEvents.includes("'intraday_technical_decision'"), 'paper execution event contract should allow intraday technical decision events')
