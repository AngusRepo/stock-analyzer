const fs = require('fs')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const script = fs.readFileSync('../scripts/p9_gate.ps1', 'utf8')

assert(script.includes('[switch]$LiveSmoke'), 'P9 gate should expose a LiveSmoke switch')
assert(script.includes('$ApiBase'), 'P9 gate should accept an API base URL')
assert(script.includes('/api/health'), 'P9 gate live smoke should call worker health')
assert(script.includes('/api/admin/gate/predeploy'), 'P9 gate live smoke should call admin predeploy gate')
assert(script.includes('Authorization'), 'P9 gate live smoke should send service-token authorization')
assert(script.includes('[P9 gate] ml-controller contract tests'), 'P9 gate should run ml-controller contract tests')
assert(script.includes('test_verify_pipeline_graph.py'), 'P9 gate should protect verify dry-run contract')
