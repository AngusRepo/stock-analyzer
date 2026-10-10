export const SINGLE_B_TABPACK = 'single_b_tabpack_v1' as const
export const SINGLE_B_FULL_MLP_MEDIAN = 'single_b_full_mlp_median_v1' as const
export const SINGLE_B_TABPACK_CORE16_MEDIAN = 'single_b_tabpack_core16_median_v1' as const
export type SingleBMode = typeof SINGLE_B_TABPACK | typeof SINGLE_B_FULL_MLP_MEDIAN | typeof SINGLE_B_TABPACK_CORE16_MEDIAN
export const MLP_MEDIAN_SCHEMA = 'l4-three-head-residual-mlp-median-v1'

export function isSingleBMode(mode: unknown): mode is SingleBMode {
  return mode === SINGLE_B_TABPACK || mode === SINGLE_B_FULL_MLP_MEDIAN || mode === SINGLE_B_TABPACK_CORE16_MEDIAN
}

/** Structural admission; the Controller also verifies every weight/checksum. */
export function validSingleBModel(policy: any): boolean {
  if (!isSingleBMode(policy?.operating_mode) || policy.strategy_role !== 'B' || policy.scope !== 'paper') return false
  const model = policy.artifact?.model
  if (policy.operating_mode === SINGLE_B_TABPACK_CORE16_MEDIAN) {
    return model?.residual_mlp == null && validTabPackMedian(model?.residual_tabpack)
  }
  if (policy.operating_mode === SINGLE_B_TABPACK) {
    return model?.residual_mlp == null && ['l4-three-head-residual-tabpack-v1', 'l4-three-head-residual-tabpack-official-v2']
      .includes(model?.residual_tabpack?.schema_version)
  }
  const m = model?.residual_mlp
  const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  return model?.residual_tabpack == null && m?.schema_version === MLP_MEDIAN_SCHEMA
    && m.aggregation === 'median_residual_per_symbol' && m.residual_multiplier === 1
    && m.missing_member_policy === 'fail_closed' && hex(m.payload_checksum) && hex(m.anchor_model_checksum)
    && Array.isArray(m.members) && JSON.stringify(m.members.map((v: any) => v.seed)) === '[42,43,44]'
    && m.members.every((v: any) => ['l4-three-head-residual-mlp-v1','l4-three-head-residual-mlp-weights-v2'].includes(v.model?.schema_version)
      && v.model.inputs === 34 && v.model.width === 128 && v.model.blocks === 3
      && v.model.anchor_model_checksum === m.anchor_model_checksum && hex(v.model.payload_checksum)
      && (v.model.schema_version !== 'l4-three-head-residual-mlp-weights-v2' || (v.model.state == null
        && hex(v.model.weights?.sha256) && v.model.weights.path === `l4_distribution/mlp_weights/${v.model.weights.sha256}.npz`
        && Number.isSafeInteger(v.model.weights.bytes) && v.model.weights.bytes > 0 && v.model.weights.bytes <= 4*1024*1024))
      && v.provenance?.seed === v.seed && ['checkpoint_sha256', 'training_receipt_sha256', 'partition_sha256']
        .every(k => hex(v.provenance[k])))
}

export function primaryModelLabel(mode: unknown): string {
  if (mode === SINGLE_B_TABPACK_CORE16_MEDIAN) return 'TabPack median（官方核心16 × 3 seeds）'
  return mode === SINGLE_B_FULL_MLP_MEDIAN ? 'Full MLP median（3 seeds，λ=1）' : 'TabPack'
}

function validTabPackMedian(m: any): boolean {
  const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
  if (m?.schema_version !== 'l4-three-head-tabpack-core16-median-v1'
      || m.training_recipe !== 'three-head-oof-tabpack-official-core16-median-v1'
      || m.aggregation !== 'median_residual_per_symbol' || m.missing_member_policy !== 'fail_closed'
      || !hex(m.payload_checksum) || !hex(m.anchor_model_checksum) || !Array.isArray(m.members)
      || JSON.stringify(m.members.map((v: any) => v?.seed)) !== '[42,43,44]') return false
  const signatures: string[] = []
  for (const v of m.members) {
    const pack = v?.model, p = pack?.provenance, w = pack?.weights
    if (pack?.schema_version !== 'l4-three-head-residual-tabpack-official-v2'
        || pack.anchor_model_checksum !== m.anchor_model_checksum || !hex(pack.payload_checksum)
        || p?.seed !== v.seed || p.training_recipe !== 'three-head-oof-tabpack-official-core16-v1'
        || p.n_models !== 16 || p.upstream_commit !== '05a89e21b955f12de84889d662e15ca534019aaa'
        || p.selection_rule !== 'official_online_greedy_validation_only'
        || !hex(p.partition_checksum) || !hex(p.source_rows_checksum)
        || !hex(w?.sha256) || p.checkpoint_sha256 !== w.sha256
        || w.path !== `l4_distribution/tabpack_weights/${w.sha256}.npz`
        || !Number.isSafeInteger(w.bytes) || w.bytes <= 0 || w.bytes > 96*1024*1024
        || !Array.isArray(pack.members) || pack.members.length < 1 || pack.members.length > 32
        || !pack.members.every((item: any) => Number.isSafeInteger(item?.member_id)
          && item.member_id >= 0 && item.member_id < 16 && Number.isSafeInteger(item.step) && item.step > 0
          && Number.isSafeInteger(item.depth) && item.depth >= 1 && item.depth <= 4
          && typeof item.weight === 'number' && Number.isFinite(item.weight) && item.weight > 0)
        || typeof pack.residual_mean !== 'number' || !Number.isFinite(pack.residual_mean)
        || typeof pack.residual_scale !== 'number' || !Number.isFinite(pack.residual_scale) || pack.residual_scale <= 0
        || typeof pack.training_label_known_max !== 'string' || pack.training_label_known_max !== m.training_label_known_max) return false
    signatures.push(JSON.stringify([p.partition_checksum, p.source_rows_checksum, pack.residual_mean, pack.residual_scale]))
  }
  return new Set(signatures).size === 1
}
