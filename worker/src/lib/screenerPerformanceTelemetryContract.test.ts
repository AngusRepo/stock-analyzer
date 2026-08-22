import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const screener = readFileSync(new URL('./marketScreener.ts', import.meta.url), 'utf8')
const runner = readFileSync(new URL('../node-runner/screenerJobMain.ts', import.meta.url), 'utf8')
const cloudRunJob = readFileSync(new URL('../../../ml-controller/screener_job_main.py', import.meta.url), 'utf8')

for (const stage of [
  'bootstrap_config_and_regime',
  'market_data_buzz_and_theme',
  'restrictions_taxonomy_and_sector',
  'universe_and_base_scoring',
  'selection_enrichment_and_side_effects',
  'funnel_persistence',
]) {
  assert.ok(screener.includes(`markScreenerStage('${stage}')`), `missing screener timing stage ${stage}`)
}
assert.ok(runner.includes('performance: result.performance ?? null'), 'node runner must emit screener performance')
assert.ok(cloudRunJob.includes('"screener_metrics": result.get("metrics")'), 'Cloud Run callback must forward screener metrics')

console.log('screener performance telemetry contract passed')
