/** Published model identity (eight-model active8 orders or an R33 roster); a research artifact never replaces a slot. */
export const LEGACY_ALPHA_MODELS = ['LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer'] as const
export const TIMEXER_ALPHA_MODELS = LEGACY_ALPHA_MODELS.map(name => name === 'DLinear' ? 'TimeXer' : name)
/** An R33 roster: non-empty, no repeats, TimeXer slot order, no DLinear, no XGBoost (retired, Q5); no minimum
 *  size (Wei 2026-11-12 Q3). Same rule as alpha_model_roster.validate_r33_roster: the published object owns the
 *  roster, not a constant. The full eight-model orders stay valid through validateAlphaModelOrder only. */
export function isR33AlphaModelOrder(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.length || value.includes('XGBoost')) return false
  const canonical = TIMEXER_ALPHA_MODELS.filter(name => value.includes(name))
  return canonical.length === value.length && canonical.every((name, i) => name === value[i])
}
export function validateAlphaModelOrder(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('alpha_roster_order_invalid')
  const eight = [LEGACY_ALPHA_MODELS, TIMEXER_ALPHA_MODELS].some(order => order.length === value.length && order.every((name, i) => name === value[i]))
  if (!eight && !isR33AlphaModelOrder(value)) throw new Error('alpha_roster_order_invalid')
  return [...value]
}
export function predictionModelOrder(data: any): string[] {
  const declared = data?.ensemble_v2?.model_order ?? data?.active_model_contract
  return declared == null ? [...LEGACY_ALPHA_MODELS] : validateAlphaModelOrder(declared)
}
type PublishedPointerRow = {state:string;production_effect:number;payload_checksum:string;pointer_checksum:string}
function checkedPublishedOrder(row: PublishedPointerRow, innerChecksum: unknown, modelOrder: unknown): string[] {
  if (row.state !== 'production' || row.production_effect !== 1 || row.payload_checksum !== row.pointer_checksum || innerChecksum !== row.payload_checksum) throw new Error('alpha_roster_published_pointer_invalid')
  return validateAlphaModelOrder(modelOrder)
}
export async function publishedAlphaModelOrder(db: D1Database): Promise<string[]> {
  const row = await db.prepare(`SELECT a.payload_json, a.state, a.production_effect, a.payload_checksum, p.payload_checksum AS pointer_checksum FROM active8_ensemble_pointer_v1 p LEFT JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id WHERE p.singleton_id=1`).first<PublishedPointerRow & {payload_json:string}>()
  if (!row) return [...LEGACY_ALPHA_MODELS]
  const payload = JSON.parse(row.payload_json)
  return checkedPublishedOrder(row, payload.payload_checksum, payload.model_order)
}
/** Same check as publishedAlphaModelOrder, but D1 returns only model_order and the inner checksum, not the
 *  whole ensemble payload: for polling readers such as /obs. `->` keeps both as JSON text (json_extract would
 *  unquote a string, so a string-encoded array would parse into an array the full read refuses). */
export const PUBLISHED_ALPHA_MODEL_ORDER_PROJECTED_SQL = `SELECT a.payload_json -> '$.model_order' AS model_order_json, a.payload_json -> '$.payload_checksum' AS inner_payload_checksum_json, a.state, a.production_effect, a.payload_checksum, p.payload_checksum AS pointer_checksum FROM active8_ensemble_pointer_v1 p LEFT JOIN active8_ensemble_artifacts_v1 a ON a.artifact_id=p.artifact_id WHERE p.singleton_id=1`
export async function publishedAlphaModelOrderProjected(db: D1Database): Promise<string[]> {
  const row = await db.prepare(PUBLISHED_ALPHA_MODEL_ORDER_PROJECTED_SQL)
    .first<PublishedPointerRow & {model_order_json:string|null;inner_payload_checksum_json:string|null}>()
  if (!row) return [...LEGACY_ALPHA_MODELS]
  const parsed = (text: string | null) => text == null ? undefined : JSON.parse(text)
  return checkedPublishedOrder(row, parsed(row.inner_payload_checksum_json), parsed(row.model_order_json))
}
