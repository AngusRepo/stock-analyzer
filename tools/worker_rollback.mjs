// Worker rollback with the scheduler check built in (CD-NEW-24).
//
// `wrangler rollback` restores the target version's [vars] together with its code (vars have no
// keep_vars), so a scheduler job that reads a var the rollback changes (e.g. active8-oof-monthly
// and R33_MONTHLY_PROFILE) must be paused first. This tool reads both versions' plain-text vars,
// lists what the rollback would change, and refuses unless every job named with --require-paused
// is PAUSED in Cloud Scheduler. A rollback that changes vars needs at least one such job, or an
// explicit --no-scheduler-reads-these-vars after review.
//
//   node tools/worker_rollback.mjs --version-id <uuid> [--require-paused <job>]...
//        [--no-scheduler-reads-these-vars] [--execute]
//
// Without --execute it only reads (wrangler versions view, gcloud scheduler jobs describe, the
// Worker /api/health). It never pauses or resumes a job: pause before, resume after, each with go.
//
// Secrets are not in the var diff (versions view shows names, not values). When a secret changed
// since the target version (e.g. a rotated STOCKVISION_AUTH_TOKEN), wrangler asks before rolling it
// back too, and in a non-interactive shell it answers yes by itself. So --execute runs wrangler on
// the operator's terminal without --yes: both prompts are answered by a person, and a changed
// secret should normally be answered no.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCTION_WORKER_HEALTH_URL } from './worker_deploy_preflight.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const JOB = /^[a-z][a-z0-9-]{0,62}$/

export function parseArgs(argv) {
  const options = { versionId: '', requirePaused: [], noSchedulerReads: false, execute: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--version-id') options.versionId = (argv[++i] ?? '').toLowerCase()
    else if (arg === '--require-paused') options.requirePaused.push(argv[++i] ?? '')
    else if (arg === '--no-scheduler-reads-these-vars') options.noSchedulerReads = true
    else if (arg === '--execute') options.execute = true
    else throw new Error(`unknown argument ${arg}`)
  }
  if (!UUID.test(options.versionId)) throw new Error('--version-id <Worker version uuid> is required')
  const bad = options.requirePaused.filter(job => !JOB.test(job))
  if (bad.length) throw new Error(`invalid --require-paused job id: ${bad.join(',')}`)
  if (options.noSchedulerReads && options.requirePaused.length) {
    throw new Error('--no-scheduler-reads-these-vars contradicts --require-paused')
  }
  return options
}

export function plainVars(version) {
  const bindings = version?.resources?.bindings
  if (!Array.isArray(bindings)) throw new Error('worker_version_bindings_unreadable')
  // [vars] become plain_text bindings, or json ones for non-string values
  return Object.fromEntries(bindings.filter(b => b.type === 'plain_text' || b.type === 'json')
    .map(b => [b.name, b.type === 'json' ? JSON.stringify(b.json) : b.text]))
}

export function varChanges(live, target) {
  const names = [...new Set([...Object.keys(live), ...Object.keys(target)])].sort()
  return names.filter(name => live[name] !== target[name])
    .map(name => ({ name, live: live[name] ?? null, after_rollback: target[name] ?? null }))
}

// Returns the plan; throws (before any write) when the scheduler is not ready for it.
export function planRollback({ options, liveVersionId, liveVersion, targetVersion, jobState }) {
  if (liveVersionId === options.versionId) throw new Error('target version is already live')
  const changes = varChanges(plainVars(liveVersion), plainVars(targetVersion))
  if (changes.length && !options.requirePaused.length && !options.noSchedulerReads) {
    throw new Error('rollback changes Worker vars ' + changes.map(c => c.name).join(',')
      + '; pause every scheduler job that reads them and name it with --require-paused '
      + '(or pass --no-scheduler-reads-these-vars after review)')
  }
  const notPaused = options.requirePaused.filter(job => jobState(job) !== 'PAUSED')
  if (notPaused.length) {
    throw new Error('pause before rollback (then resume after, each with go): '
      + notPaused.map(job => `gcloud scheduler jobs pause ${job} --location=asia-east1`).join(' ; '))
  }
  return { from: liveVersionId, to: options.versionId, var_changes: changes, paused_jobs: options.requirePaused }
}

// wrangler auto-confirms every prompt, the changed-secrets one included, unless stdin AND stdout
// are TTYs and its bundled ci-info sees no CI (e.g. `... --execute | tee log` is non-interactive to
// wrangler). ci-info reads dozens of vendor variables (TF_BUILD, GITLAB_CI, NODE for Heroku, ...),
// so instead of mirroring that list, wrangler runs with only the variables it needs: no CI variable
// reaches it, and the TTY check below is then the whole condition.
const CHILD_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|LANG|LC_[A-Z]+|TMPDIR|TZ|XDG_[A-Z_]+|SystemRoot|WINDIR|APPDATA|LOCALAPPDATA|USERPROFILE|(HTTPS?|NO|ALL)_PROXY|(https?|no|all)_proxy|NODE_EXTRA_CA_CERTS|CLOUDFLARE_[A-Z_]+|WRANGLER_[A-Z_]+)$/
const CI_ENV = ['CI', 'CONTINUOUS_INTEGRATION', 'BUILD_ID', 'BUILD_NUMBER', 'RUN_ID', 'CI_NAME',
  'CI_APP_ID', 'CI_BUILD_ID', 'CI_BUILD_NUMBER']

export function wranglerEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => CHILD_ENV.test(name)))
}

export function requireInteractive({ stdinIsTTY, stdoutIsTTY, env }) {
  const ci = CI_ENV.filter(name => env[name])
  if (!stdinIsTTY || !stdoutIsTTY || ci.length) {
    throw new Error('--execute needs an interactive terminal with stdin and stdout not redirected and no CI variables'
      + (ci.length ? ` (set: ${ci.join(',')})` : '') + ': wrangler would roll back changed secrets without asking')
  }
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const workerDir = join(root, 'worker')
  const wrangler = join(workerDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
  const run = (command, args) => {
    const result = spawnSync(command, args, { cwd: workerDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(' ')} exited ${result.status}: ${result.stderr.trim().slice(-400)}`)
    return result.stdout
  }
  const options = parseArgs(process.argv.slice(2))
  const response = await fetch(PRODUCTION_WORKER_HEALTH_URL, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error('production Worker health unavailable')
  const liveVersionId = String((await response.json())?.provenance?.versionId ?? '').toLowerCase()
  if (!UUID.test(liveVersionId ?? '')) throw new Error('live Worker version is not attested')
  const view = id => JSON.parse(run(process.execPath, [wrangler, 'versions', 'view', id, '--json']))
  const gcloud = process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud'
  const jobState = job => JSON.parse(run(gcloud, ['scheduler', 'jobs', 'describe', job, '--location=asia-east1', '--project=gen-lang-client-0602998820', '--format=json'])).state
  const plan = planRollback({ options, liveVersionId, liveVersion: view(liveVersionId), targetVersion: view(options.versionId), jobState })
  console.log(JSON.stringify({ ...plan, mode: options.execute ? 'execute' : 'dry_run' }, null, 2))
  if (!options.execute) return
  requireInteractive({ stdinIsTTY: process.stdin.isTTY, stdoutIsTTY: process.stdout.isTTY, env: process.env })
  console.error('wrangler asks next. If it lists secrets that changed since this version, answer n '
    + '(its default is yes): rolling them back would restore old values such as a rotated token.')
  const rollback = spawnSync(process.execPath, [wrangler, 'rollback', options.versionId, '--message', `rollback from ${liveVersionId}`],
    { cwd: workerDir, stdio: 'inherit', env: wranglerEnv(process.env) })
  if (rollback.error) throw rollback.error
  if (rollback.status !== 0) throw new Error(`wrangler rollback exited ${rollback.status}; check what is served and keep the jobs paused`)
  // a deployment takes a moment to serve; read back up to 6 times, 5 s apart
  let servedVersionId = null
  for (let attempt = 0; attempt < 6 && servedVersionId !== options.versionId; attempt += 1) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 5_000))
    const after = await fetch(PRODUCTION_WORKER_HEALTH_URL, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
      .catch(() => null)
    const body = after?.ok ? await after.json().catch(() => null) : null
    servedVersionId = body ? String(body?.provenance?.versionId ?? '').toLowerCase() : null
  }
  if (servedVersionId !== options.versionId) {
    throw new Error(`readback: /api/health serves ${servedVersionId || 'nothing'}, not ${options.versionId} `
      + '(also the result when the rollback was declined at a wrangler prompt); keep the jobs paused')
  }
  console.log(`rolled back to ${options.versionId} (readback ok); resume ${plan.paused_jobs.join(', ') || 'no job'} only with go`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1) })
}
