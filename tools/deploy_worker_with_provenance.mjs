import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workerDir = join(root, 'worker')
const manifestPath = join(root, 'infra', 'gcp-scheduler-jobs.json')
const wranglerCli = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    shell: options.shell ?? false,
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : ''
    throw new Error(`${command} exited ${result.status}${detail ? `: ${detail}` : ''}`)
  }
  return options.capture ? String(result.stdout).trim() : ''
}

const productionBranch = String(process.env.PRODUCTION_BRANCH ?? '').trim()
if (!productionBranch) throw new Error('PRODUCTION_BRANCH is required')

const sourceSha = run('git', ['rev-parse', 'HEAD'], { capture: true })
const sourceBranch = run('git', ['branch', '--show-current'], { capture: true })
if (!sourceBranch || sourceBranch !== productionBranch) {
  throw new Error(`source branch ${sourceBranch || '<detached>'} does not match PRODUCTION_BRANCH=${productionBranch}`)
}

const canonicalProductionBranch = String(process.env.CANONICAL_PRODUCTION_BRANCH ?? 'main').trim()
const allowNonMainProductionDeploy = process.env.ALLOW_NON_MAIN_PRODUCTION_DEPLOY === '1'
const canonicalRemoteRef = `refs/remotes/origin/${canonicalProductionBranch}`
const canonicalSourceSha = run('git', ['rev-parse', canonicalRemoteRef], { capture: true })
if (productionBranch === canonicalProductionBranch) {
  if (sourceSha !== canonicalSourceSha) {
    throw new Error(`canonical production deploy requires HEAD=${canonicalRemoteRef} (${canonicalSourceSha}), got ${sourceSha}`)
  }
} else {
  if (!allowNonMainProductionDeploy) {
    throw new Error(`non-canonical production branch ${productionBranch} is blocked; merge to ${canonicalProductionBranch} first`)
  }
  run('git', ['merge-base', '--is-ancestor', canonicalRemoteRef, sourceSha])
}

const dirty = run('git', ['status', '--porcelain', '--untracked-files=all', '--', 'worker', 'infra/gcp-scheduler-jobs.json', 'tools/deploy_worker_with_provenance.mjs'], { capture: true })
if (dirty) throw new Error(`Worker deployment inputs are dirty:\n${dirty}`)
if (!existsSync(manifestPath)) throw new Error(`missing scheduler manifest: ${manifestPath}`)
if (!existsSync(wranglerCli)) throw new Error('locked Worker Wrangler is missing; run npm ci in worker')

const schedulerSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex')

// Code admission depends on the domain-native ticket authority. Remote D1
// migrations remain explicit, so deploy must fail closed until Ops 0011 has
// already been applied and read back.
run(process.execPath, [
  wranglerCli,
  'd1',
  'execute',
  'stockvision-ops-db',
  '--remote',
  '--command',
  'SELECT ticket_id FROM scheduler_execution_tickets_v1 LIMIT 0;',
], { cwd: workerDir })
run(process.execPath, [
  wranglerCli, 'deploy', '--strict',
  '--tag', sourceSha,
  '--message', `source=${sourceSha},scheduler=${schedulerSha256}`,
], { cwd: workerDir })
