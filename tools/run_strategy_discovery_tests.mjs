import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const worker = resolve(root, 'worker')
const frontend = resolve(root, 'frontend')
const tsxCli = resolve(worker, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const excluded = new Set([
  'strategyDiscoveryLocalE2E.test.ts',
  'strategyDiscoveryRealModelE2E.test.ts',
])
const tests = readdirSync(resolve(worker, 'src/lib'))
  .filter((name) => /^strategyDiscovery.*\.test\.ts$/.test(name) && !excluded.has(name))
  .sort()

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}`)
}

for (const test of tests) {
  process.stdout.write(`[strategy-discovery] ${test}\n`)
  run(process.execPath, [tsxCli, `src/lib/${test}`], worker)
}
run(process.execPath, [tsxCli, 'src/lib/strategyDiscoveryUiContract.test.ts'], frontend)
run('node', ['tools/generate_strategy_discovery_feature_registry.mjs', '--check'], root)
process.stdout.write(`[strategy-discovery] PASS ${tests.length + 2} gates; local runtime E2E runs separately.\n`)
