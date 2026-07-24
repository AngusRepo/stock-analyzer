import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const frontendDir = join(root, 'frontend')
const manifestPath = join(root, 'infra', 'gcp-scheduler-jobs.json')
const wranglerCli = join(root, 'worker', 'node_modules', 'wrangler', 'bin', 'wrangler.js')
const pagesProject = String(process.env.CLOUDFLARE_PAGES_PROJECT ?? '').trim()
if (!pagesProject) throw new Error('CLOUDFLARE_PAGES_PROJECT is required')
const pagesProductionBranch = String(process.env.CLOUDFLARE_PAGES_PRODUCTION_BRANCH ?? '').trim()
if (!pagesProductionBranch) throw new Error('CLOUDFLARE_PAGES_PRODUCTION_BRANCH is required')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    env: options.env ?? process.env,
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
const sourceTreeSha = run('git', ['rev-parse', 'HEAD^{tree}'], { capture: true })
const sourceBranch = run('git', ['branch', '--show-current'], { capture: true })
if (!sourceBranch || sourceBranch !== productionBranch) {
  throw new Error(`source branch ${sourceBranch || '<detached>'} does not match PRODUCTION_BRANCH=${productionBranch}`)
}

const dirty = run('git', ['status', '--porcelain', '--untracked-files=all', '--', 'frontend', 'infra/gcp-scheduler-jobs.json', 'tools/deploy_pages_with_provenance.mjs'], { capture: true })
if (dirty) throw new Error(`Pages deployment inputs are dirty:\n${dirty}`)
if (!existsSync(manifestPath)) throw new Error(`missing scheduler manifest: ${manifestPath}`)
if (!existsSync(wranglerCli)) throw new Error('locked Worker Wrangler is missing; run npm ci in worker')

const schedulerManifestSha256 = createHash('sha256').update(readFileSync(manifestPath)).digest('hex')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const useShell = process.platform === 'win32'

run(npm, ['run', 'build'], {
  cwd: frontendDir,
  shell: useShell,
  env: { ...process.env, VITE_STOCKVISION_SOURCE_SHA: sourceSha },
})

const provenance = {
  schema: 'v1',
  provider: 'cloudflare-pages',
  project: pagesProject,
  sourceSha,
  sourceTreeSha,
  sourceBranch,
  targetBranch: pagesProductionBranch,
  schedulerManifestSha256,
}
mkdirSync(join(frontendDir, 'dist'), { recursive: true })
writeFileSync(
  join(frontendDir, 'dist', 'production-provenance.json'),
  `${JSON.stringify(provenance, null, 2)}\n`,
  'utf8',
)

run(process.execPath, [
  wranglerCli, 'pages', 'deploy', 'dist',
  '--project-name', pagesProject,
  '--branch', pagesProductionBranch,
  '--commit-hash', sourceSha,
  '--commit-message', `source=${sourceSha},scheduler=${schedulerManifestSha256}`,
  '--commit-dirty=false',
], { cwd: frontendDir })
