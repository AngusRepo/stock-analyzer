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
    gateScript.includes('node $testJs') &&
    gateScript.includes('throw "$testName failed"'),
  'P12 release gate must execute every discovered worker test and fail on the exact broken test',
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
assert(workflow.includes('feature/**'), 'P12 release gate workflow must run on feature branch pushes')
