import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,ops,core,execution,paper,research"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,ops,core,execution,paper,research}"'))
assert(deploy.includes('MULTI_D1_OPS_ROUTING_CONTRACT="${MULTI_D1_OPS_ROUTING_CONTRACT:-ops-single-writer-epoch-v1}"'))
assert(deploy.includes('MULTI_D1_OPS_CUTOVER_RECEIPT_ID="${MULTI_D1_OPS_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:ops:c23aeba4-1788-4a19-9f98-b18fe2ff3890}"'))
assert(deploy.includes('MULTI_D1_OPS_WRITER_EPOCH="${MULTI_D1_OPS_WRITER_EPOCH:-227728}"'))
assert(deploy.includes('MULTI_D1_OPS_ROUTING_CONTRACT=${MULTI_D1_OPS_ROUTING_CONTRACT}'))
assert(deploy.includes('MULTI_D1_OPS_CUTOVER_RECEIPT_ID=${MULTI_D1_OPS_CUTOVER_RECEIPT_ID}'))
assert(deploy.includes('MULTI_D1_OPS_WRITER_EPOCH=${MULTI_D1_OPS_WRITER_EPOCH}'))

console.log('ops D1 activation manifest tests passed')