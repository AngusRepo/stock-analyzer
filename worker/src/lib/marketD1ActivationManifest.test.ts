import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')
const registry = fs.readFileSync('src/lib/dataDomainRegistry.ts', 'utf8')
const stocksRoute = fs.readFileSync('src/routes/stocks.ts', 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,ops,core,market,execution,paper,research"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,ops,core,market,execution,paper,research}"'))
assert(deploy.includes('MULTI_D1_MARKET_ROUTING_CONTRACT="${MULTI_D1_MARKET_ROUTING_CONTRACT:-market-single-writer-epoch-v1}"'))
assert(deploy.includes('MULTI_D1_MARKET_CUTOVER_RECEIPT_ID="${MULTI_D1_MARKET_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:market:9b026110-adf6-492b-ac15-e65a4843ef69}"'))
assert(deploy.includes('MULTI_D1_MARKET_WRITER_EPOCH="${MULTI_D1_MARKET_WRITER_EPOCH:-1}"'))
assert(deploy.includes('MULTI_D1_MARKET_ROUTING_CONTRACT=${MULTI_D1_MARKET_ROUTING_CONTRACT}'))
assert(deploy.includes('MULTI_D1_MARKET_CUTOVER_RECEIPT_ID=${MULTI_D1_MARKET_CUTOVER_RECEIPT_ID}'))
assert(deploy.includes('MULTI_D1_MARKET_WRITER_EPOCH=${MULTI_D1_MARKET_WRITER_EPOCH}'))

assert(!registry.match(/domain: 'market'.*route_ready: false/), 'all Market tables must route to their formal D1 owner')
assert(!stocksRoute.includes('computeAndStoreIndicators(c.env.DB'), 'on-demand indicators must write Market D1')
assert(!stocksRoute.includes('fetchAndStoreStockData(c.env.DB'), 'manual stock refresh must write Market D1')
assert(!stocksRoute.includes('c.env.DB.prepare'), 'stocks route must not inspect or read Market tables through Legacy D1')

console.log('market D1 activation manifest contract passed')
