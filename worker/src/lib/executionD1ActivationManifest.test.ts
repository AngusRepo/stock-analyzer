import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const deploy = readFileSync(new URL('../../../deploy_ml_controller.sh', import.meta.url), 'utf8')
const wrangler = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,execution"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,execution}"'))
assert(deploy.includes('CF_D1_EXECUTION_DB_ID=${CF_D1_EXECUTION_DB_ID}'))
assert(deploy.includes('CF_D1_PAPER_DB_ID=${CF_D1_PAPER_DB_ID}'))
assert(deploy.includes('CF_D1_RESEARCH_DB_ID=${CF_D1_RESEARCH_DB_ID}'))
assert(deploy.includes('MULTI_D1_EXECUTION_ROUTING_CONTRACT=${MULTI_D1_EXECUTION_ROUTING_CONTRACT}'))
assert(deploy.includes('MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID=${MULTI_D1_EXECUTION_CUTOVER_RECEIPT_ID}'))
assert(deploy.includes('MULTI_D1_EXECUTION_WRITER_EPOCH=${MULTI_D1_EXECUTION_WRITER_EPOCH}'))

console.log('execution D1 activation manifest contract passed')
