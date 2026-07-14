import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatStep, isRunPolling, type DashboardState } from './strategyDiscoveryViewModel'

const src = resolve(process.cwd(), 'src')
const files = [
  'pages/StrategyDiscoveryPage.tsx',
  'components/strategy-discovery/AnalysisButton.tsx',
  'components/strategy-discovery/CodexConclusionButton.tsx',
  'components/strategy-discovery/CodexPanel.tsx',
  'components/strategy-discovery/FinalConclusionView.tsx',
]
const source = files.map((file) => readFileSync(resolve(src, file), 'utf8')).join('\n')

assert.equal((source.match(/data-primary-action="true"/g) ?? []).length, 2, 'Lab content must expose exactly two primary actions')
assert.match(source, />完整分析</)
assert.match(source, />Codex 結論</)
for (const forbidden of ['開始 Discovery', '開始紅隊', '匯出 Bundle', '匯入 Codex', '繼續分析', '重新分析', '產生報告', '>Retry<']) {
  assert.equal(source.includes(forbidden), false, `forbidden third action: ${forbidden}`)
}
assert.match(source, /onDrop=\{drop\}/, 'Codex result must support drag/drop')
assert.match(source, /onImport\(file\)/, 'drop must trigger import without confirmation button')
assert.match(source, /sessionStorage\.getItem\(key\)/, 'bundle auto-download must be once per bundle')
assert.match(source, /content-visibility:auto/, 'long verdict rows need rendering containment')
for (const section of ['Executive Conclusion', '現有策略', '新候選', 'Red Team Accuracy', 'Tests', 'Remaining Uncertainty']) assert.ok(source.includes(section), `missing result section: ${section}`)

const pollingState = {
  analysis_button: { state: 'RUNNING' },
} as DashboardState
assert.equal(isRunPolling(pollingState), true)
assert.equal(isRunPolling({ analysis_button: { state: 'COMPLETED' } } as DashboardState), false)
assert.equal(formatStep('07_adversarial_review'), 'adversarial review')

console.log('strategyDiscoveryUiContract.test.ts: PASS')
