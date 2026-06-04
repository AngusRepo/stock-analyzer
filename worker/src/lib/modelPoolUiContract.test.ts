import * as fs from 'node:fs'
import * as path from 'node:path'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const frontend = path.join(root, 'frontend', 'src')
const page = fs.readFileSync(path.join(frontend, 'pages', 'ModelPoolPage.tsx'), 'utf8')
const track = fs.readFileSync(path.join(frontend, 'lib', 'modelUpgradeTrack.ts'), 'utf8')
const api = fs.readFileSync(path.join(frontend, 'lib', 'api.ts'), 'utf8')
const workbench = fs.readFileSync(
  path.join(frontend, 'components', 'model-pool', 'ModelPoolNewFlowWorkbench.tsx'),
  'utf8',
)
const dashboardReadRoutes = fs.readFileSync(
  path.join(root, 'worker', 'src', 'routes', 'dashboardReadRoutes.ts'),
  'utf8',
)

assert(page.includes('ModelPoolNewFlowWorkbench'), 'Model Pool must render the new L2/L3 cockpit')
assert(page.includes('PromotionQueuePanelV2'), 'Model Pool must keep promotion and parameter governance')
assert(page.includes('UpgradeTrackPanelV2'), 'Model Pool must render artifact-gated L3 tracks')
assert(page.includes('!isRetiredModelName(name)'), 'Model Pool must filter retired ML from the main surface')
assert(!page.includes('{false &&'), 'Model Pool must not hide retired UI in a false render branch')

assert(workbench.includes("from 'lightweight-charts'"), 'Model Pool cockpit must use lightweight-charts')
assert(workbench.includes('HistogramSeries'), 'Model Pool cockpit must render layer count histograms')
assert(workbench.includes('LineSeries'), 'Model Pool cockpit must render blocker line series')
assert(workbench.includes('createSeriesMarkers'), 'Model Pool cockpit must render layer markers')
assert(workbench.includes('L2 coarse -> L3 family'), 'Model Pool cockpit must show the L2/L3 ownership split')

for (const id of ['TabM', 'GNN', 'iTransformer', 'TimesFM']) {
  assert(track.includes(`id: '${id}'`), `${id} must be listed as production_slot_member`)
  assert(workbench.includes(id), `${id} must appear in the L3 model cockpit`)
}

for (const retired of ['FT-Transformer', 'Chronos', 'Chronos2ZeroShot', 'Chronos2LoRA', 'ResidualMLP']) {
  assert(track.includes(`'${retired}'`), `${retired} must be documented in the retired model list`)
}

assert(!track.includes("id: 'ResidualMLP'"), 'ResidualMLP must not be a visible production candidate')
assert(!track.includes("id: 'Chronos2ZeroShot'"), 'Chronos2ZeroShot must not be a visible production candidate')
assert(!track.includes("id: 'Chronos2LoRA'"), 'Chronos2LoRA must not be a visible production candidate')
assert(track.includes('production_slot_member'), 'L3 targets must be formal production slots')
assert(!track.includes('benchmark-only'), 'L3 target candidates must not be described as benchmark-only')
assert(track.includes('formal_layer3_slots'), 'TimesFM evidence must require formal L3 slot wiring')
assert(track.includes("stage: 'meta_optimizer'"), 'GAOptimizer must be a meta optimizer')
assert(track.includes("stage: 'state_space_overlay'"), 'Kalman/Markov must stay overlays')

assert(api.includes('production_slot_member'), 'Frontend API type must accept production slot stage')
assert(api.includes('formatApiError'), 'Frontend API client must format non-OK responses with endpoint context')
assert(api.includes('API unavailable') && api.includes('localhost:8787'), 'Local proxy errors must point to Worker API dependency')

assert(dashboardReadRoutes.includes('/api/model-pool/artifact_registry'), 'Worker must proxy model artifact registry API')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/selection'), 'Worker must proxy artifact selection API')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/promotion_queue'), 'Worker must proxy artifact promotion queue API')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/promotion_controller'), 'Worker must proxy promotion-controller API')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/champion_pointers'), 'Worker must proxy champion pointer API')
