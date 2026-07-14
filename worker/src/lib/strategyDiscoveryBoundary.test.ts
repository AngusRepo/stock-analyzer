import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => { const path = join(directory, name); return statSync(path).isDirectory() ? files(path) : [path] })
}

const scoped = [...files('src/strategy-discovery'), 'src/routes/strategyDiscoveryRoutes.ts']
const source = scoped.filter((path) => /\.(ts|json)$/.test(path)).map((path) => readFileSync(path, 'utf8')).join('\n')
for (const forbidden of [
  /from\s+['"]openai['"]|OpenAI\s*\(/i,
  /ANTHROPIC_API_KEY|GEMINI_API_KEY|OPENAI_API_KEY/,
  /paperOrder|placeOrder|brokerOrder|retrainModel|deployModel|promoteStrategy|schedulerMutation/,
]) assert.equal(forbidden.test(source), false, `bounded context contains forbidden owner/API pattern: ${forbidden}`)
assert.equal(/TODO|PLACEHOLDER|throw new Error\(['"]not implemented/i.test(source), false, 'bounded context must have no partial handler')
const workflow = readFileSync('src/strategy-discovery/workflow.ts', 'utf8')
assert.ok((workflow.match(/Promise\.all\(/g) ?? []).length >= 4, 'workflow must contain parallel independent model/storage steps')
assert.match(workflow, /HYPOTHESIS_SCIENTIST[\s\S]+REGIME_EXPLORER/)
assert.match(workflow, /DATA_PROSECUTOR[\s\S]+EXECUTION_PROSECUTOR[\s\S]+ECONOMIC_PROSECUTOR/)
assert.match(source, /env\.AI|this\.env\.AI/, 'native Workers AI binding is required')
assert.equal(source.includes('api.openai.com'), false)
const localRunner = readFileSync('../tools/run_strategy_discovery_local_e2e.ps1', 'utf8')
assert.match(localRunner, /if \(\$Resume\)[\s\S]+v3\\workflows[\s\S]+workflow-evidence[\s\S]+Move-Item/, 'resume must archive orphaned local Workflow runtime state before starting Wrangler')
