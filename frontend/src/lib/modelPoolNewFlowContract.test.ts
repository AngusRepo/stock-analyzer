import * as fs from 'node:fs'
import * as path from 'node:path'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = process.cwd()
const pagePath = path.join(root, 'src', 'pages', 'ModelPoolPage.tsx')
const trackPath = path.join(root, 'src', 'lib', 'modelUpgradeTrack.ts')
const workbenchPath = path.join(root, 'src', 'components', 'model-pool', 'ModelPoolNewFlowWorkbench.tsx')

assert(fs.existsSync(workbenchPath), 'ModelPoolNewFlowWorkbench should exist')

const page = fs.readFileSync(pagePath, 'utf8')
const track = fs.readFileSync(trackPath, 'utf8')
const workbench = fs.readFileSync(workbenchPath, 'utf8')
const api = fs.readFileSync(path.join(root, 'src', 'lib', 'api.ts'), 'utf8')

assert(page.includes('ModelPoolNewFlowWorkbench'), 'ModelPool page should render the active model cockpit')
assert(!page.includes('<PromotionQueuePanelV2'), 'ModelPool page should not render one comparison card per promotion-queue artifact')
assert(!workbench.includes('<PromotionReadinessPanel'), 'Candidate-vs-champion comparison should not be duplicated above the Evidence table')
assert(!workbench.includes('5-fold purged OOF'), 'BASE CPCV header must not hard-code a fold count; each cell shows the artifact\'s real folds')
assert(workbench.includes('Evidence table'), 'ModelPool should keep one dense evidence table')
assert(workbench.includes('FULL OOF IC') && workbench.includes('不可直接和 ensemble 尾端 validation IC 比較'), 'Model Pool must distinguish full-window individual OOF IC from later-window ensemble validation')
assert(workbench.includes('V5 serving bundle vs latest retrain'), 'Evidence table should separate the V5 serving bundle from latest retrain evidence')
assert(workbench.includes("readiness === 'validation_failed'"), 'Failed immutable V5 bundle validation must render as an error, not generic missing evidence')
assert(workbench.includes('V5 serving bundle, selected challenger, and latest retrain evidence stay separate; legacy pointers are audit-only'), 'Evidence table should explain that legacy pointers are audit-only')
assert(workbench.includes('row?.oof_full_fit_release_candidate ?? null'), 'Selection must use only the canonical immutable OOF release')
assert(workbench.includes('Active-8 retrain rejected'), 'Rejected latest retrains should remain visible as diagnosis outside production fleet health')
assert(workbench.includes('function v5ServingArtifact') && workbench.includes("pointer?.readiness === 'v5_serving'"), 'Production evidence must require the exact V5 bundle pointer')
assert(!workbench.includes('row?.serving_release_artifact ?? selectionCandidate(row)'), 'Legacy serving pointers must not fall back into V5 production evidence')
assert(workbench.includes('artifact: latestRetrainArtifact'), 'Base CPCV evidence must come from the latest immutable OOF retrain artifact')
assert(workbench.includes('registration.oof_promotion_evidence') && workbench.includes("'model-cpcv-evidence-v1'") && workbench.includes("'outer_purged_walk_forward_rank_ic'"), 'Model Pool must read exact V5 base CPCV from the canonical OOF promotion evidence path')
assert(!workbench.includes('...notBetter.map((row) => String(row.artifact_id'), 'Candidate-not-better history must not be reinserted into the actionable archive queue')
assert(workbench.includes("'待補證據'"), 'Base CPCV missing evidence must be explicit instead of cryptic N/R')
assert(workbench.includes('selection risk：由 V5 ensemble') && !workbench.includes("label: 'PBO/CPCV'"), 'Per-model cells must not misreport missing PBO; selection risk belongs to V5 bundle validation')
assert(workbench.includes('min-w-[300px] whitespace-normal'), 'Artifact comparison heading should reserve enough width and wrap instead of clipping')
assert(workbench.includes('{compare.candidate}') && workbench.includes('{compare.champion}'), 'Artifact comparison rows should render complete candidate and champion identifiers')
assert(!workbench.includes('compactVersion(compare.candidate, 22)') && !workbench.includes('compactVersion(compare.champion, 22)'), 'Artifact comparison identifiers must not be truncated to 22 characters')
assert(workbench.includes('function selectedPromotionRow'), 'ModelPool should reconcile the queue against the selected best artifact')
assert(workbench.includes('row.artifact_id === artifactId') && workbench.includes('row.candidate_version === version'), 'Selected queue evidence should match artifact identity or version')
assert(workbench.includes('promotionRows: promotionRow ? [promotionRow] : []'), 'Each model record should receive at most one selected promotion comparison')
assert(workbench.includes('challenger</dt>') && workbench.includes('V5 bundle</dt>') && workbench.includes('latest retrain</dt>'), 'Evidence table should identify V5 bundle, selected challenger, and latest retrain separately')
assert(workbench.includes('compareMetricDetail(candidateOosIc, championOosIc)') && workbench.includes('compareMetricDetail(latestRetrainOosIc, championOosIc)'), 'Evidence table should expose selected and latest-retrain OOS IC deltas against production')
assert(workbench.includes('candidate_oos_ic') && workbench.includes('champion_oos_ic') && workbench.includes('oos_ic_delta'), 'Comparison should use the canonical OOS IC evidence fields')
assert(workbench.includes('no canonical OOF release candidate is waiting for champion comparison'), 'No-candidate rows should render N/R instead of manufacturing comparisons')
assert(workbench.includes("candidate: candidate ?? 'no selected challenger'"), 'Serving champion must never be relabeled as a challenger when selection is empty')
assert(workbench.includes('latestRetrainArtifact') && workbench.includes('latest retrain only'), 'Rejected latest retrains must remain visible as diagnosis without entering promotion')
assert(workbench.includes('sv-model-pool-readable'), 'Model Pool should use the same readable font stack and minimum type scale as the rest of the system')
assert(!workbench.includes('monthly_release_candidate') && !workbench.includes('weekly_drift_candidate'), 'Legacy monthly/weekly fallback fields must stay absent from the canonical OOF-only UI')
assert(workbench.includes("url.searchParams.set('model', id)"), 'Model selection should remain URL-keyed')

// 2026-11-26: the Worker keeps the last verified controller observation and serves it in two
// halves tied by snapshot id (summary first, evidence by id), replacing the single 5 MB wait.
assert(page.includes('modelPoolApi.workbenchSummary(false)') && page.includes('modelPoolApi.workbenchEvidence(snapshotId!)'), 'ModelPool should paint the summary half first and read evidence of the same snapshot')
assert(page.includes("queryKey: ['model-pool', 'workbench', 'evidence', snapshotId]"), 'Evidence must be keyed by the summary snapshot id')
assert(page.includes('evidenceQuery.data?.snapshot?.id === snapshotId'), 'Evidence from another snapshot must never be combined with the summary')
assert(page.includes('model_pool_snapshot_expired'), 'An expired evidence snapshot should re-read the summary')
assert(page.includes('evidencePending={evidencePending}'), 'Workbench should mark evidence cells as loading instead of rendering missing evidence')
assert(!page.includes('refetchInterval: 60_000'), 'Independent query intervals should not stagger the UI')
assert(!page.includes('window.setInterval'), 'ModelPool should not poll while the page remains mounted')
assert((page.match(/refetchOnMount: 'always'/g) ?? []).length === 2 && page.includes('MODEL_POOL_SUMMARY_KEY') && page.includes("queryKey: ['strategy-lab', 'model-upgrade-status']"), 'Summary and upgrade status refresh once whenever ModelPool mounts')
assert(page.includes('modelPoolApi.workbenchSummary(true)') && page.includes('modelUpgradeStatus.refetch()'), 'Manual refresh must request a new controller observation and refetch upgrade status')
assert(page.includes('summary?.snapshot?.stale') && page.includes('revalidatedSnapshot.current === snapshotId'), 'A stale cached snapshot is revalidated once per snapshot, not polled')
assert(page.includes('modelPoolApi.workbenchRevalidate(snapshotId)') && api.includes('&revalidate=${encodeURIComponent(staleSnapshotId)}'), 'The background refresh of a stale snapshot is a revalidate request, distinct from an explicit fresh observation')
assert(page.includes("const inlineEvidence = summary && ('selection' in summary || 'promotion_queue' in summary)") && page.includes('enabled: Boolean(snapshotId) && !inlineEvidence'), 'A degraded or pre-split Worker answer carries its evidence inline and must render it')
assert(page.includes('if (generation === refreshGeneration.current) queryClient.setQueryData(MODEL_POOL_SUMMARY_KEY, next)'), 'An older refresh answering later must not replace the newer summary')
assert(page.includes('const refreshing = refreshesInFlight > 0'), 'Refreshing tracks every request in flight, not the first one to finish')
assert(page.includes('summary?.snapshot?.degraded'), 'A degraded observation shows a small marker')
// Site rule: no folded sections; content is shown directly.
assert(!page.includes('<details') && !workbench.includes('<details'), 'Model Pool must not hide content behind <details>')
assert(page.includes('onClick={refreshModelPoolSnapshot}') && page.includes('> Refresh'), 'ModelPool should retain explicit manual snapshot refresh')
assert(page.includes('onSuccess: async () =>') && page.includes('await refreshModelPoolSnapshot()'), 'Promotion success should refresh the complete model-pool snapshot')
assert(page.includes('!isRetiredModelName(name)'), 'Retired models should stay outside the main evidence table')
assert(!page.includes('Auto promote pointer'), 'Automatic promotion should not expose a manual auto-promote button')

for (const id of ['TabM', 'GNN', 'iTransformer']) {
  assert(track.includes(`id: '${id}'`), `${id} should remain a production L3 slot`)
  assert(workbench.includes(id), `${id} should remain visible in the model cockpit`)
}
assert(track.includes("id: 'TimesFM'") && track.includes("stage: 'l2_feature_sidecar_member'"), 'TimesFM should remain an L2 feature sidecar')
assert(track.includes('MODEL_POOL_RETIRED_MODEL_IDS'), 'Retired model taxonomy should remain explicit')

for (const token of ['\ueec4', '\uef3e', '\uea57']) {
  assert(!page.includes(token), `ModelPoolPage should not contain mojibake token ${token}`)
  assert(!workbench.includes(token), `ModelPoolNewFlowWorkbench should not contain mojibake token ${token}`)
}

console.log('modelPoolNewFlowContract: OK')
