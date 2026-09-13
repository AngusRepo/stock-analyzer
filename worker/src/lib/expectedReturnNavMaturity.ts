/** Read-only display of the original NAV decision. Never a promotion authority. */
import type { PipelineMaturityStage, PipelineMaturityMetric } from './pipelineDecisionMaturity'
import policy from '../../../ml-controller/services/paired_nav_review_policy.json'

export const EV_NAV_SCHEMA = 'expected-return-candidate-nav-gate-v1'
type Row = Record<string, any>
export type ExpectedReturnNavView = {
  kind: 'paired_nav'; availability: 'available' | 'missing' | 'blocked';
  artifact_id: string | null; artifact_checksum: string | null; source_date: string | null; as_of_date: string | null;
  decision: string | null; reason: string; evaluable_dates: number | null;
  minimum_dates: number; maximum_dates: number; review_id: string | null;
  checkpoint_date: string | null; promotion_allowed: false;
}
const canonical = (v: any): any => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join('')
const finite = (v: any): v is number => typeof v === 'number' && Number.isFinite(v)
const day = (v: any): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v

export async function projectExpectedReturnNavMaturity(stage: PipelineMaturityStage,
  row: Row | undefined, requestedDate: string, queryFailed = false): Promise<void> {
  const owner = stage.id === 'l4' ? 'l4_alpha_ev' : 'allocator_ev_fusion'
  // Safe when projection is refreshed on an already projected stage.
  stage.metrics = stage.metrics.filter(m => !m.key.startsWith('nav_'))
  delete stage.candidate_versions
  const view: ExpectedReturnNavView = { kind: 'paired_nav', availability: 'missing',
    artifact_id: null, artifact_checksum: null, source_date: null, as_of_date: null, decision: null,
    reason: queryFailed ? 'nav_maturity_query_failed' : 'nav_candidate_decision_missing',
    evaluable_dates: null, minimum_dates: policy.minimum_sessions, maximum_dates: policy.final_sessions,
    review_id: null, checkpoint_date: null, promotion_allowed: false }
  if (queryFailed) view.availability = 'blocked'
  let gate: Row | undefined, nav: Row | undefined
  try {
    const stored = row && JSON.parse(row.live_evidence_json)
    if (stored?.schema_version === EV_NAV_SCHEMA) {
      const n = stored.nav_validation
      if (!n || typeof n.decision_payload_json !== 'string') throw Error('nav_maturity_decision_invalid')
      // Hash original Python bytes, not reserialized JS floats / large seeds.
      const original = JSON.parse(n.decision_payload_json)
      const { decision_checksum, decision_payload_json, ...fields } = n
      if (await hash(decision_payload_json) !== decision_checksum
        || JSON.stringify(canonical(original)) !== JSON.stringify(canonical(fields))
        || original.schema_version !== 'paired-nav-candidate-decision-v1'
        || original.owner !== owner || row!.model_name !== owner
        || stored.candidate_artifact_id !== row!.artifact_id || original.candidate_artifact_id !== row!.artifact_id
        || stored.candidate_artifact_checksum !== row!.checksum || original.candidate_checksum !== row!.checksum
        || stored.source_run_date !== row!.source_run_date
        || stored.evaluation_evidence_checksum !== decision_checksum
        || original.policy_checksum !== await hash(JSON.stringify(canonical(policy)))
        || original.minimum_evaluable_dates !== policy.minimum_sessions
        || original.maximum_evaluable_dates !== policy.final_sessions
        || !['PASS', 'HOLD', 'PENDING', 'FAIL'].includes(original.decision)
        || !['PASS', 'HOLD', 'PENDING', 'FAIL'].includes(stored.decision)
        || stored.decision !== (stored.contract_blockers?.some((b: string) => !stored.deferred_contract_blockers?.includes(b)) ? 'FAIL' : original.decision)
        || !Array.isArray(stored.failed_gates)
        || stored.evaluation_unit !== 'original_costed_paired_daily_nav') throw Error('nav_maturity_decision_invalid')
      if (!day(original.as_of_date) || original.as_of_date > requestedDate
        || !day(row!.source_run_date) || row!.source_run_date > original.as_of_date
        || original.checkpoint_as_of_date != null && (!day(original.checkpoint_as_of_date)
          || original.checkpoint_as_of_date > original.as_of_date)) throw Error('nav_maturity_date_invalid')
      for (const key of ['mean_daily_nav_delta', 'holm_adjusted_p', 'review_alpha']) {
        if (original[key] != null && !finite(original[key])) throw Error('nav_maturity_number_invalid')
      }
      const count = original.evaluable_date_count
      if (count != null && (!Number.isSafeInteger(count) || count < 0)) throw Error('nav_maturity_number_invalid')
      if (stored.evaluable_date_count !== (count ?? 0)) throw Error('nav_maturity_count_mismatch')
      if (original.holm_adjusted_p != null && (original.holm_adjusted_p < 0 || original.holm_adjusted_p > 1)
        || original.review_alpha != null && (original.review_alpha <= 0 || original.review_alpha > 1))
        throw Error('nav_maturity_number_invalid')
      gate = stored; nav = original
      Object.assign(view, { availability: 'available', artifact_id: row!.artifact_id,
        artifact_checksum: original.candidate_checksum,
        source_date: row!.source_run_date, as_of_date: original.as_of_date, decision: stored.decision,
        reason: stored.decision !== original.decision ? stored.failed_gates.join('; ') : original.reason,
        evaluable_dates: count ?? null, review_id: original.review_id ?? null,
        checkpoint_date: original.checkpoint_as_of_date ?? null })
    }
  } catch (error) {
    view.availability = 'blocked'
    view.reason = error instanceof Error && error.message.startsWith('nav_maturity_')
      ? error.message : 'nav_maturity_decision_invalid'
  }
  stage.nav_gate = view
  stage.lineage = { ...stage.lineage, artifact_id: view.artifact_id,
    evidence_date: view.as_of_date, data_cutoff_date: view.as_of_date,
    oof_max_date: null, mature_outcome_max_date: null, oof_applicable: false,
    source: 'model_artifact_registry.live_evidence_json.nav_validation',
    evidence_semantics: 'Original paired NAV decision as-of; offline candidate and rolling diagnostics have separate dates below.',
    updated_at: gate ? row?.updated_at ?? null : null, cadence: 'daily', role: 'candidate',
    date_semantic: 'nav_decision_as_of' }
  const source = { scope: 'promotion_gate' as const, availability: view.availability,
    reason_code: view.availability === 'available' ? null : view.reason }
  const metric = (key: string, label: string, value: PipelineMaturityMetric['value'],
    options: Partial<PipelineMaturityMetric> = {}): PipelineMaturityMetric => ({ key, label, value,
      ...source, passed: null, ...options })
  const metrics = [
    metric('nav_gate_decision', '成本後配對 NAV 正式判定', view.decision, { unit: 'status',
      target: 'PASS', comparator: 'eq', passed: view.decision === 'PASS' ? true : view.decision === 'FAIL' ? false : null,
      note: '原始候選判定；PASS 不等於已提交 serving pointer。' }),
    metric('nav_evaluable_dates', '目前比較已核對 NAV 交易日', view.evaluable_dates,
      { unit: 'dates', target: policy.minimum_sessions, comparator: 'gte',
        passed: view.evaluable_dates == null ? null : view.evaluable_dates >= policy.minimum_sessions }),
    metric('nav_mean_delta', '候選減比較基準：平均每日淨報酬', nav?.mean_daily_nav_delta ?? null,
      { unit: 'return', target: 0, comparator: 'gt',
        passed: nav?.mean_daily_nav_delta == null ? null : nav.mean_daily_nav_delta > 0,
        note: '使用原始檢查點的成本後 NAV 報酬；不再扣一次交易成本。' }),
    metric('nav_holm_p', '家族調整後 p 值', nav?.holm_adjusted_p ?? null,
      { unit: 'ratio', target: nav?.review_alpha ?? null, comparator: 'lte',
        passed: nav?.holm_adjusted_p == null || nav?.review_alpha == null ? null : nav.holm_adjusted_p <= nav.review_alpha,
        note: '同一家族完整候選一起比較；這是近似統計證據，不保證獲利。' }),
    metric('nav_as_of_date', 'NAV 決策資料截止日', view.as_of_date, { unit: 'status' }),
    metric('nav_checkpoint_date', '原始統計檢查點日期', view.checkpoint_date, { unit: 'status' }),
    metric('nav_review_id', '原始檢查點', view.review_id, { unit: 'status',
      note: `每日累積；只在預定 ${policy.minimum_sessions}／${policy.final_sessions} 日檢查，不每日重抽到通過。` }),
  ]
  // Legacy EV thresholds remain visible as diagnostics, never a second gate.
  stage.metrics = [...metrics, ...stage.metrics.map(m => m.scope === 'promotion_gate'
    ? { ...m, scope: 'diagnostic' as const, passed: null, target: null,
        label: m.key === 'prospective_gate_decision' ? '原 pre-outcome 規則診斷結果（非現行晉級判定）' : m.label,
        note: m.key.startsWith('prospective_')
          ? `原鎖定候選的 pre-outcome 證據，持續累積；不是 NAV 交易日，不代表 NAV 通過。${m.note ?? ''}`
          : `離線診斷；不是 NAV 正式晉級門檻。${m.note ?? ''}` } : m)]
  stage.blockers = gate ? gate.failed_gates : [view.reason]
  stage.blocker_groups = [{ scope: 'prospective_forward', title: '成本後配對 NAV 正式門檻', blockers: stage.blockers },
    ...(stage.blocker_groups ?? []).filter(g => ['serving_pointer', 'frozen_forward', 'runtime_guard'].includes(g.scope))]
  if (stage.status !== 'serving') stage.status = view.availability === 'blocked' ? 'blocked'
    : view.availability === 'missing' ? 'unavailable' : view.decision === 'PASS' ? 'ready'
      : view.decision === 'FAIL' ? 'failed_quality' : 'collecting'
  stage.progress = view.evaluable_dates == null ? null : { current: view.evaluable_dates,
    required: policy.minimum_sessions, remaining: Math.max(0, policy.minimum_sessions - view.evaluable_dates),
    ratio: Math.min(1, view.evaluable_dates / policy.minimum_sessions), unit: 'dates',
    complete: view.evaluable_dates >= policy.minimum_sessions }
  stage.decision = `${stage.status === 'serving' ? '現行 artifact 仍正式服務；' : ''}候選 NAV ${view.decision ?? 'MISSING'}；`
    + `${view.evaluable_dates == null ? '成熟日數尚未具備' : `已核對 ${view.evaluable_dates} 日`}。每日累積，${policy.minimum_sessions}／${policy.final_sessions} 日審查。`
  if (row && gate) stage.version = row.version
  if (stage.status !== 'serving') stage.production_effect =
    '候選累積成本後配對 NAV 證據；只有原始發布流程驗證並提交 pointer 後才影響正式配置。'
}
