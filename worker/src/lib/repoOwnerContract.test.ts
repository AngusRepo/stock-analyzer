const fs = require('fs')
const path = require('path')

export {}

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const repoRoot = path.resolve(process.cwd(), '..')

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
}

const modelStore = readRepoFile('ml-service/app/model_store.py')
const mlServiceModelPool = readRepoFile('ml-service/app/model_pool.py')
const universalTraining = readRepoFile('ml-service/app/universal_training.py')
const controllerModelPool = readRepoFile('ml-controller/routers/model_pool.py')

const legacyFlatArtifactPatterns = [
  /universal\/xgboost\.joblib/,
  /universal\/catboost\.joblib/,
  /universal\/extratrees\.joblib/,
  /universal\/lightgbm\.joblib/,
  /universal\/ft-transformer\.joblib/,
  /universal\/metadata_xgboost\.json/,
  /universal\/metadata_catboost\.json/,
  /universal\/metadata_extratrees\.json/,
  /universal\/metadata_lightgbm\.json/,
  /universal\/metadata_ft-transformer\.json/,
]

assert(modelStore.includes('model_pool.json unavailable'), 'model_store must fail closed when model_pool.json is unavailable')
assert(modelStore.includes('refusing legacy fallback'), 'model_store must explicitly refuse legacy artifact fallback')
assert(!modelStore.includes('Legacy flat-file fallback'), 'model_store must not keep legacy flat-file fallback code')
assert(!modelStore.includes('blob_path = f"universal/{model_name.lower()}.joblib"'), 'model_store must not derive production flat-file model paths')
assert(!modelStore.includes('meta_path = f"universal/metadata_{model_name.lower()}.json"'), 'model_store must not derive production flat-file metadata paths')

assert(universalTraining.includes('_load_active_model_pool_joblib'), 'universal training must load active artifacts through model_pool')
for (const pattern of legacyFlatArtifactPatterns) {
  assert(!pattern.test(universalTraining), `universal_training must not read legacy artifact path: ${pattern}`)
  assert(!pattern.test(controllerModelPool), `ml-controller model_pool router must not expose legacy artifact path: ${pattern}`)
}

assert(controllerModelPool.includes('legacy model artifact migration is disabled'), 'legacy migration route must stay disabled')
assert(mlServiceModelPool.includes('def list_legacy_artifacts()') && mlServiceModelPool.includes('legacy artifact migration is disabled'), 'ml-service legacy migration helpers must fail closed')
