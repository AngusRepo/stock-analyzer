import type { PendingBuyStateItem, PendingBuyStateSummary } from './pendingBuyStateSummary'
import { extractPartialFillRemaining, type PendingBuyExecutionStatus } from './pendingBuyExecutionState'

interface BriefingPendingBuy extends PendingBuyStateItem {
  name?: string | null
  ml_entry_price?: number | null
  ml_stop_loss?: number | null
  debate_verdict?: string | null
  watch_points?: string[] | null
}

function firstBusinessWatchPoint(points: string[] | null | undefined): string | null {
  const point = (points ?? []).find((item) => !item.startsWith('execution:'))
  return point ?? null
}

export function formatPendingBuyBriefing(
  items: BriefingPendingBuy[],
  state: PendingBuyStateSummary,
): string {
  const exec = state.execution_counts
  const header = `**${state.label}** | active ${state.active_count}/${state.total_count} | filled ${exec.filled} | skipped ${exec.skipped} | cancelled ${exec.cancelled} | expired ${exec.expired} | rejected ${exec.rejected}`

  if (!items.length) {
    if (state.state === 'closed') return `${header}\n今日候選已全部收斂，請以 execution 結果與 intraday log 為準。`
    if (state.state === 'error') return `${header}\n狀態異常：${state.error_message ?? 'unknown error'}`
    if (state.state === 'halted') return `${header}\n風控暫停，今日不建立新進場。`
    return `${header}\n目前沒有 active pending buy。`
  }

  const rows = items.map((item) => {
    const verdict = item.debate_verdict ?? 'PENDING'
    const execution = item.execution_status ?? 'pending'
    const watch = firstBusinessWatchPoint(item.watch_points)
    const price = `entry ${item.ml_entry_price ?? 'N/A'} | stop ${item.ml_stop_loss ?? 'N/A'}`
    const watchText = watch ? ` | watch: ${watch}` : ''
    const partial = extractPartialFillRemaining({
      symbol: item.symbol,
      execution_status: item.execution_status as PendingBuyExecutionStatus | null | undefined,
      watch_points: item.watch_points ?? undefined,
    })
    const partialText = partial ? ` | partial ${partial.filled}/${partial.requested}, remaining ${partial.remaining}` : ''
    return `- **${item.symbol} ${item.name ?? ''}** | ${price} | debate ${verdict} | exec ${execution}${partialText}${watchText}`
  })

  return [header, ...rows].join('\n')
}
