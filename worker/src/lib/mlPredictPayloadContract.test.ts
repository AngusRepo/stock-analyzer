import fs from 'node:fs'
import assert from 'node:assert/strict'

const source = fs.readFileSync('src/routes/other.ts', 'utf8')

const routeStart = source.indexOf("ml.post('/predict/:stockId'")
assert(routeStart >= 0, 'manual ML predict route must exist')
const routeEnd = source.indexOf("ml.get('/predict/:stockId'", routeStart)
const routeBody = source.slice(routeStart, routeEnd >= 0 ? routeEnd : undefined)

assert(
  routeBody.includes('getTradingConfig(c.env.KV)') &&
    routeBody.includes('getAdaptiveParamsForRegime(c.env.KV)'),
  'manual ML predict proxy must load Worker trading_config and adaptive_params before calling ML service',
)

assert(
  routeBody.includes('trading_config:   tradingConfig') &&
    routeBody.includes('adaptive_params:  adaptiveParams'),
  'manual ML predict payload must pass source-of-truth config to ML v2 runtime',
)

console.log('mlPredictPayloadContract.test.ts passed')
