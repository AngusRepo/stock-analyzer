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
assert(!page.includes('UpgradeTrackPanelV2'), 'Model Pool must not duplicate active-9 details outside the operating matrix')
assert(page.includes('!isRetiredModelName(name)'), 'Model Pool must filter retired ML from the main surface')
assert(!page.includes('{false &&'), 'Model Pool must not hide retired UI in a false render branch')
assert(page.includes('ModelPoolWorkbenchSnapshot'), 'Model Pool must render from a complete evidence snapshot instead of partial query hydration')
assert(page.includes('Promise.allSettled'), 'Model Pool refresh must refetch all evidence feeds as one snapshot refresh')
assert(page.includes('modelPoolSnapshotReady'), 'Model Pool must guard the cockpit until the evidence snapshot is ready')
assert(page.includes('Loading complete model-pool evidence snapshot'), 'Model Pool loading copy must make snapshot hydration explicit')
assert(!page.includes('refetchInterval: 60_000'), 'Model Pool must not let independent query intervals create staggered UI updates')

assert(!workbench.includes("from 'lightweight-charts'"), 'Model Pool cockpit must not use the unclear fake timeline chart')
assert(workbench.includes('Grafana-style model operations'), 'Model Pool cockpit must expose the Grafana-style operations header')
assert(workbench.includes('Fleet status'), 'Model Pool cockpit must show active-9 fleet status cells')
assert(workbench.includes('Evidence matrix'), 'Model Pool cockpit must show weekly IC, OOS, live, PBO/CPCV, and champion compare in one matrix')
assert(workbench.includes('fleetToneFromMatrix'), 'Fleet status must be derived from the same gate tones used by the Evidence matrix')
assert(workbench.includes("requiredGateLabels = new Set(['OOS IC', 'LIVE', 'PBO/CPCV', 'COMPARE'])"), 'Fleet status must summarize required matrix gate cells')
assert(workbench.includes('record.fleetTone'), 'Fleet status cards must render the matrix-derived fleet tone')
assert(workbench.includes('Candidate release readiness'), 'Model Pool cockpit must make selected-model readiness explicitly candidate-release oriented')
assert(!workbench.includes('Gate & incidents'), 'Model Pool cockpit must not keep a duplicated gate/incidents panel')
assert(!workbench.includes('Incidents queue'), 'Model Pool cockpit must consolidate incidents into the evidence table missing-evidence column')
assert(!workbench.includes('Alert queue'), 'Model Pool cockpit must not duplicate next-action copy in a separate alert queue panel')
assert(!workbench.includes('Gate inspector'), 'Model Pool cockpit must not keep a separate gate inspector panel after merging incidents')
assert(workbench.includes('selectedModelId'), 'Model Pool gate inspector must be driven by selected model state')
assert(workbench.includes('onSelectModel'), 'Model Pool fleet/timeline/alert rows must update the selected inspector model')
assert(workbench.includes('aria-pressed={isSelected}'), 'Selectable model rows must expose pressed state')
assert(workbench.includes('selectedArtifactEvidence'), 'Evidence matrix must read artifact offline/live evidence instead of weekly IC only')
assert(workbench.includes('OOS IC') && workbench.includes('PBO/CPCV') && workbench.includes('COMPARE'), 'Evidence matrix must include OOS IC, PBO/CPCV, and champion compare gates')
assert(!workbench.includes("label: 'STATE'"), 'Evidence matrix must not duplicate fleet status as a STATE column')
assert(workbench.includes('PBO ${formatMetric(pboValue, 2)}<${formatMetric(pboMax, 2)}'), 'PBO/CPCV cells must expose values and thresholds')
assert(workbench.includes('OBSERVE') && workbench.includes('parity only'), 'LIVE cells must normalize legacy shadowing text into parity-only evidence language')
assert(workbench.includes('Missing evidence'), 'Evidence table must expose missing evidence chips')
assert(page.includes('modelPoolSnapshot!.statusRows'), 'Model Pool page must pass model-upgrade status rows from the stable snapshot into the cockpit')
assert(workbench.includes('modelUpgradeStatusReady?: boolean'), 'Model Pool cockpit must accept model-upgrade status readiness')
assert(workbench.includes("status === 'syncing_evidence'"), 'Model Pool cockpit must render neutral syncing state before evidence status is ready')
assert(workbench.includes('evidence_status_syncing'), 'Model Pool cockpit must block gate PASS while evidence status is still syncing')
assert(workbench.includes('const rawStatus = modelUpgradeStatusReady'), 'Model Pool cockpit must guard status fallback behind model-upgrade readiness')
assert(!workbench.includes("const rawStatus = statusRow?.registry_status ?? model?.status ?? 'no_data'"), 'Model Pool cockpit must not use an unguarded lineage-active status fallback')
assert(workbench.includes('Evidence table'), 'Model Pool cockpit must keep dense registry evidence table')
assert(workbench.includes('Research diagnosis'), 'Selected-model drilldown must expose root cause and next action for research states')
assert(workbench.includes('Candidate release funnel'), 'Selected-model drilldown must show the candidate release readiness funnel')
assert(workbench.includes('L2 coarse -> L3 family'), 'Model Pool cockpit must show the L2/L3 ownership split')
assert(workbench.includes('candidate gate, not current prod artifact'), 'Candidate release panel must clarify it is not judging the already-serving prod artifact')
assert(workbench.includes('Candidate vs current champion'), 'Candidate release readiness must expose the selected candidate artifact against the current champion baseline')
assert(workbench.includes('evaluation_pending') && workbench.includes('no completed evaluation run'), 'Research state diagnostics must explain evaluation_pending root cause')
assert(workbench.includes('needs_attention') && workbench.includes('evidence is incomplete'), 'Research state diagnostics must explain needs_attention root cause')
assert(workbench.includes('Artifact compare'), 'Evidence table must show candidate-vs-champion artifact comparison instead of duplicating PBO/CPCV')
assert(workbench.includes('registry, dataset, pointer, candidate compare, promotion pressure, and missing evidence'), 'Model Pool cockpit must show dataset, pointer, candidate compare, promotion pressure, and missing evidence in the evidence table')
assert(!workbench.includes(['Snapshot', 'of the active-9 evidence chain'].join(' ')), 'Model Pool cockpit must remove the unclear snapshot copy')

for (const id of ['TabM', 'GNN', 'iTransformer', 'TimesFM']) {
  assert(track.includes(`id: '${id}'`), `${id} must be listed as production_slot_member`)
  assert(workbench.includes(id), `${id} must appear in the L3 model cockpit`)
}
assert(track.includes('TimesFM 2.5 L3 active slot'), 'TimesFM production slot must be labeled as TimesFM 2.5')
assert(!track.includes("id: 'TimesFM25'"), 'TimesFM25 migration benchmark must not appear as a visible active-flow candidate')

for (const retired of ['FT-Transformer', 'FTTransformer', 'Chronos', 'Chronos2ZeroShot', 'Chronos2LoRA']) {
  assert(track.includes(`'${retired}'`), `${retired} must be documented in the retired model list`)
}

assert(track.includes('MODEL_POOL_RESEARCH_SHADOW_MODEL_IDS'), 'ResidualMLP must be documented as research shadow, not retired alpha')
assert(track.includes("'ResidualMLP'"), 'ResidualMLP research shadow id must stay visible to taxonomy readers')
assert(!track.includes("id: 'ResidualMLP'"), 'ResidualMLP must not be a visible production candidate')
assert(!track.includes("id: 'Chronos2ZeroShot'"), 'Chronos2ZeroShot must not be a visible production candidate')
assert(!track.includes("id: 'Chronos2LoRA'"), 'Chronos2LoRA must not be a visible production candidate')
assert(track.includes('production_slot_member'), 'L3 targets must be formal production slots')
assert(!track.includes('benchmark-only'), 'L3 target candidates must not be described as benchmark-only')
assert(track.includes('formal L3 slot wiring'), 'TimesFM evidence must require formal L3 slot wiring')
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
