import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseArgs, planRollback, plainVars, requireInteractive, varChanges, wranglerEnv } from '../../../tools/worker_rollback.mjs'

// CD-NEW-24: wrangler rollback also restores the target's [vars]; pause the jobs that read them first.
const live = 'aaaaaaaa-1111-4222-8333-444444444444'
const target = 'bbbbbbbb-1111-4222-8333-444444444444'
const version = (vars: Record<string, string>) => ({
  resources: { bindings: [{ type: 'secret_text', name: 'TOKEN' }, ...Object.entries(vars).map(([name, text]) => ({ type: 'plain_text', name, text }))] },
})
const withProfile = version({ ENVIRONMENT: 'production', R33_MONTHLY_PROFILE: '1' })
const withoutProfile = version({ ENVIRONMENT: 'production' })

test('rollback var changes compare plain-text vars only', () => {
  assert.deepEqual(plainVars(withProfile), { ENVIRONMENT: 'production', R33_MONTHLY_PROFILE: '1' })
  assert.deepEqual(varChanges(plainVars(withProfile), plainVars(withoutProfile)),
    [{ name: 'R33_MONTHLY_PROFILE', live: '1', after_rollback: null }])
  assert.throws(() => plainVars({}), /bindings_unreadable/)
})

test('a rollback that changes vars is refused until the named jobs are paused', () => {
  const base = { liveVersionId: live, liveVersion: withProfile, targetVersion: withoutProfile }
  assert.throws(() => planRollback({ ...base, options: parseArgs(['--version-id', target]), jobState: () => 'PAUSED' }),
    /changes Worker vars R33_MONTHLY_PROFILE/)
  const named = parseArgs(['--version-id', target, '--require-paused', 'active8-oof-monthly'])
  assert.throws(() => planRollback({ ...base, options: named, jobState: () => 'ENABLED' }),
    /gcloud scheduler jobs pause active8-oof-monthly --location=asia-east1/)
  const asked: string[] = []
  const plan = planRollback({ ...base, options: named, jobState: (job: string) => { asked.push(job); return 'PAUSED' } })
  assert.deepEqual(asked, ['active8-oof-monthly'])
  assert.deepEqual(plan.paused_jobs, ['active8-oof-monthly'])
  assert.equal(plan.var_changes.length, 1)
  const reviewed = parseArgs(['--version-id', target, '--no-scheduler-reads-these-vars'])
  assert.equal(planRollback({ ...base, options: reviewed, jobState: () => assert.fail('no job to read') }).to, target)
})

test('same vars need no pause; the live version and bad arguments are refused', () => {
  const same = { liveVersionId: live, liveVersion: withoutProfile, targetVersion: withoutProfile, jobState: () => assert.fail('no job') }
  assert.deepEqual(planRollback({ ...same, options: parseArgs(['--version-id', target]) }).var_changes, [])
  assert.throws(() => planRollback({ ...same, liveVersionId: target, options: parseArgs(['--version-id', target]) }), /already live/)
  assert.throws(() => parseArgs([]), /--version-id/)
  assert.throws(() => parseArgs(['--version-id', target, '--require-paused', 'Bad Job']), /invalid --require-paused/)
  assert.throws(() => parseArgs(['--version-id', target, '--require-paused', 'x', '--no-scheduler-reads-these-vars']), /contradicts/)
  assert.throws(() => parseArgs(['--version-id', target, '--force']), /unknown argument/)
  assert.equal(parseArgs(['--version-id', target]).execute, false)
})

test('json vars count, and --execute refuses a shell where wrangler would auto-confirm changed secrets', () => {
  const jsonVar = { resources: { bindings: [{ type: 'json', name: 'LIMITS', json: { max: 2 } }] } }
  assert.deepEqual(plainVars(jsonVar), { LIMITS: '{"max":2}' })
  assert.equal(parseArgs(['--version-id', target.toUpperCase()]).versionId, target)
  const tty = { stdinIsTTY: true, stdoutIsTTY: true }
  assert.throws(() => requireInteractive({ ...tty, stdinIsTTY: false, env: {} }), /interactive terminal/)
  // `--execute | tee log`: stdin is a TTY but wrangler still auto-confirms
  assert.throws(() => requireInteractive({ ...tty, stdoutIsTTY: false, env: {} }), /interactive terminal/)
  assert.throws(() => requireInteractive({ ...tty, env: { CI: 'true' } }), /set: CI/)
  assert.throws(() => requireInteractive({ ...tty, env: { BUILD_NUMBER: '7' } }), /set: BUILD_NUMBER/)
  assert.throws(() => requireInteractive({ ...tty, env: { CI_BUILD_ID: '1' } }), /set: CI_BUILD_ID/)
  assert.doesNotThrow(() => requireInteractive({ ...tty, env: { CI: '' } }))
  // wrangler's ci-info also reads vendor variables; none of them reaches wrangler
  const env = wranglerEnv({ PATH: '/bin', HOME: '/h', CLOUDFLARE_API_TOKEN: 't', WRANGLER_LOG: 'debug', https_proxy: 'p',
    CI: 'true', TF_BUILD: 'True', GITLAB_CI: '1', BUILDKITE: '1', NODE: '/app/.heroku/node/bin/node', CF_PAGES: '1' })
  assert.deepEqual(Object.keys(env).sort(), ['CLOUDFLARE_API_TOKEN', 'HOME', 'PATH', 'WRANGLER_LOG', 'https_proxy'])
  assert.doesNotThrow(() => requireInteractive({ ...tty, env: {} }))
})

test('wrangler env keeps the deprecated CF_* credentials and Windows mixed-case names, still no CI variable', () => {
  const env = wranglerEnv({ CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_API_KEY: 'k', CF_EMAIL: 'e', CF_API_BASE_URL: 'u',
    Path: 'C:/node', TEMP: 'C:/t', Tmp: 'C:/t2', SystemRoot: 'C:/Windows',
    CF_PAGES: '1', CF_PAGES_BRANCH: 'main', WORKERS_CI: '1', CI: 'true', TF_BUILD: 'True', NODE: '/app/.heroku/node/bin/node' })
  assert.deepEqual(Object.keys(env).sort(),
    ['CF_ACCOUNT_ID', 'CF_API_BASE_URL', 'CF_API_KEY', 'CF_API_TOKEN', 'CF_EMAIL', 'Path', 'SystemRoot', 'TEMP', 'Tmp'])
})
