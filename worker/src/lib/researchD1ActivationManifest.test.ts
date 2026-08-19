import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,ops,core,execution,paper,research"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,ops,core,execution,paper,research}"'))
assert(deploy.includes('MULTI_D1_RESEARCH_ROUTING_CONTRACT="${MULTI_D1_RESEARCH_ROUTING_CONTRACT:-research-single-writer-epoch-v1}"'))
assert(deploy.includes('MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID="${MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:research:5f34d52d-c437-41e1-9c67-c4a97f30a281}"'))
assert(deploy.includes('MULTI_D1_RESEARCH_WRITER_EPOCH="${MULTI_D1_RESEARCH_WRITER_EPOCH:-2}"'))
assert(deploy.includes('MULTI_D1_RESEARCH_ROUTING_CONTRACT=${MULTI_D1_RESEARCH_ROUTING_CONTRACT}'))
assert(deploy.includes('MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID=${MULTI_D1_RESEARCH_CUTOVER_RECEIPT_ID}'))
assert(deploy.includes('MULTI_D1_RESEARCH_WRITER_EPOCH=${MULTI_D1_RESEARCH_WRITER_EPOCH}'))

console.log('research D1 activation manifest contract passed')
