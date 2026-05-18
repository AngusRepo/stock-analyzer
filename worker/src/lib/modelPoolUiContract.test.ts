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
const dashboardReadRoutes = fs.readFileSync(path.join(root, 'worker', 'src', 'routes', 'dashboardReadRoutes.ts'), 'utf8')

assert(page.includes('Serving Alpha Slots'), 'Model Pool must label active plus degraded production alpha voting slots clearly')
assert(page.includes('Shadow Challengers'), 'Model Pool must distinguish shadow challengers from active alpha models')
assert(page.includes('Research Benchmarks'), 'Model Pool must distinguish benchmark-only candidates from challengers')
assert(page.includes('familyAccentClass'), 'Model Pool should show family inside the health matrix instead of a standalone family panel')
assert(page.includes('State-space Overlays /'), 'Model Pool must keep Kalman/Markov as overlays, not alpha vote models')
assert(page.includes('MODEL_UPGRADE_CANDIDATES'), 'Model Pool UI must render the P7 upgrade track candidates')
assert(page.includes('selected candidate only: shadow predict -> verify-v2 -> IC tracker'), 'Model Pool live gate evidence must use selected registry candidates instead of legacy challenger slots')
assert(page.includes('verify-v2') && page.includes('actual_return'), 'Model Pool/verify guidance must point to verified outcome writes as IC prerequisite')
assert(page.includes('benchmark report required'), 'Benchmark-only candidates must require experiment registry / benchmark report before promotion')
assert(page.includes('Live Gate Evidence /'), 'Model Pool must show same-family artifact live gate evidence from registry candidates')
assert(page.includes('Model-family Challenger /'), 'Model Pool must show ResidualMLP/GNN as model-family challengers, not confuse them with DLinear/PatchTST version challengers')
assert(page.includes('Artifact Diff /'), 'Model Pool must expose champion-vs-candidate artifact differences')
assert(page.includes('champion pointer -> candidate'), 'Artifact diff must compare champion pointer to registry candidate')
assert(page.includes('version-only baseline'), 'Artifact diff must expose missing champion artifact linkage instead of fake NaN')
assert(page.includes('experiment missing') && page.includes('experiment incomplete'), 'Model-family challengers must clearly show missing research experiment evidence instead of fake trained state')
assert(page.includes('This is not model_artifact_registry yet'), 'Model-family challenger UI must explain why research candidates are not in model_artifact_registry')
assert(page.includes('Model Registry /'), 'Model Pool must show release-train artifact registry selection')
assert(page.includes('Next Monthly Release Candidate'), 'Model Registry must not confuse current production with the next monthly candidate')
assert(page.includes('Chronos is not in monthly retrain'), 'Model Registry must explain why Chronos has no monthly retrain artifact')
assert(page.includes('Promotion Queue /'), 'Model Pool must show promotion-controller queue instead of hiding final comparison state')
assert(page.includes('Final compare dry-run'), 'Promotion queue must expose final comparison dry-run before mutation')
assert(page.includes('Wei approve + promote pointer'), 'Promotion queue must expose explicit Wei approval action for weekly/manual candidates')
assert(page.includes('Auto promote pointer'), 'Promotion queue must expose controlled auto-promotion action for monthly candidates')
assert(!page.includes('ServingAlphaStrip'), 'Model Pool must not render the removed duplicate serving strip')
assert(!page.includes('Model Ops Mission Control'), 'Model Pool must not render the removed duplicate Model Ops Mission Control panel')
assert(page.includes('Artifact linked'), 'Champion pointer UI must distinguish version-only pointers from artifact-linked production baselines')
assert(page.includes('Artifact Lifecycle Summary /'), 'Model Pool must expose a lifecycle summary strip across champion, candidate, live evidence, and promotion queue')
assert(page.includes('ActionContextNote'), 'Model Pool must render backend-owned artifact action context instead of inferring root cause only in the UI')
assert(page.includes('affected_downstream'), 'Live gate UI must expose affected downstream from artifact action context')

assert(dashboardReadRoutes.includes('/api/model-pool/artifact_registry'), 'Worker must proxy model artifact registry API for frontend')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/selection'), 'Worker must proxy artifact selection API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/promotion_queue'), 'Worker must proxy artifact promotion queue API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/promotion_controller'), 'Worker must proxy artifact promotion-controller API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/champion_pointers'), 'Worker must proxy champion pointer projection API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/champion_pointers/backfill'), 'Worker must proxy champion pointer backfill API to ml-controller')

for (const id of ['ResidualMLP', 'GNN', 'TabM', 'iTransformer', 'TimesFM']) {
  assert(track.includes(id), `Model upgrade track must include ${id}`)
}
assert(!track.includes("id: 'Moirai'"), 'Moirai must stay excluded from active benchmark candidates until weight/license risk is cleared')

assert(track.includes("stage: 'shadow_challenger'"), 'Upgrade track must include shadow challenger stage')
assert(track.includes("stage: 'benchmark_only'"), 'Upgrade track must include benchmark-only stage')
assert(track.includes('canVote: false'), 'Non-production upgrade candidates must not vote directly')
