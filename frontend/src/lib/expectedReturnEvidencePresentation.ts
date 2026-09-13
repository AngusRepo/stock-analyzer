import type { PipelineMaturityStage } from './pipelineMaturityContract'

/** Display-only: never convert cross-sectional dates into NAV sessions. */
export function preoutcomeSummary(stage: PipelineMaturityStage): string | null {
  if (!stage.nav_gate || !['l4', 'fusion'].includes(stage.id)) return null
  const metrics = new Map(stage.metrics.map(metric => [metric.key, metric]))
  const availableValue = (key: string) => {
    const metric = metrics.get(key)
    return metric?.availability === 'available' ? metric.value : null
  }
  const count = availableValue('prospective_evaluable_dates')
  const latest = availableValue('prospective_prediction_max_date')
  const countLabel = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
    ? `${count} 日` : '尚無可驗證日數'
  return `原鎖定候選 pre-outcome：已成熟 ${countLabel} · 最新成熟預測日 ${typeof latest === 'string' ? latest : '尚無'}。與 NAV 分開累積，不換算為 NAV 日數。`
}

export function navReadinessReason(reason: string): string {
  if (reason === 'nav_candidate_not_registered') {
    return '尚未註冊 NAV 配對候選，尚未開始配對累積；不是原 pre-outcome 資料被清空。'
  }
  return reason
}
