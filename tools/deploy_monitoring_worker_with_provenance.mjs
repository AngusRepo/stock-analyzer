// Production deploy of the read-only monitoring Worker (worker/wrangler.monitoring.toml), same guards as
// deploy_worker_with_provenance.mjs: canonical main HEAD, clean inputs, the deploy tag is the source SHA.
//   node tools/deploy_monitoring_worker_with_provenance.mjs          deploy (no-op when HEAD is already live)
//   node tools/deploy_monitoring_worker_with_provenance.mjs --live   print the live version's source SHA ('' if none)
// The live SHA is read through the Cloudflare API (deployment → version annotations), because every HTTP
// route of the Worker sits behind Cloudflare Access; CLOUDFLARE_API_TOKEN is required for both modes.
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = join(root, 'worker')
const config = 'wrangler.monitoring.toml'
const workerName = 'stockvision-monitoring'
const wranglerCli = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const REQUIRED_SECRETS = ['ACCESS_TEAM_DOMAIN', 'ACCESS_AUD', 'MONITORING_READ_TOKEN']
const SHA = /^[0-9a-f]{40}$/

function run(command, args, options = {}) {
  const environment = { ...process.env }
  delete environment.STOCKVISION_D1_API_TOKEN
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root, encoding: 'utf8', shell: false,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: environment,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    if (options.allowFailure) return null
    const detail = options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : ''
    throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return options.capture ? String(result.stdout).trim() : ''
}

const wrangler = (args, options = {}) => run(process.execPath, [wranglerCli, ...args], { cwd: workerDir, ...options })

/** Source SHA tagged on the version serving 100 % of traffic; '' when there is none (first deploy, split rollout). */
function liveSourceSha() {
  const status = wrangler(['deployments', 'status', '--name', workerName, '--json'], { capture: true, allowFailure: true })
  if (!status) return ''
  const versions = JSON.parse(status)?.versions ?? []
  const full = versions.find((version) => Number(version.percentage) === 100)
  if (!full?.version_id) return ''
  const version = JSON.parse(wrangler(['versions', 'view', full.version_id, '--name', workerName, '--json'], { capture: true }))
  const tag = String(version?.annotations?.['workers/tag'] ?? '')
  return SHA.test(tag) ? tag : ''
}

if (!existsSync(wranglerCli)) throw new Error('locked Worker Wrangler is missing; run npm ci in worker')
if (!process.env.CLOUDFLARE_API_TOKEN) throw new Error('CLOUDFLARE_API_TOKEN is required')

if (process.argv.includes('--live')) {
  process.stdout.write(`${liveSourceSha()}\n`)
  process.exit(0)
}

const productionBranch = String(process.env.PRODUCTION_BRANCH ?? '').trim()
if (!productionBranch) throw new Error('PRODUCTION_BRANCH is required')
const sourceSha = run('git', ['rev-parse', 'HEAD'], { capture: true })
const sourceBranch = run('git', ['branch', '--show-current'], { capture: true })
if (sourceBranch !== productionBranch) {
  throw new Error(`source branch ${sourceBranch || '<detached>'} does not match PRODUCTION_BRANCH=${productionBranch}`)
}
const canonical = String(process.env.CANONICAL_PRODUCTION_BRANCH ?? 'main').trim()
if (productionBranch !== canonical) throw new Error(`the monitoring Worker deploys from ${canonical} only`)
const canonicalSha = run('git', ['rev-parse', `refs/remotes/origin/${canonical}`], { capture: true })
if (sourceSha !== canonicalSha) throw new Error(`deploy requires HEAD=origin/${canonical} (${canonicalSha}), got ${sourceSha}`)

const dirty = run('git', ['status', '--porcelain', '--untracked-files=all', '--',
  'worker/src', `worker/${config}`, 'worker/package.json', 'worker/package-lock.json', 'worker/tsconfig.json',
  'tools/deploy_monitoring_worker_with_provenance.mjs'], { capture: true })
if (dirty) throw new Error(`monitoring Worker deployment inputs are dirty:\n${dirty}`)

// A re-run must not mint a new version for a commit that is already live.
const live = liveSourceSha()
if (live === sourceSha) {
  console.log(`${workerName} already live at ${live}`)
  process.exit(0)
}

// Fail closed before the first request: the auth secrets must exist (values are never read back).
const secrets = wrangler(['secret', 'list', '--config', config, '--format', 'json'], { capture: true, allowFailure: true })
if (secrets != null) {
  const names = new Set((JSON.parse(secrets) ?? []).map((secret) => secret.name))
  const missing = REQUIRED_SECRETS.filter((name) => !names.has(name))
  if (missing.length) throw new Error(`${workerName} secrets missing: ${missing.join(', ')}`)
} else if (live) {
  throw new Error(`${workerName} secret list unreadable`)
}

// The chain endpoints read P2's tables: the schema must be applied first (no CD unit applies migrations).
wrangler(['d1', 'execute', 'stockvision-ops-db', '--remote', '--command',
  'SELECT business_date,chain_id,stage_id,status,expected_by,heartbeat_at FROM ops_chain_stage_state_v1 LIMIT 0; '
  + 'SELECT business_date,chain_id,stage_id,transition_at,to_status FROM ops_chain_stage_transitions_v1 LIMIT 0;'])

wrangler(['deploy', '--config', config, '--strict', '--tag', sourceSha, '--message', `source=${sourceSha}`])
