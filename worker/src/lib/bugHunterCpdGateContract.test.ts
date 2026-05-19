const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const gateScript = fs.readFileSync(path.join(root, 'scripts', 'p9_gate.ps1'), 'utf8')
const bugHunterGateScriptPath = path.join(root, 'scripts', 'bug_hunter_cpd_gate.ps1')
const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8')

assert(fs.existsSync(bugHunterGateScriptPath), 'Bug Hunter CPD gate script must exist')

const bugHunterGateScript = fs.readFileSync(bugHunterGateScriptPath, 'utf8')

assert(
  gateScript.includes('bug_hunter_cpd_gate.ps1'),
  'P9 gate must include the Bug Hunter CPD gate',
)

assert(
  bugHunterGateScript.includes('--scan-only'),
  'Bug Hunter CPD gate must document/enforce scan-only usage',
)

for (const forbidden of ['--fix', '--autonomous', '--approve', 'git commit', 'git checkout', 'git reset']) {
  assert(
    !bugHunterGateScript.includes(forbidden),
    `Bug Hunter CPD gate must not allow mutating behavior: ${forbidden}`,
  )
}

for (const target of [
  'worker/src/routes',
  'worker/src/lib',
  'ml-controller/routers',
  'ml-controller/services',
  'ml-service/app',
]) {
  assert(
    bugHunterGateScript.includes(target),
    `Bug Hunter CPD gate must cover ${target}`,
  )
}

assert(
  gitignore.split(/\r?\n/).includes('.bug-hunter/'),
  'Bug Hunter output directory must be ignored',
)
