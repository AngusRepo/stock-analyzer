export const L4_FEATURE_SCHEMA = 'full-l3-30-all-available-signals-v3'
export const L4_ACCEPTANCE_CHECKS = [
  'native_feature_parity','purged_labels','same_pool','same_calendar','same_costs',
  'same_risk_constraints','legal_share_accounting','partial_fills','unfilled_exposure_reserved',
  'hard_risk_exits','veto_replan_retry','no_score_v2_reselection','no_top_k','end_to_end_execution',
  'native_l3_input_contract_complete','allocator_risk_mechanism_parity',
  'opb_nonstationary_reward_parity','opb_action_space_parity','full_pool_runtime_budget',
  'native_l3_baseline_preserved','incremental_comparison_contract',
] as const

/** Worker admission check. Python verifies the complete evidence/checksum contract. */
export function l4ReleaseEvidenceError(artifact: any): string | null {
  const r=artifact?.release, receipt=r?.validation_receipt
  const hex=(v:unknown)=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v)
  const number=(v:unknown):v is number=>typeof v==='number' && Number.isFinite(v)
  if (r?.scope!=='paper' || r?.decision!=='PASS' || r.model_checksum!==artifact.model_checksum
      || !hex(r.validation_receipt_checksum) || !receipt || receipt.model_checksum!==artifact.model_checksum
      || receipt.schema_version!=='l4-paper-acceptance-v1') return 'l4_release_evidence_missing'
  if (receipt.checks?.native_l3_baseline_preserved!==true || receipt.checks?.incremental_comparison_contract!==true)
    return 'l4_release_design_repair_evidence_missing'
  if (artifact.feature_schema!==L4_FEATURE_SCHEMA || receipt.feature_schema!==L4_FEATURE_SCHEMA)
    return 'l4_release_feature_schema_mismatch'
  if (L4_ACCEPTANCE_CHECKS.some(key=>receipt.checks?.[key]!==true))
    return 'l4_release_engineering_evidence_incomplete'
  const mode=receipt.acceptance_mode ?? 'comparative_promotion'
  if (r.acceptance_mode!==mode) return 'l4_release_mode_mismatch'
  if (mode==='paper_experiment') {
    const grant=receipt.experiment_authorization
    return r.efficacy_status==='unproven' && receipt.efficacy_status==='unproven'
      && grant?.approved===true && grant.scope==='paper' && grant.model_checksum===artifact.model_checksum
      && typeof grant.source_reference==='string' && grant.source_reference.trim()
      ? null : 'l4_release_experiment_authorization_missing'
  }
  if (mode!=='comparative_promotion') return 'l4_release_mode_invalid'
  const c=receipt.paired_account_comparison, protocol=c?.protocol
  if (c?.schema_version!=='l4-paired-incremental-comparison-v2' || c.complete!==true || c.passes!==true
      || c.candidate_model_checksum!==artifact.model_checksum
      || protocol?.scope!=='paired_native_paper_execution' || protocol.holdout_usage!=='untouched_after_selection'
      || protocol.preselection!==false || !Array.isArray(protocol.signal_dates) || !protocol.signal_dates.length
      || !(protocol.selection_frozen_before<protocol.signal_dates[0])
      || !(artifact.training_label_known_max<protocol.signal_dates[0])) return 'l4_release_incremental_comparison_missing'
  const shared=['pool_checksum','calendar_checksum','initial_account_checksum','costs_checksum','risk_constraints_checksum','market_data_checksum']
  const allocator=['allocator_checksum','opb_protocol_checksum','execution_checksum']
  const runs=c.runs, base=runs?.candidate, native=runs?.l3_same_allocator
  if (!base || !native || !runs.incumbent || base.model_checksum!==artifact.model_checksum
      || native.prediction_policy!=='native_l3_mean_no_correction'
      || native.l3_identity_checksum!==c.l3_identity_checksum || base.l3_identity_checksum!==c.l3_identity_checksum
      || allocator.some(k=>!hex(base[k]) || native[k]!==base[k])) return 'l4_release_native_l3_comparison_mismatch'
  const returns:Record<string,number>={}, drawdowns:Record<string,number>={}
  for (const role of ['candidate','incumbent','l3_same_allocator']) {
    const run=runs[role], curve=run?.daily_nav
    if (run?.complete!==true || run.accounting!=='cash_plus_marked_holdings_after_costs'
        || run.external_cash_flows!=='none' || !hex(run.ledger_checksum) || !hex(run.model_checksum)
        || !number(run.initial_nav) || run.initial_nav<=0 || run.initial_nav!==base.initial_nav
        || shared.some(k=>!hex(run[k]) || run[k]!==base[k])
        || !Array.isArray(curve) || !curve.length
        || JSON.stringify(curve.map((p:any)=>p.date))!==JSON.stringify(base.daily_nav?.map((p:any)=>p.date)))
      return 'l4_release_account_comparison_mismatch'
    let peak=run.initial_nav, maxDrawdown=0, last=run.initial_nav, prior=''
    for (const row of curve) {
      if (!number(row.nav) || row.nav<=0 || !number(row.cash) || !number(row.holdings_market_value)
          || row.holdings_market_value<0 || typeof row.date!=='string' || row.date<=prior
          || Math.abs(row.nav-row.cash-row.holdings_market_value)>Math.max(1e-8,row.nav*1e-10))
        return 'l4_release_nav_accounting_invalid'
      prior=row.date;last=row.nav;peak=Math.max(peak,last);maxDrawdown=Math.max(maxDrawdown,1-last/peak)
    }
    returns[role]=last/run.initial_nav-1;drawdowns[role]=maxDrawdown
    if (!number(c.metrics?.[role]?.net_return) || Math.abs(c.metrics[role].net_return-returns[role])>1e-12
        || !number(c.metrics?.[role]?.max_drawdown) || Math.abs(c.metrics[role].max_drawdown-maxDrawdown)>1e-12)
      return 'l4_release_reported_metric_mismatch'
  }
  if (!protocol.signal_dates.every((day:string)=>base.daily_nav.some((row:any)=>row.date===day))) return 'l4_release_calendar_mismatch'
  if (!number(protocol.max_allowed_drawdown) || protocol.max_allowed_drawdown<0 || protocol.max_allowed_drawdown>1
      || drawdowns.candidate>protocol.max_allowed_drawdown || returns.candidate<=returns.incumbent
      || returns.candidate<=returns.l3_same_allocator) return 'l4_release_no_incremental_benefit'
  return null
}
