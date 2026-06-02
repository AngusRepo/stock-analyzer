import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const source = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

assert(
  source.includes('recordPendingBuyAuditOnly'),
  'intraday audit observations must be writable without replacing pending-buy runs',
)

assert(
  source.includes('function shouldPersistActiveExecutionStatus(status: PendingBuyActiveExecutionStatus): boolean') &&
    source.includes("status === 'requoted'") &&
    source.includes("status === 'partially_filled'") &&
    source.includes("status === 'quote_unavailable'") &&
    !source.includes("status === 'pending' ||") &&
    !source.includes("status === 'submitted' ||"),
  'volatile pending/submitted intraday observations must not persist into pending-buy lineage',
)

assert(
  source.includes('if (!shouldPersistActiveExecutionStatus(status)) return') &&
    source.indexOf('recordExecutionNote(symbol, status, reason, detail)') <
      source.indexOf('if (!shouldPersistActiveExecutionStatus(status)) return'),
  'active execution status must record audit before deciding whether to update pending-buy state',
)

assert(
  source.includes("recordExecutionNote(\n        pending.symbol,\n        'ohlcv_trade_plan',") &&
    !source.includes("String(point).startsWith('ohlcv_trade_plan:')"),
  'intraday OHLCV trade-plan refreshes must be audit-only, not pending item watch-point rewrites',
)

assert(
  source.includes("`allocator_${decision.action}`") &&
    !source.includes("!text.startsWith('allocator:')") &&
    !source.includes("!text.startsWith('execution:pending:allocator_')"),
  'allocator decisions inside the intraday loop must be audit-only, not watch-point rewrites',
)

assert(
  source.includes('} else if (executionAuditEvents.length > 0) {\n    await recordPendingBuyAuditOnly(env, today, pendingRunId,') &&
    source.includes("recordPendingBuyAuditOnly(env, today, pendingRunId, 'intraday_check', executionAuditEvents)"),
  'intraday loop must persist audit observations without replacing pending-buy state when no state transition occurred',
)
