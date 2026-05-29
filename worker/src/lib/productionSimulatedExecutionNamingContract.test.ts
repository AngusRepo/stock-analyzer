import { existsSync, readFileSync } from 'node:fs'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const paperEntryTasks = readFileSync('src/lib/paperEntryTasks.ts', 'utf8')
const paperExecutionEvents = readFileSync('src/lib/paperExecutionEvents.ts', 'utf8')
const finlabMarketDataPath = 'src/lib/finlabL5MarketData.ts'
const finlabMarketData = existsSync(finlabMarketDataPath) ? readFileSync(finlabMarketDataPath, 'utf8') : ''
const controllerRoutes = readFileSync('../ml-controller/routers/finlab.py', 'utf8')

assert(existsSync(finlabMarketDataPath), 'live Worker L5 code should live in finlabL5MarketData.ts')
assert(!paperEntryTasks.includes('finlabExecutionShadow'), 'live intraday path should not import the legacy shadow client')
assert(!paperEntryTasks.includes('FINLAB_L5_SHADOW_ENABLED'), 'live intraday path should not use the legacy L5 shadow flag')
assert(!paperEntryTasks.includes('finlab_l5_shadow'), 'live intraday path should not emit legacy L5 shadow events')
assert(!paperEntryTasks.includes("'intraday_technical_snapshot'"), 'active technical gate should emit intraday_technical_decision, not snapshot events')
assert(paperExecutionEvents.includes("'intraday_technical_decision'"), 'event contract should expose intraday technical decision events')
assert(!finlabMarketData.includes('/finlab/execution/l5-shadow'), 'live L5 client should only call market-data route')
assert(!controllerRoutes.includes('@router.post("/execution/l5-shadow")'), 'controller should not expose L5 shadow route in pre-pilot live loop')
assert(!controllerRoutes.includes('@router.post("/execution/shadow-loop")'), 'controller should not expose shadow-loop route in pre-pilot live loop')
