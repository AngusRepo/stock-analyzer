const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(!fs.existsSync('../deploy.sh'), 'legacy root deploy.sh should stay removed; use explicit P9 gate and deploy scripts')

const p9GatePath = '../scripts/p9_gate.ps1'
const smokePath = '../scripts/post_deploy_smoke.ps1'
assert(fs.existsSync(p9GatePath), 'P9 gate script should exist as the shared release gate')
assert(fs.existsSync(smokePath), 'post-deploy smoke script should exist as the explicit production verification entrypoint')

const p9Gate = fs.readFileSync(p9GatePath, 'utf8')
const smoke = fs.readFileSync(smokePath, 'utf8')
assert(p9Gate.includes('worker type-check'), 'P9 gate should run worker type-check')
assert(p9Gate.includes('worker contract tests'), 'P9 gate should run worker contract tests')
assert(p9Gate.includes('frontend build'), 'P9 gate should run frontend build unless explicitly skipped')
assert(smoke.includes('/api/health'), 'post-deploy smoke should verify Worker health')
assert(smoke.includes('/health'), 'post-deploy smoke should verify ml-controller health')

const workflowPath = '../.github/workflows/p9-gate.yml'
assert(fs.existsSync(workflowPath), 'P9 GitHub Actions workflow should exist')

const workflow = fs.readFileSync(workflowPath, 'utf8')
assert(workflow.includes('scripts/p9_gate.ps1'), 'P9 workflow should run the same gate script')
assert(workflow.includes('working-directory: worker'), 'P9 workflow should install worker dependencies')
assert(workflow.includes('working-directory: frontend'), 'P9 workflow should install frontend dependencies')
