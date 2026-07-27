import assert from 'node:assert/strict'
import fs from 'node:fs'

const deploy = fs.readFileSync('../deploy_ml_controller.sh', 'utf8')

assert(deploy.includes('gcloud run jobs add-iam-policy-binding "$S12_STRUCTURE_JOB_NAME"'))
assert(deploy.includes('projects/${GCP_PROJECT_ID}/roles/stockvisionJobOverrideRunner'))
assert(deploy.includes('roles/run.invoker'))
assert(deploy.includes('roles/run.viewer'))
assert(deploy.includes('serviceAccount:${SERVICE_RUNTIME_SERVICE_ACCOUNT}'))
