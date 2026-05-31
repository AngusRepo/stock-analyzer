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
const dashboardReadRoutes = fs.readFileSync(path.join(root, 'worker', 'src', 'routes', 'dashboardReadRoutes.ts'), 'utf8')

assert(page.includes('Serving Alpha Slots'), 'Model Pool must label active plus degraded production alpha voting slots clearly')
assert(page.includes('Formal L3 Slots'), 'Model Pool must distinguish formal Layer 3 slots from active alpha models')
assert(page.includes('Retired Paths'), 'Model Pool must distinguish retired model paths from active alpha models')
assert(page.includes('familyAccentClass'), 'Model Pool should show family inside the health matrix instead of a standalone family panel')
assert(page.includes('State-space Overlays /'), 'Model Pool must keep Kalman/Markov as overlays, not alpha vote models')
assert(page.includes('MODEL_UPGRADE_CANDIDATES'), 'Model Pool UI must render the P7 upgrade track candidates')
assert(page.includes('selected candidate only: shadow predict -> verify-v2 -> IC tracker'), 'Model Pool live gate evidence must use selected registry candidates instead of legacy challenger slots')
assert(page.includes('verify-v2') && page.includes('actual_return'), 'Model Pool/verify guidance must point to verified outcome writes as IC prerequisite')
assert(page.includes('review packet required'), 'Formal Layer 3 candidates must require experiment registry / review packet before promotion')
assert(page.includes('Live Gate Evidence /'), 'Model Pool must show same-family artifact live gate evidence from registry candidates')
assert(page.includes('Layer 3 Formal Slots /'), 'Model Pool must show experiment-gated formal Layer 3 slots')
assert(page.includes('modelUpgradeNeedsExperiment'), 'Model Pool must explicitly separate experiment-registry lanes from track-only governance lanes')
assert(page.includes('statusRows={modelUpgradeStatus?.candidates ?? []}'), 'Model Pool must consume backend model-upgrade status rows')
assert(!page.includes('track_only'), 'Model Pool research tracks should not render track-only governance lanes')
assert(!page.includes('這個軌道不走 Strategy Lab experiment registry'), 'Track-only governance copy belongs outside Model Pool research tracks')
assert(page.includes('Chronos is retired from alpha vote'), 'Chronos retirement should be explicit in the model page')
assert(!page.includes('GAOptimizer'), 'GAOptimizer should be routed to adaptive/meta governance instead of Model Pool cards')
assert(page.includes('Kalman / Markov 只扮演'), 'State-space overlays should be shown only in the live overlay section')
assert(page.includes('Artifact Diff /'), 'Model Pool must expose champion-vs-candidate artifact differences')
assert(page.includes('champion pointer -> candidate'), 'Artifact diff must compare champion pointer to registry candidate')
assert(page.includes('version-only baseline'), 'Artifact diff must expose missing champion artifact linkage instead of fake NaN')
assert(page.includes('experiment_missing') && page.includes('尚未建立 Strategy Lab 實驗'), 'Model-upgrade experiment lanes must clearly show missing research experiment evidence instead of fake trained state')
assert(page.includes('這不是 model_artifact_registry'), 'Model-family challenger UI must explain why research candidates are not in model_artifact_registry')
assert(page.includes('Model Registry /'), 'Model Pool must show release-train artifact registry selection')
assert(page.includes('Next Monthly Release Candidate'), 'Model Registry must not confuse current production with the next monthly candidate')
assert(page.includes('Chronos retired from alpha vote'), 'Model Registry must explain why Chronos has no active monthly retrain artifact')
assert(page.includes('Promotion Queue /'), 'Model Pool must show promotion-controller queue instead of hiding final comparison state')
assert(page.includes('Final compare dry-run'), 'Promotion queue must expose final comparison dry-run before mutation')
assert(page.includes('Wei approve + promote pointer'), 'Promotion queue must expose explicit Wei approval action for weekly/manual candidates')
assert(page.includes('Auto promote pointer'), 'Promotion queue must expose controlled auto-promotion action for monthly candidates')
assert(!page.includes('ServingAlphaStrip'), 'Model Pool must not render the removed duplicate serving strip')
assert(!page.includes('Model Ops Mission Control'), 'Model Pool must not render the removed duplicate Model Ops Mission Control panel')
assert(page.includes('Artifact linked'), 'Champion pointer UI must distinguish version-only pointers from artifact-linked production baselines')
assert(page.includes('Artifact Lifecycle Summary /'), 'Model Pool must expose a lifecycle summary strip across champion, candidate, live evidence, and promotion queue')
assert(page.includes('<ArtifactLifecycleSummaryPanel'), 'Model Pool must mount the lifecycle summary strip, not only define it')
assert(page.includes('data-testid="modelpool-governance-drilldown"'), 'Model Pool must collapse dense governance panels behind a drilldown disclosure')
assert(
  page.indexOf('<ArtifactLifecycleSummaryPanel') < page.indexOf('data-testid="modelpool-governance-drilldown"'),
  'Model Pool lifecycle summary must appear before dense governance drilldown'
)
assert(page.includes('ActionContextNote'), 'Model Pool must render backend-owned artifact action context instead of inferring root cause only in the UI')
assert(page.includes('affected_downstream'), 'Live gate UI must expose affected downstream from artifact action context')
assert(api.includes('formatApiError'), 'Frontend API client must format non-OK responses with endpoint context')
assert(api.includes('API unavailable') && api.includes('localhost:8787'), 'Local proxy 500s must point to the Worker API dependency instead of a raw Internal Server Error')

assert(dashboardReadRoutes.includes('/api/model-pool/artifact_registry'), 'Worker must proxy model artifact registry API for frontend')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/selection'), 'Worker must proxy artifact selection API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/promotion_queue'), 'Worker must proxy artifact promotion queue API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/promotion_controller'), 'Worker must proxy artifact promotion-controller API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/champion_pointers'), 'Worker must proxy champion pointer projection API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/champion_pointers/backfill'), 'Worker must proxy champion pointer backfill API to ml-controller')

for (const id of ['Chronos', 'ResidualMLP', 'GNN', 'TabM', 'iTransformer', 'TimesFM', 'GAOptimizer', 'KalmanFilter', 'MarkovSwitching']) {
  assert(track.includes(id), `Model upgrade track must include ${id}`)
}
assert(!track.includes('FT-Transformer'), 'FT-Transformer must not remain as a Model Pool upgrade track or comparator')
assert(!track.includes("id: 'Moirai'"), 'Moirai must stay excluded from active benchmark candidates until weight/license risk is cleared')

assert(track.includes("stage: 'layer3_formal_family_slot'"), 'Upgrade track must include formal Layer 3 family slot stage')
assert(track.includes("stage: 'retired'"), 'Upgrade track must include retired stage')
assert(track.includes('canVote: false'), 'Non-production upgrade candidates must not vote directly')
