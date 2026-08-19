import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,ops,core,execution,paper,research"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,ops,core,execution,paper,research}"'))
assert(deploy.includes('MULTI_D1_CORE_ROUTING_CONTRACT="${MULTI_D1_CORE_ROUTING_CONTRACT:-core-single-writer-epoch-v1}"'))
assert(deploy.includes('MULTI_D1_CORE_CUTOVER_RECEIPT_ID="${MULTI_D1_CORE_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:core:df3c14b3-e1d4-46cf-bd8f-d9d5dbf8f594}"'))
assert(deploy.includes('MULTI_D1_CORE_WRITER_EPOCH="${MULTI_D1_CORE_WRITER_EPOCH:-1}"'))
assert(deploy.includes('MULTI_D1_CORE_ROUTING_CONTRACT=${MULTI_D1_CORE_ROUTING_CONTRACT}'))
assert(deploy.includes('MULTI_D1_CORE_CUTOVER_RECEIPT_ID=${MULTI_D1_CORE_CUTOVER_RECEIPT_ID}'))
assert(deploy.includes('MULTI_D1_CORE_WRITER_EPOCH=${MULTI_D1_CORE_WRITER_EPOCH}'))

console.log('core D1 activation manifest contract passed')
