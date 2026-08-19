import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const deploy = readFileSync(new URL('../../../deploy_ml_controller.sh', import.meta.url), 'utf8')
const wrangler = readFileSync(new URL('../../wrangler.toml', import.meta.url), 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,execution,paper"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,execution,paper}"'))
assert(deploy.includes('MULTI_D1_PAPER_ROUTING_CONTRACT="${MULTI_D1_PAPER_ROUTING_CONTRACT:-paper-single-writer-epoch-v1}"'))
assert(deploy.includes('MULTI_D1_PAPER_CUTOVER_RECEIPT_ID="${MULTI_D1_PAPER_CUTOVER_RECEIPT_ID:-data-domain-cutover-probe:paper:fecbbe3d-b491-4c70-8aee-e45ce4dd5f26}"'))
assert(deploy.includes('MULTI_D1_PAPER_WRITER_EPOCH="${MULTI_D1_PAPER_WRITER_EPOCH:-6}"'))
assert(deploy.includes('MULTI_D1_PAPER_ROUTING_CONTRACT=${MULTI_D1_PAPER_ROUTING_CONTRACT}'))
assert(deploy.includes('MULTI_D1_PAPER_CUTOVER_RECEIPT_ID=${MULTI_D1_PAPER_CUTOVER_RECEIPT_ID}'))
assert(deploy.includes('MULTI_D1_PAPER_WRITER_EPOCH=${MULTI_D1_PAPER_WRITER_EPOCH}'))

console.log('paper D1 activation manifest contract passed')
