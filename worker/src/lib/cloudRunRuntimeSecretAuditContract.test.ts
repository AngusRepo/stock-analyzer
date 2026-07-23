const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const auditPath = path.join(root, 'scripts', 'audit_cloudrun_secret_bindings.ps1')
const gatePath = path.join(root, 'scripts', 'p9_gate.ps1')

assert(fs.existsSync(auditPath), 'Cloud Run runtime secret audit script must exist')

const audit = fs.readFileSync(auditPath, 'utf8')
const gate = fs.readFileSync(gatePath, 'utf8')

for (const envName of [
  'ANTHROPIC_API_KEY',
  'CF_API_TOKEN',
  'GEMINI_API_KEY',
  'GITHUB_TOKEN',
  'ML_CONTROLLER_SECRET',
  'ML_SERVICE_SECRET',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
  'STOCKVISION_AUTH_TOKEN',
]) {
  assert(audit.includes(envName), `runtime secret audit must cover ${envName}`)
}

for (const requiredCommand of [
  "'run', 'jobs', 'describe'",
  "'run', 'services', 'describe'",
  "'run', 'jobs', 'executions', 'list'",
]) {
  assert(audit.includes(requiredCommand), `runtime secret audit must include ${requiredCommand}`)
}

assert(audit.includes('plaintext_findings'), 'runtime secret audit must emit a sanitized finding count')
assert(!audit.includes('secretValue') && !audit.includes('currentValue'), 'runtime secret audit must not emit secret values')
assert(
  gate.includes('RuntimeSecretAudit') && gate.includes('audit_cloudrun_secret_bindings.ps1'),
  'P9 gate must expose the Cloud Run runtime secret audit',
)
