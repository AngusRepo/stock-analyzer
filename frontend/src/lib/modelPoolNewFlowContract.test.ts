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

assert(page.includes('ModelPoolNewFlowWorkbench'), 'ModelPool page should render the active model cockpit')
assert(!page.includes('<PromotionQueuePanelV2'), 'ModelPool page should not render one comparison card per promotion-queue artifact')
assert(!workbench.includes('<PromotionReadinessPanel'), 'Candidate-vs-champion comparison should not be duplicated above the Evidence table')
assert(workbench.includes('Evidence table'), 'ModelPool should keep one dense evidence table')
assert(workbench.includes('Best artifact vs champion'), 'Evidence table should name the selected artifact/champion comparison explicitly')
assert(workbench.includes('one selected best artifact per model, compared only with the current champion'), 'Evidence table should explain the one-comparison-per-model rule')
assert(workbench.includes('row?.oof_full_fit_release_candidate ?? null'), 'Selection must use only the canonical immutable OOF release without monthly/weekly fallback')
assert(workbench.includes('Active-8 retrain rejected'), 'Rejected latest retrains should remain visible as diagnosis outside production fleet health')
assert(workbench.includes('row?.serving_release_artifact ?? selectionCandidate(row)'), 'Fleet evidence must prefer the serving champion over a newer challenger')
assert(!workbench.includes('...notBetter.map((row) => String(row.artifact_id'), 'Candidate-not-better history must not be reinserted into the actionable archive queue')
assert(workbench.includes("'待補證據'"), 'PBO/CPCV missing evidence must be explicit instead of cryptic N/R')
assert(workbench.includes('evidence.pbo.max_pbo'), 'PBO threshold must resolve the canonical direct evidence field')
assert(workbench.includes('min-w-[240px] whitespace-normal'), 'Artifact comparison heading should reserve enough width and wrap instead of clipping')
assert(workbench.includes('{compare.candidate}') && workbench.includes('{compare.champion}'), 'Artifact comparison rows should render complete candidate and champion identifiers')
assert(!workbench.includes('compactVersion(compare.candidate, 22)') && !workbench.includes('compactVersion(compare.champion, 22)'), 'Artifact comparison identifiers must not be truncated to 22 characters')
assert(workbench.includes('function selectedPromotionRow'), 'ModelPool should reconcile the queue against the selected best artifact')
assert(workbench.includes('row.artifact_id === artifactId') && workbench.includes('row.candidate_version === version'), 'Selected queue evidence should match artifact identity or version')
assert(workbench.includes('promotionRows: promotionRow ? [promotionRow] : []'), 'Each model record should receive at most one selected promotion comparison')
assert(workbench.includes('candidate</dt>') && workbench.includes('champion</dt>'), 'Evidence table should identify both compared artifacts')
assert(workbench.includes('compareMetricDetail(candidateOosIc, championOosIc)'), 'Evidence table should expose candidate, champion, and delta values')
assert(workbench.includes('candidate_oos_ic') && workbench.includes('champion_oos_ic') && workbench.includes('oos_ic_delta'), 'Comparison should use the canonical OOS IC evidence fields')
assert(workbench.includes('no canonical OOF release candidate is waiting for champion comparison'), 'No-candidate rows should render N/R instead of manufacturing comparisons')
assert(workbench.includes("url.searchParams.set('model', id)"), 'Model selection should remain URL-keyed')

assert(page.includes('ModelPoolWorkbenchSnapshot'), 'ModelPool should render from a complete evidence snapshot')
assert(page.includes('Promise.allSettled'), 'ModelPool refresh should hydrate evidence feeds together')
assert(page.includes('modelPoolSnapshotReady'), 'ModelPool should wait for a complete snapshot')
assert(!page.includes('refetchInterval: 60_000'), 'Independent query intervals should not stagger the UI')
assert(!page.includes('window.setInterval'), 'ModelPool should not poll while the page remains mounted')
assert((page.match(/refetchOnMount: 'always'/g) ?? []).length === 5, 'Each evidence feed should refresh once whenever ModelPool mounts')
assert(page.includes('onClick={refreshModelPoolSnapshot}') && page.includes('> Refresh'), 'ModelPool should retain explicit manual snapshot refresh')
assert(page.includes('onSuccess: async () =>') && page.includes('await refreshModelPoolSnapshot()'), 'Promotion success should refresh the complete model-pool snapshot')
assert(page.includes('!isRetiredModelName(name)'), 'Retired models should stay outside the main evidence table')
assert(!page.includes('Auto promote pointer'), 'Automatic promotion should not expose a manual auto-promote button')
assert(!workbench.includes('monthly_release_candidate') && !workbench.includes('weekly_drift_candidate'), 'Legacy release selection fields must be absent')

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
