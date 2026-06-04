import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'ModelPoolPage.tsx')
const trackPath = path.join(root, 'src', 'lib', 'modelUpgradeTrack.ts')
const workbenchPath = path.join(root, 'src', 'components', 'model-pool', 'ModelPoolNewFlowWorkbench.tsx')

assert(fs.existsSync(workbenchPath), 'ModelPoolNewFlowWorkbench should exist for the new L2/L3 cockpit')

const page = fs.readFileSync(pagePath, 'utf8')
const track = fs.readFileSync(trackPath, 'utf8')
const workbench = fs.readFileSync(workbenchPath, 'utf8')

assert(page.includes('ModelPoolNewFlowWorkbench'), 'ModelPool page should render the new flow cockpit')
assert(page.includes('PromotionQueuePanelV2'), 'ModelPool page should keep promotion and parameter governance as its own V2 section')
assert(page.includes('UpgradeTrackPanelV2'), 'ModelPool page should render near-production L3 tracks through V2')
assert(!page.includes('{false &&'), 'ModelPool page must not hide old retired/shadow UI in a false render branch')
assert(page.includes('L2 coarse、L3 family ML、近 production 候選'), 'ModelPool title copy should describe the new screener flow')
assert(page.includes('!isRetiredModelName(name)'), 'ModelPool visible model list should filter retired ML from the main surface')

assert(workbench.includes("from 'lightweight-charts'"), 'New model pool cockpit should use lightweight-charts')
assert(workbench.includes('HistogramSeries'), 'New model pool cockpit should render layer count histograms')
assert(workbench.includes('LineSeries'), 'New model pool cockpit should render blocker line series')
assert(workbench.includes('createSeriesMarkers'), 'New model pool cockpit should render layer markers')
assert(workbench.includes('L2 coarse -> L3 family'), 'New model pool cockpit should describe the L2/L3 ownership split')

for (const id of ['TabM', 'GNN', 'iTransformer', 'TimesFM']) {
  assert(track.includes(`id: '${id}'`), `${id} should be listed as a near-production model candidate`)
  assert(workbench.includes(id), `${id} should appear in the near-production cockpit`)
}

for (const retired of ['FT-Transformer', 'Chronos', 'Chronos2ZeroShot', 'Chronos2LoRA', 'ResidualMLP']) {
  assert(track.includes(`'${retired}'`), `${retired} should be documented in the retired model list`)
}

assert(!track.includes("id: 'ResidualMLP'"), 'ResidualMLP should not be a visible upgrade candidate')
assert(!track.includes("id: 'Chronos2ZeroShot'"), 'Chronos2ZeroShot should not be a visible upgrade candidate')
assert(!track.includes("id: 'Chronos2LoRA'"), 'Chronos2LoRA should not be a visible upgrade candidate')
assert(!track.includes('benchmark-only'), 'Near-production candidates should not be described as benchmark-only')
assert(track.includes('formal_layer3_slots'), 'TimesFM evidence should explicitly require formal L3 slot wiring')
assert(page.includes('Promotion & Parameter Governance'), 'Promotion section should explain parameter and version governance in visible copy')
