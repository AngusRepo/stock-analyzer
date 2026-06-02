import { readFileSync } from 'node:fs'
import { shouldMarkPendingDebateSlaReached } from './pendingDebateSla'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  assert(shouldMarkPendingDebateSlaReached(new Date('2026-04-29T01:09:00.000Z'), 10) === false, '09:09 TW should still allow debate to finish')
  assert(shouldMarkPendingDebateSlaReached(new Date('2026-04-29T01:10:00.000Z'), 10) === true, '09:10 TW should mark debate SLA reached')
  assert(shouldMarkPendingDebateSlaReached(new Date('2026-04-29T00:59:00.000Z'), 10) === false, 'before market open should not expire pending debate')
}

{
  const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
  assert(
    paperEntryTasks.includes('debate_sla_waiting') &&
      paperEntryTasks.includes('persistPendingBuyActiveState') &&
      !paperEntryTasks.includes("status: 'skipped', reason: 'debate_sla_expired'"),
    'intraday debate SLA must keep pending candidates active instead of terminal-skipping the execution watch pool',
  )
}
