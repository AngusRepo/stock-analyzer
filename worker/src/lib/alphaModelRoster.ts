/** Published eight-model identity; a research artifact never replaces a slot. */
export const LEGACY_ALPHA_MODELS = ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer'] as const
export const TIMEXER_ALPHA_MODELS = LEGACY_ALPHA_MODELS.map(name => name === 'DLinear' ? 'TimeXer' : name)
export function validateAlphaModelOrder(value: unknown): string[] {
  if (!Array.isArray(value) || ![LEGACY_ALPHA_MODELS, TIMEXER_ALPHA_MODELS].some(order => order.length === value.length && order.every((name, i) => name === value[i]))) throw new Error('alpha_roster_requires_exactly_eight_models')
  return [...value]
}
export function predictionModelOrder(data: any): string[] {
  const declared = data?.ensemble_v2?.model_order ?? data?.active_model_contract
  return declared == null ? [...LEGACY_ALPHA_MODELS] : validateAlphaModelOrder(declared)
}
export async function publishedAlphaModelOrder(db: D1Database): Promise<string[]> {
  const row = await db.prepare(`SELECT a.payload_json, a.state, a.production_effect, a.payload_checksum, p.payload_checksum AS pointer_checksum FROM active8_ensemble_pointer_v1 p LEFT JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id WHERE p.singleton_id=1`).first<{payload_json:string;state:string;production_effect:number;payload_checksum:string;pointer_checksum:string}>()
  if (!row) return [...LEGACY_ALPHA_MODELS]
  const payload = JSON.parse(row.payload_json)
  if (row.state !== 'production' || row.production_effect !== 1 || row.payload_checksum !== row.pointer_checksum || payload.payload_checksum !== row.payload_checksum) throw new Error('alpha_roster_published_pointer_invalid')
  return validateAlphaModelOrder(payload.model_order)
}
