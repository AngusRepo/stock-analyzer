import type { SchedulerJob } from './api'

export const FINLAB_STAGE_CARDS = [
  { id: 'finlab-acquire', phase: 'acquire', label: 'FinLab 資料取得', description: '取得所需來源與必要格式整理' },
  { id: 'finlab-validate', phase: 'validate', label: 'FinLab 整理與驗證', description: '跨資料集完整性驗證與推論輸入組合' },
  { id: 'finlab-publish', phase: 'publish', label: 'FinLab 發布與交接', description: 'GCS 保存、canonical／runtime 寫入與完成回呼' },
] as const
export const expandFinlabStages = (id: string): string[] => id === 'finlab-v4-backfill'
  ? FINLAB_STAGE_CARDS.map(card => card.id) : [id]
const duration = (ms: number) => `${Math.floor(ms / 60000)} 分 ${Math.floor(ms / 1000) % 60} 秒`

export function finlabStageCards(parent?: SchedulerJob, now = Date.now()): SchedulerJob[] {
  if (!parent) return []
  const p = parent.finlabProgress
  const progress = p?.run_id === parent.runId && p?.run_date === parent.statusRunDate ? p : null
  // A stage receipt describes the selected run only; never inherit a parent's timer.
  return FINLAB_STAGE_CARDS.map(card => {
    const row = progress?.phases.find(r => r.phase === card.phase)
    const parentTerminal = ['success','failed','skip'].includes(parent.lastStatus)
    const staleRunning = row?.status === 'running' && parentTerminal
    const lastStatus: SchedulerJob['lastStatus'] = !row ? 'waiting' : staleRunning
      ? parent.lastStatus === 'failed' ? 'failed' : 'waiting'
      : row.status === 'completed' ? 'success' : row.status === 'failed' ? 'failed' : row.status
    const summary = !progress ? '無階段紀錄；不能由總狀態推定子階段成功或耗時'
      : !row ? '等待前一階段完成' : staleRunning ? '父工作已結束，未收到此階段終態紀錄'
        : row.status === 'waiting' ? '發布完成回呼尚未確認' : card.description
    return { ...parent, id: card.id, name: card.label, finlabPhase: card.phase,
      lastStatus, lastRun: row?.started_at ?? 'N/A', lastRunAt: row?.started_at ?? null,
      lastRunBasis: 'started', lastAttemptAt: row?.started_at ?? null,
      lastEffectiveRunAt: null, lastEffectiveStatus: undefined, lastAttemptStatus: undefined,
      lastDuration: row?.elapsed_ms != null ? duration(row.elapsed_ms)
        : row?.status === 'running' && !staleRunning ? `${duration(Math.max(0, now-Date.parse(row.started_at)))}（進行中）` : 'N/A',
      durationConcern: null, durationConcernReason: undefined, recoveredFromStatus: null,
      lastError: lastStatus === 'failed' ? parent.lastError ?? summary : undefined,
      summary, details: [...new Set([card.description, summary])], displayNote: summary,
      history7d: [], rate7d: 'N/A', nextRun: '隨同一 FinLab run 執行',
      accounting: { ...parent.accounting, task: card.id, physicalRoot: false, ticketRequired: false },
      ticket: { ...parent.ticket, logicalTask: card.id, status: lastStatus, missing: !row },
    }
  })
}
