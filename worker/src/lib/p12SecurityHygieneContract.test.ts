const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const secretScanPath = path.join(root, 'scripts', 'p12_secret_scan.ps1')
const gateScript = fs.readFileSync(path.join(root, 'scripts', 'p9_gate.ps1'), 'utf8')
const osvResult = fs.readFileSync(path.join(root, 'OSV_REMEDIATION_RESULT.md'), 'utf8')

assert(fs.existsSync(secretScanPath), 'P12 secret scan script must exist')

const secretScan = fs.existsSync(secretScanPath) ? fs.readFileSync(secretScanPath, 'utf8') : ''

for (const pattern of ['sk-ant-api', 'github_pat_', 'cfut_', 'AIza', 'MODAL_TOKEN_SECRET']) {
  assert(secretScan.includes(pattern), `P12 secret scan must block ${pattern}`)
}

assert(!secretScan.includes("'<'") && !secretScan.includes("'>'"), 'P12 secret scan allowlist must not allow broad angle-bracket matches')

assert(
  gateScript.includes('p12_secret_scan.ps1'),
  'P12 secret scan must be part of the release gate',
)

assert(osvResult.includes('lodash') && osvResult.includes('transformers'), 'P12 OSV exceptions must stay explicitly documented')

function readGitIndex(rootDir: string): Buffer {
  const gitPath = path.join(rootDir, '.git')
  if (fs.statSync(gitPath).isDirectory()) {
    return fs.readFileSync(path.join(gitPath, 'index'))
  }
  const gitFile = fs.readFileSync(gitPath, 'utf8')
  const match = gitFile.match(/^gitdir:\s*(.+)$/m)
  assert(match, '.git file must point to a gitdir')
  const gitDir = path.resolve(rootDir, match[1].trim())
  return fs.readFileSync(path.join(gitDir, 'index'))
}

const gitIndex = readGitIndex(root)
const rawOsvReports = ['osv-report.json', 'osv-report-before.json', 'osv-report-after.json', 'osv-report-after.html']
const trackedOsvReports = rawOsvReports.filter((name) => gitIndex.includes(Buffer.from(name))).join('\n')

assert(!trackedOsvReports, `OSV raw reports must not be committed: ${trackedOsvReports}`)
