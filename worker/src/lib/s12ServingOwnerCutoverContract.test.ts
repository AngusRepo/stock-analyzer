const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const orchestrator = fs.readFileSync('src/lib/updateOrchestrator.ts', 'utf8')
const lifecycle = fs.readFileSync('src/lib/allocatorEvDailyLifecycle.ts', 'utf8')
const recommendationRoute = fs.readFileSync('src/routes/other.ts', 'utf8')
const adminRoutes = fs.readFileSync('src/routes/adminControlRoutes.ts', 'utf8')
const paperEntryTasks = fs.readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const researchRunner = fs.readFileSync('src/node-runner/s12StructureBatchJobMain.ts', 'utf8')
const controllerMain = fs.readFileSync('../ml-controller/main.py', 'utf8')
const controllerRouter = fs.readFileSync('../ml-controller/routers/s12_structure.py', 'utf8')
const wrangler = fs.readFileSync('wrangler.toml', 'utf8')

assert(orchestrator.includes("if (msg.type === 's12_intraday_setup_watch_complete')"), 'old setup-watch callbacks must stay drainable')
assert(orchestrator.includes("if (msg.type === 's12_structure_batch_complete')"), 'old structure callbacks must stay drainable')
assert(orchestrator.includes('drained without serving side effects'), 'old setup-watch callbacks must not resume serving')
assert(orchestrator.includes('drained without pipeline continuation'), 'old structure callbacks must not resume the pipeline')
assert(!lifecycle.includes('recoverCompletedS12DurableCallback'), 'watchdog must not revive retired S12 callbacks')
assert(!recommendationRoute.includes('s12_formal_ev_decisions'), 'daily recommendations must not read formal S12 EV decisions')
assert(!recommendationRoute.includes('intraday_s12_formal_ev'), 'daily recommendations must not expose the retired S12 formal signal')
assert(!controllerMain.includes('s12_formal_ev'), 'ml-controller must not mount the retired formal-EV route')
assert(!wrangler.includes('S12_DURABLE_STRUCTURE_JOB_ENABLED'), 'production Worker must not enable retired durable S12 serving')

for (const [binding, envName] of [
  ['CORE_DB', 'CF_D1_CORE_DB_ID'],
  ['MARKET_DB', 'CF_D1_MARKET_DB_ID'],
  ['LEARNING_DB', 'CF_D1_LEARNING_DB_ID'],
  ['OPS_DB', 'CF_D1_OPS_DB_ID'],
  ['EXECUTION_DB', 'CF_D1_EXECUTION_DB_ID'],
  ['PAPER_DB', 'CF_D1_PAPER_DB_ID'],
  ['RESEARCH_DB', 'CF_D1_RESEARCH_DB_ID'],
] as const) {
  assert(
    researchRunner.includes(`${binding}: RestD1Database.fromEnv('${envName}')`),
    `S12 research runner must bind active ${binding} through ${envName}`,
  )
}
assert(researchRunner.includes("MULTI_D1_ACTIVE_DOMAINS: env.MULTI_D1_ACTIVE_DOMAINS ?? 'learning'"), 'S12 research runner must route active D1 domains')
assert(researchRunner.includes("MULTI_D1_STRICT: env.MULTI_D1_STRICT ?? 'true'"), 'S12 research runner must fail closed when active bindings are absent')

assert(researchRunner.includes('runS12ResearchStructureSnapshots'), 'remaining S12 batch job must use the research producer')
assert(researchRunner.includes("type S12StructureRunSource = 'historical_shadow' | 'manual_repair'"), 'remaining S12 batch job must allow research sources only')
assert(researchRunner.includes('invalid_s12_structure_run_source'), 'remaining S12 batch job must fail closed on retired sources')
assert(controllerRouter.includes('Literal["historical_shadow", "manual_repair"]'), 'controller must reject serving sources before dispatch')
assert(adminRoutes.includes('research-only'), 'manual callback endpoint must identify historical/manual work as research-only')
assert(adminRoutes.includes('retired S12 serving callback drained without pipeline continuation'), 'manual callback endpoint must drain retired serving callbacks')

assert(paperEntryTasks.includes('loadS12IntradayBaseBars'), 'Pending Buy and holding execution must retain realtime SMCVWAP bars')
assert(paperEntryTasks.includes('assessS12IntradayStructureFromBaseBars'), 'Pending Buy and holding execution must retain realtime SMCVWAP assessment')
assert(paperEntryTasks.includes('persistS12StructureSnapshot'), 'realtime execution decisions must retain audit evidence')

const retiredServingImports = [
  's12DurableStructureBatch',
  's12FormalEvTrigger',
  's12IntradaySession',
]
for (const retiredImport of retiredServingImports) {
  assert(!orchestrator.includes(retiredImport), `orchestrator must not import retired serving module ${retiredImport}`)
  assert(!lifecycle.includes(retiredImport), `watchdog must not import retired serving module ${retiredImport}`)
}
