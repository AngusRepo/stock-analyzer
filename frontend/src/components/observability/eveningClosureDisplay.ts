import type { SchedulerJob } from '../../lib/api'

/** Closure is a receipt, not a second copy of the running orchestrator. */
export function eveningClosureDisplay(root: SchedulerJob): SchedulerJob {
  const staleDisplay = /^stale (?:triggered|running):/.test(root.lastError ?? '')
  const terminal = root.lastStatus === 'success' && !staleDisplay
  const interrupted = !staleDisplay && ['failed', 'blocked'].includes(root.lastStatus)
  const status = interrupted ? 'blocked' : terminal ? root.lastStatus : 'waiting'
  return {
    ...root, id: 'evening-closure', name: '全鏈完成收據',
    lastStatus: status,
    lastRun: terminal ? root.lastRun : 'N/A',
    lastRunAt: terminal ? root.lastRunAt : null,
    lastDuration: terminal ? root.lastDuration : 'N/A',
    nextRun: interrupted ? '等待阻擋原因排除後接續' : terminal ? root.nextRun : '等待全鏈完成',
    lastError: interrupted || terminal ? root.lastError : undefined,
    summary: interrupted ? `全鏈中止，尚未產生完成收據；${root.summary || root.lastError || '上游未完成'}`
      : terminal ? root.summary : root.lastStatus === 'waiting'
      ? '等待盤前接續及下游驗證完成後，才會產生全鏈收據'
      : '尚未到收尾階段；等待上游與驗證完成',
    displayNote: 'L3 封存是跨夜檢查點；全鏈成功仍須原有驗證與學習收據通過。',
    ticket: { ...root.ticket, logicalTask: 'evening-closure', status },
  }
}
