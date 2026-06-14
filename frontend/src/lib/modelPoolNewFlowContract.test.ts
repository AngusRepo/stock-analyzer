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
assert(!page.includes('UpgradeTrackPanelV2'), 'ModelPool page should not duplicate the active-9 matrix with old L3 cards')
assert(!page.includes('{false &&'), 'ModelPool page must not hide old retired/shadow UI in a false render branch')
assert(page.includes('Registry, lineage, active-9 evidence'), 'ModelPool title copy should describe the registry governance flow')
assert(page.includes('!isRetiredModelName(name)'), 'ModelPool visible model list should filter retired ML from the main surface')

assert(!workbench.includes("from 'lightweight-charts'"), 'Model Pool cockpit should not use an unclear fake timeline chart')
assert(workbench.includes('Grafana-style model operations'), 'Model Pool cockpit should expose the Grafana-style operations header')
assert(workbench.includes('Fleet status'), 'Model Pool cockpit should show active-9 fleet status cells')
assert(workbench.includes('Evidence matrix'), 'Model Pool cockpit should show weekly IC, OOS, live, PBO/CPCV, final compare, and state in one matrix')
assert(workbench.includes('Gate & incidents'), 'Model Pool cockpit should merge alert queue and gate drilldown into one focused panel')
assert(workbench.includes('Incidents queue'), 'Merged gate panel should keep blocker and promotion incidents visible')
assert(!workbench.includes('Alert queue'), 'Model Pool cockpit should not duplicate next-action copy in a separate alert queue panel')
assert(!workbench.includes('Gate inspector'), 'Model Pool cockpit should not keep a separate gate inspector panel after merging incidents')
assert(workbench.includes('Evidence table'), 'Model Pool cockpit should keep dense registry evidence table')
assert(workbench.includes('Promotion readiness funnel'), 'Gate inspector should show a per-model readiness funnel')
assert(workbench.includes('selectedModelId'), 'Gate inspector should be driven by selected model state')
assert(workbench.includes('onSelectModel'), 'Fleet/timeline/alert rows should update selected model state')
assert(workbench.includes('aria-pressed={isSelected}'), 'Selectable model rows should expose pressed state for accessibility')
assert(workbench.includes('selectedArtifactEvidence'), 'Evidence matrix should read artifact offline/live evidence instead of weekly IC only')
assert(workbench.includes('OOS IC') && workbench.includes('PBO/CPCV') && workbench.includes('FINAL'), 'Evidence matrix should include OOS IC, PBO/CPCV, and final compare gates')
assert(workbench.includes('Missing evidence'), 'Evidence table should expose missing evidence chips')
assert(page.includes('modelUpgradeStatusReady={modelUpgradeStatus.isSuccess}'), 'ModelPool page should pass model-upgrade status readiness into the cockpit')
assert(workbench.includes('modelUpgradeStatusReady?: boolean'), 'Model Pool cockpit should accept model-upgrade status readiness')
assert(workbench.includes("status === 'syncing_evidence'"), 'Model Pool cockpit should render a neutral syncing state before evidence status is ready')
assert(workbench.includes('evidence_status_syncing'), 'Model Pool cockpit should block gate PASS while evidence status is still syncing')
assert(workbench.includes('const rawStatus = modelUpgradeStatusReady'), 'Model Pool cockpit should guard status fallback behind model-upgrade readiness')
assert(!workbench.includes("const rawStatus = statusRow?.registry_status ?? model?.status ?? 'no_data'"), 'Model Pool cockpit must not use an unguarded lineage-active status fallback')
assert(workbench.includes('L2 coarse -> L3 family'), 'New model pool cockpit should describe the L2/L3 ownership split')
assert(workbench.includes('dataset, pointer, promotion pressure, and missing evidence'), 'Model Pool cockpit should show dataset, pointer, promotion pressure, and missing evidence in the evidence table')
assert(workbench.includes('Active-9 confidence hook'), 'Model Pool cockpit should make the active-9 confidence hook visible')
assert(workbench.includes('adaptive-meta-policy-replay'), 'Model Pool cockpit should surface weekly Mode B policy replay')
assert(workbench.includes('linucb-multiplier-replay'), 'Model Pool cockpit should surface weekly LinUCB multiplier replay')
assert(workbench.includes('LinUCB, NeuralUCB, NeuralTS, and NeuCB'), 'Model Pool cockpit should compare the meta-policy candidates together')
assert(workbench.includes('walk-forward PASS'), 'Model Pool cockpit should show L2 KV push needs walk-forward PASS')
assert(!workbench.includes(['Snapshot', 'of the active-9 evidence chain'].join(' ')), 'Model Pool cockpit should remove the unclear evidence chain snapshot')

for (const token of ['\ueec4', '\uef3e', '\uea57']) {
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
