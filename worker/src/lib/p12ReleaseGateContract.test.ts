const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const workerRoot = process.cwd()
const libDir = path.join(workerRoot, 'src', 'lib')
const gateScript = fs.readFileSync(path.join(workerRoot, '..', 'scripts', 'p9_gate.ps1'), 'utf8')
const workflow = fs.readFileSync(path.join(workerRoot, '..', '.github', 'workflows', 'p9-gate.yml'), 'utf8')

assert(
  gateScript.includes("Get-ChildItem -Path (Join-Path (Get-Location) 'src\\lib') -Filter '*.test.ts'"),
  'P12 release gate must discover worker tests dynamically instead of maintaining a stale manual list',
)

assert(
  gateScript.includes('foreach ($testSource in $WorkerTestSources)') &&
    gateScript.includes('npx tsx $testSource') &&
    gateScript.includes('if ($LASTEXITCODE -ne 0) { $FailedWorkerTests += $testSource }') &&
    gateScript.includes('throw "worker contract tests failed ($($FailedWorkerTests.Count)): $($FailedWorkerTests -join \', \')"') &&
    gateScript.includes('strategyDiscoveryLocalE2E.test.ts') &&
    gateScript.includes('strategyDiscoveryRealModelE2E.test.ts'),
  'P12 release gate must execute every offline worker test, explicitly separate runtime E2E, and fail naming every broken test instead of stopping at the first',
)

assert(
  gateScript.includes('git diff --check') || gateScript.includes('diff --check'),
  'P12 release gate must include whitespace/diff hygiene before deploy',
)

assert(
  fs.readdirSync(libDir).filter((name: string) => name.endsWith('.test.ts')).length >= 60,
  'P12 release gate contract should protect the current broad worker contract-test surface',
)

assert(workflow.includes('workflow_dispatch:'), 'P12 release gate workflow must support manual dispatch')
// ci.yml is the PR gate; this Windows re-run must not come back as an automatic check.
assert(
  /^on:\n  workflow_dispatch:\n\n/m.test(workflow.replace(/\r\n/g, '\n')),
  'P12 release gate workflow must be manual dispatch only',
)
