import assert from 'node:assert/strict'
import fs from 'node:fs'

const wrangler = fs.readFileSync('wrangler.toml', 'utf8')
const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')

assert(wrangler.includes('MULTI_D1_ACTIVE_DOMAINS = "learning,ops,execution,paper,research"'))
assert(deploy.includes('MULTI_D1_ACTIVE_DOMAINS="${MULTI_D1_ACTIVE_DOMAINS:-learning,ops,execution,paper,research}"'))

console.log('ops D1 activation manifest tests passed')