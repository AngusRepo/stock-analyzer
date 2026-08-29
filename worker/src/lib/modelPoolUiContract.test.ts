import * as fs from 'node:fs'
import * as path from 'node:path'

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const root = path.join(process.cwd(), '..')
const frontend = path.join(root, 'frontend', 'src')
const page = fs.readFileSync(path.join(frontend, 'pages', 'ModelPoolPage.tsx'), 'utf8')
const api = fs.readFileSync(path.join(frontend, 'lib', 'api.ts'), 'utf8')
const workbench = fs.readFileSync(
  path.join(frontend, 'components', 'model-pool', 'ModelPoolNewFlowWorkbench.tsx'),
  'utf8',
)
const dashboardReadRoutes = fs.readFileSync(
  path.join(root, 'worker', 'src', 'routes', 'dashboardReadRoutes.ts'),
  'utf8',
)
const registry = fs.readFileSync(
  path.join(root, 'ml-controller', 'services', 'model_artifact_registry.py'),
  'utf8',
)
const migration = fs.readFileSync(
  path.join(root, 'worker', 'domain-migrations', 'learning', '0032_active8_ensemble_validation_attempts.sql'),
  'utf8',
)

assert(page.includes('ModelPoolNewFlowWorkbench'), 'Model Pool must render the canonical V5 cockpit')
assert(page.includes('ModelPoolWorkbenchSnapshot'), 'Model Pool must hydrate one complete evidence snapshot')
assert(page.includes('Promise.allSettled'), 'Model Pool evidence feeds must refresh together')
assert(!page.includes('<PromotionQueuePanelV2'), 'Legacy per-artifact promotion queue must stay retired')

assert(workbench.includes('V5 serving bundle vs latest retrain'), 'Model Pool must separate serving bundle from retrain evidence')
assert(workbench.includes('row?.oof_full_fit_release_candidate ?? null'), 'Base evidence must use immutable OOF releases only')
assert(workbench.includes("readiness === 'validation_failed'"), 'Failed V5 bundle validation must be explicit')
assert(!workbench.includes('row?.serving_release_artifact ?? selectionCandidate(row)'), 'Legacy serving pointers must not enter V5 evidence')

assert(api.includes('latest_validation_attempt?:'), 'Frontend API must expose the immutable validation attempt')
assert(api.includes('production_effect: false'), 'Validation attempts must be observation-only')
assert(registry.includes('latest_validation_attempt'), 'Model registry read model must expose the latest failed attempt')
assert(registry.includes('"status": "validation_failed"'), 'Missing serving pointer must distinguish validation failure')
assert(migration.includes('active8_ensemble_validation_attempts_v1'), 'Learning D1 must own immutable validation attempts')
assert(migration.includes('production_effect = 0'), 'Validation attempts must never affect serving')

for (const route of [
  '/api/model-pool/artifact_registry',
  '/model_pool/artifact_registry/selection',
  '/model_pool/artifact_registry/promotion_queue',
  '/model_pool/artifact_registry/promotion_controller',
  '/model_pool/artifact_registry/champion_pointers',
]) {
  assert(dashboardReadRoutes.includes(route), `Worker proxy route missing: ${route}`)
}

console.log('modelPoolUiContract: OK')
