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
assert(page.includes('UpgradeTrackPanelV2'), 'ModelPool page should render artifact-gated L3 tracks through V2')
assert(!page.includes('{false &&'), 'ModelPool page must not hide old retired/shadow UI in a false render branch')
assert(page.includes('L2 coarse、L3 family ML、near-production candidate'), 'ModelPool title copy should describe the new screener flow')
assert(page.includes('!isRetiredModelName(name)'), 'ModelPool visible model list should filter retired ML from the main surface')

assert(workbench.includes("from 'lightweight-charts'"), 'New model pool cockpit should use lightweight-charts')
assert(workbench.includes('HistogramSeries'), 'New model pool cockpit should render layer count histograms')
assert(workbench.includes('LineSeries'), 'New model pool cockpit should render blocker line series')
assert(workbench.includes('createSeriesMarkers'), 'New model pool cockpit should render layer markers')
assert(workbench.includes('L2 coarse -> L3 family'), 'New model pool cockpit should describe the L2/L3 ownership split')
assert(workbench.includes('Active-9 confidence hook'), 'Model Pool cockpit should make the active-9 confidence hook visible')
assert(workbench.includes('adaptive-meta-policy-replay'), 'Model Pool cockpit should surface weekly Mode B policy replay')
assert(workbench.includes('linucb-multiplier-replay'), 'Model Pool cockpit should surface weekly LinUCB multiplier replay')
assert(workbench.includes('LinUCB, NeuralUCB, NeuralTS, and NeuCB'), 'Model Pool cockpit should compare the meta-policy candidates together')
assert(workbench.includes('walk-forward PASS'), 'Model Pool cockpit should show L2 KV push needs walk-forward PASS')
assert(workbench.includes('Active-9 evidence chain chart'), 'Model Pool cockpit chart should have an accessible label')

for (const token of ['\ueec4', '\uef3e', '\uea57', '嚗']) {
  assert(!page.includes(token), `ModelPoolPage should not contain mojibake token ${token}`)
  assert(!workbench.includes(token), `ModelPoolNewFlowWorkbench should not contain mojibake token ${token}`)
}

for (const id of ['TabM', 'GNN', 'iTransformer', 'TimesFM']) {
  assert(track.includes(`id: '${id}'`), `${id} should be listed as a production L3 slot`)
  assert(workbench.includes(id), `${id} should appear in the L3 model cockpit`)
}

for (const retired of ['FT-Transformer', 'FTTransformer', 'Chronos', 'Chronos2ZeroShot', 'Chronos2LoRA']) {
  assert(track.includes(`'${retired}'`), `${retired} should be documented in the retired model list`)
}

assert(track.includes('MODEL_POOL_RESEARCH_SHADOW_MODEL_IDS'), 'ResidualMLP should be documented as research shadow, not retired alpha')
assert(track.includes("'ResidualMLP'"), 'ResidualMLP research shadow id should stay visible to taxonomy readers')
assert(!track.includes("id: 'ResidualMLP'"), 'ResidualMLP should not be a visible upgrade candidate')
assert(!track.includes("id: 'Chronos2ZeroShot'"), 'Chronos2ZeroShot should not be a visible upgrade candidate')
assert(!track.includes("id: 'Chronos2LoRA'"), 'Chronos2LoRA should not be a visible upgrade candidate')
assert(track.includes('production_slot_member'), 'L3 target models must be represented as formal production slots')
assert(!track.includes('MODEL_POOL_NEAR_PRODUCTION_IDS'), 'L3 production slots must not be labeled near-production')
assert(!track.includes('benchmark-only'), 'L3 target candidates should not be described as benchmark-only')
assert(track.includes('formal L3 slot wiring'), 'TimesFM evidence should explicitly require formal L3 slot wiring')
assert(page.includes('Promotion & Parameter Governance'), 'Promotion section should explain parameter and version governance in visible copy')
