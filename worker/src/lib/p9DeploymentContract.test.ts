const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const deployScript = fs.readFileSync('../deploy.sh', 'utf8')

assert(deployScript.includes('p9_gate.ps1'), 'deploy.sh should run the P9 gate before production deploy')
assert(deployScript.includes('P9_SKIP_GATE'), 'deploy.sh should expose an explicit emergency bypass flag')
assert(deployScript.includes('scripts/p9_gate.ps1'), 'deploy.sh should call the shared P9 gate script')

const workflowPath = '../.github/workflows/p9-gate.yml'
assert(fs.existsSync(workflowPath), 'P9 GitHub Actions workflow should exist')

const workflow = fs.readFileSync(workflowPath, 'utf8')
assert(workflow.includes('scripts/p9_gate.ps1'), 'P9 workflow should run the same gate script')
assert(workflow.includes('working-directory: worker'), 'P9 workflow should install worker dependencies')
assert(workflow.includes('working-directory: frontend'), 'P9 workflow should install frontend dependencies')
