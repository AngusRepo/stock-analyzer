import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const deploy = readFileSync(new URL('../../../deploy_ml_controller.sh', import.meta.url), 'utf8')

assert(deploy.includes('gcloud_runtime_env_vars()'))
assert(deploy.includes('__STOCKVISION_ACTIVE_DOMAIN_COMMA__'))
assert(deploy.includes("printf '^@^%s' \"$encoded\""))
assert(deploy.includes('GCLOUD_RUNTIME_ENV_VARS="$(gcloud_runtime_env_vars)"'))
assert.equal(
  deploy.match(/--update-env-vars="\$GCLOUD_RUNTIME_ENV_VARS"/g)?.length,
  2,
)
assert(!deploy.includes('--update-env-vars="$RUNTIME_ENV_VARS"'))

console.log('ML deploy active-domain delimiter contract passed')
