import assert from 'node:assert/strict'
import fs from 'node:fs'

const router = fs.readFileSync('../ml-controller/routers/s12_structure.py', 'utf8')
const runner = fs.readFileSync('src/node-runner/s12StructureBatchJobMain.ts', 'utf8')
const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')

assert(router.includes('"intraday_watch"'))
assert(router.includes('"S12_STRUCTURE_SYMBOLS_JSON"'))
assert(runner.includes("source === 'intraday_watch'"))
assert(runner.includes("runS12IntradaySetupWatchBatch"))
assert(runner.includes("S12_INTRADAY_WATCH_CONCURRENCY || 4"))
assert(deploy.includes('SHIOAJI_PROXY_URL='))
assert(deploy.includes('RUNTIME_ENV_VARS='))
assert(deploy.includes('SHIOAJI_PROXY_URL'))

console.log('s12 intraday durable job contract tests passed')
