const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const taskMap = fs.readFileSync('src/lib/adminTriggerWorkerDomainTasks.ts', 'utf8')
const triggerRoute = fs.readFileSync('src/routes/adminTriggerRoutes.ts', 'utf8')
const adaptiveEngine = fs.readFileSync('src/lib/adaptiveEngine.ts', 'utf8')

assert(taskMap.includes('runNeuralMetaShadow'), 'Neural meta shadow must call the shared runner')
assert(taskMap.includes("'neural-ucb-shadow'"), 'NeuralUCB shadow must be triggerable')
assert(taskMap.includes("'neural-ts-shadow'"), 'NeuralTS shadow must be triggerable')
assert(taskMap.includes('X-Confirm-Meta-Learning'), 'shadow persistence must require an explicit confirm header')
assert(taskMap.includes('dryRun: !persist'), 'shadow trigger must default to dry-run unless explicitly persisted')
assert(taskMap.includes('parseBoundedPositiveInt'), 'shadow trigger must bound requested training row limits')
assert(triggerRoute.includes("'neural-ucb-shadow'"), 'NeuralUCB shadow must be marked as long-running')
assert(triggerRoute.includes("'neural-ts-shadow'"), 'NeuralTS shadow must be marked as long-running')
assert(adaptiveEngine.includes('refreshLinUcbRewardLedger'), 'adaptive update must refresh LinUCB reward ledger evidence')
assert(adaptiveEngine.includes('meta-context-v2'), 'adaptive bandit context must expose expanded meta-context version')
assert(adaptiveEngine.includes('linucb_reward_ledger'), 'adaptive params must include LinUCB reward ledger status')
