/** Worker structural admission; Controller owns byte/checksum and ancestry verification. */
export const P6_MODEL_SCHEMA = 'l4-p6-direct-excess-model-v1'
export const P6_RECIPE = 'p6-a-direct-excess-pure8-ploss-fourfold-v1'
const hex = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
export const isP6Model = (a: any): boolean => a?.model?.schema_version === P6_MODEL_SCHEMA
export function validP6Structure(a: any): boolean {
  const m=a?.model
  return isP6Model(a) && m.recipe_version===P6_RECIPE
    && m.expected_return_semantic==='five_session_relative_pool_decimal'
    && ['raw','linear'].includes(m.calibration_kind)
    && !['heads','residual_tabpack','residual_mlp','A','gain','loss'].some(k=>k in m)
    && Array.isArray(m.seeds) && JSON.stringify(m.seeds.map((s:any)=>s.seed))==='[42,43,44]'
    && m.seeds.every((s:any)=>s.phase==='final' && s.training_completed===true && s.recipe===P6_RECIPE
      && s.outer_rows===0 && s.promoted===false && hex(s.weights?.sha256)
      && typeof s.weights.path==='string' && s.weights.path.startsWith('l4_distribution/p6_batches/'))
    && m.frozen_p_loss?.model?.head?.head==='p_loss' && hex(m.frozen_p_loss_sha256)
    && m.calibration?.schema_version==='p6-frozen-oof-calibration-v1'
    && m.calibration.outer_updates_allowed===false && m.calibration.outer_data_used===false
    && m.calibration.refit_predictions_used===false && finite(m.calibration.linear_b)
}
export const P6_ADDITIONAL_CHECKS = [
  'p6_direct_excess_no_A','p6_frozen_full_pool_calibration','p6_final_checkpoint_lineage',
  'morning_nine_day_deadline','morning_no_nav_or_research','nav_five_day_reconciliation',
  'shadow_accounts_cross_day','timesfm_nine_day_output_parity',
  'forward_counterfactual_and_exit_events','timexer_daily_status',
  'unique_deployment_owner','current_prod_rollback',
] as const
export function p6ReleaseEvidenceError(a:any, legacyChecks:readonly string[]):string|null {
  const r=a.release, receipt=r.validation_receipt, m=a.model, inner=m.inner_report
  const checks=[...legacyChecks.filter(k=>!['native_l3_baseline_preserved','incremental_comparison_contract'].includes(k)),...P6_ADDITIONAL_CHECKS]
  if (checks.some(k=>receipt.checks?.[k]!==true)) return 'p6_release_engineering_evidence_incomplete'
  const grant=receipt.experiment_authorization
  if (r.acceptance_mode!=='p6_r32_paper' || receipt.acceptance_mode!==r.acceptance_mode
      || r.efficacy_status!=='inner_only_outer_unproven' || receipt.efficacy_status!==r.efficacy_status
      || grant?.scope!=='paper' || grant.approved!==true || grant.model_checksum!==a.model_checksum
      || typeof grant.source_reference!=='string' || !grant.source_reference.trim()
      || !hex(receipt.source_evidence_checksum) || !hex(receipt.l3_identity_checksum)
      || receipt.l3_identity_checksum!==r.l3_identity_checksum
      || !hex(inner?.checksum) || receipt.inner_report_checksum!==inner.checksum)
    return 'p6_release_authorization_missing'
  const top=inner.metrics?.all?.top5_excess_pp?.mean
  const high=m.calibration.realized_bins?.filter((v:any)=>v.bin>=6)
  if (inner.schema_version!=='p6-inner-validation-r32-v1' || inner.evidence_scope!=='inner_development_only'
      || inner.outer_credit!==0 || inner.champion_B_gate?.status!=='pass'
      || !finite(top) || top<=0 || !Array.isArray(high) || high.length!==3
      || JSON.stringify(high.map((v:any)=>v.bin).sort())!=='[6,7,8]'
      || high.some((v:any)=>!finite(v.mean) || v.mean<=0)
      || !hex(m.calibration.checksum) || m.calibration.checksum!==inner.calibration?.checksum)
    return 'p6_release_inner_gate_failed'
  return null
}
