import { readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const pendingBuyStore = readFileSync('src/lib/pendingBuyStore.ts', 'utf8')
const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')

assert(
  pendingBuyStore.includes('): Promise<number | null>'),
  'replacePendingBuyState should return the newly inserted run id',
)
assert(
  pendingBuyStore.includes('const meta = runId != null ? { ...baseMeta, run_id: runId } : baseMeta'),
  'KV pending-buy meta should carry the active D1 run id after replacement',
)
assert(
  pendingBuyStore.includes('const pendingRunId = await replacePendingBuyState(env, {'),
  'paper execution events should link to the new run created for the updated state',
)
assert(
  paperEntryTasks.includes('auto_swap_replacement_not_executable'),
  'auto-swap must not sell the weak holding before confirming the replacement buy is executable',
)
assert(
  paperEntryTasks.indexOf('auto_swap_replacement_not_executable') < paperEntryTasks.indexOf('Replacing ${weakest.symbol}'),
  'replacement executability guard must run before the auto-swap sell',
)
