import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,ops,core,market,execution,paper,research"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,ops,core,market,execution,paper,research}"'))
assert(deploy.includes('MULTI_D1_MARKET_ROUTING_CONTRACT="${MULTI_D1_MARKET_ROUTING_CONTRACT:-market-single-writer-epoch-v1}"'))
assert(deploy.includes('MULTI_D1_MARKET_CUTOVER_RECEIPT_ID="${MULTI_D1_MARKET_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:market:9b026110-adf6-492b-ac15-e65a4843ef69}"'))
assert(deploy.includes('MULTI_D1_MARKET_WRITER_EPOCH="${MULTI_D1_MARKET_WRITER_EPOCH:-1}"'))
assert(deploy.includes('MULTI_D1_MARKET_ROUTING_CONTRACT=${MULTI_D1_MARKET_ROUTING_CONTRACT}'))
assert(deploy.includes('MULTI_D1_MARKET_CUTOVER_RECEIPT_ID=${MULTI_D1_MARKET_CUTOVER_RECEIPT_ID}'))
assert(deploy.includes('MULTI_D1_MARKET_WRITER_EPOCH=${MULTI_D1_MARKET_WRITER_EPOCH}'))

console.log('market D1 activation manifest contract passed')