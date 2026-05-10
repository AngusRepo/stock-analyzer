const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const frontend = path.join(root, 'frontend', 'src')
const page = fs.readFileSync(path.join(frontend, 'pages', 'ModelPoolPage.tsx'), 'utf8')
const track = fs.readFileSync(path.join(frontend, 'lib', 'modelUpgradeTrack.ts'), 'utf8')
const dashboardReadRoutes = fs.readFileSync(path.join(root, 'worker', 'src', 'routes', 'dashboardReadRoutes.ts'), 'utf8')

assert(page.includes('Alpha Models /'), 'Model Pool must label production alpha voting models clearly')
assert(page.includes('Shadow Challengers'), 'Model Pool must distinguish shadow challengers from active alpha models')
assert(page.includes('Research Benchmarks'), 'Model Pool must distinguish benchmark-only candidates from challengers')
assert(page.includes('Family Balance /'), 'Model Pool should include a visual family balance section')
assert(page.includes('State-space Overlays /'), 'Model Pool must keep Kalman/Markov as overlays, not alpha vote models')
assert(page.includes('MODEL_UPGRADE_CANDIDATES'), 'Model Pool UI must render the P7 upgrade track candidates')
assert(page.includes('Live shadow IC + artifact evidence'), 'Model Pool must show live challenger IC/samples/root-cause evidence separately from static plans')
assert(page.includes('verify-v2') && page.includes('actual_return'), 'Model Pool/verify guidance must point to verified outcome writes as IC prerequisite')
assert(page.includes('benchmark report required'), 'Benchmark-only candidates must require experiment registry / benchmark report before promotion')
assert(page.includes('Version Challenger /'), 'Model Pool must distinguish same-family artifact challengers from new model-family challengers')
assert(page.includes('Model-family Challenger /'), 'Model Pool must show ResidualMLP/GNN as model-family challengers, not confuse them with DLinear/PatchTST version challengers')
assert(page.includes('Artifact Diff /'), 'Model Pool must expose active-vs-challenger artifact differences')
assert(page.includes('sequence_report.input_series'), 'Artifact diff must surface sequence_report input coverage')
assert(page.includes('metadata anomaly'), 'Artifact diff must highlight metadata anomalies such as n_input_series mismatch')
assert(page.includes('registry missing') && page.includes('registry incomplete'), 'Model-family challengers must clearly show missing training evidence instead of fake trained state')
assert(page.includes('Model Registry /'), 'Model Pool must show release-train artifact registry selection')
assert(page.includes('Promotion Queue /'), 'Model Pool must show promotion-controller queue instead of hiding final comparison state')
assert(page.includes('Champion Pointer Contract /'), 'Model Pool must show production champion pointer migration contract')

assert(dashboardReadRoutes.includes('/api/model-pool/artifact_registry'), 'Worker must proxy model artifact registry API for frontend')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/selection'), 'Worker must proxy artifact selection API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/promotion_queue'), 'Worker must proxy artifact promotion queue API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/champion_pointers'), 'Worker must proxy champion pointer projection API to ml-controller')
assert(dashboardReadRoutes.includes('/model_pool/artifact_registry/champion_pointers/backfill'), 'Worker must proxy champion pointer backfill API to ml-controller')

for (const id of ['ResidualMLP', 'GNN', 'TabM', 'iTransformer', 'TimesFM']) {
  assert(track.includes(id), `Model upgrade track must include ${id}`)
}
assert(!track.includes("id: 'Moirai'"), 'Moirai must stay excluded from active benchmark candidates until weight/license risk is cleared')

assert(track.includes("stage: 'shadow_challenger'"), 'Upgrade track must include shadow challenger stage')
assert(track.includes("stage: 'benchmark_only'"), 'Upgrade track must include benchmark-only stage')
assert(track.includes('canVote: false'), 'Non-production upgrade candidates must not vote directly')
