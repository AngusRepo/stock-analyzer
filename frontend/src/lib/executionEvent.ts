export type ExecutionEventKind = 'execution' | 'debate'

export interface StructuredExecutionEvent {
  kind: ExecutionEventKind
  status: string
  reason: string
  detail?: string | null
}

function cleanPart(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, '_')
    .replace(/:/g, '-')
    .trim()
}

export function formatExecutionEvent(event: StructuredExecutionEvent): string {
  const base = `${cleanPart(event.kind)}:${cleanPart(event.status)}:${cleanPart(event.reason)}`
  const detail = cleanPart(event.detail)
  return detail ? `${base}:${detail}` : base
}

export function parseExecutionEvent(raw: string): StructuredExecutionEvent | null {
  const [kind, status, reason, ...detailParts] = raw.split(':')
  if ((kind !== 'execution' && kind !== 'debate') || !status || !reason) return null
  return {
    kind,
    status,
    reason,
    detail: detailParts.length > 0 ? detailParts.join(':') : null,
  }
}

function humanizeReason(reason: string): string {
  return reason.replace(/_/g, ' ').replace(/-/g, ':')
}

export function explainExecutionEvent(raw: string): string | null {
  const event = parseExecutionEvent(raw)
  if (!event) return null
  const reason = humanizeReason(event.reason)

  if (event.kind === 'debate' && event.status === 'failed') {
    return `辯論未完成：${reason}。白話：controller 或 debate batch 異常時，系統採 fail-closed，不讓未確認候選進場。`
  }

  if (event.kind !== 'execution') return null
  if (event.status === 'deferred') {
    return `盤中暫緩進場：${reason}。白話：目前價格、風險或動能條件還不夠好，候選保留但先不掛單。`
  }
  if (event.status === 'requote') {
    return `盤中重新報價：${reason}${event.detail ? `，價格調整 ${event.detail}` : ''}。白話：系統沒有追價，改用更保守的限價等待。`
  }
  if (event.status === 'skipped') {
    return `已跳過進場：${reason}。白話：這檔候選已被風控或執行規則擋下，不會送出買單。`
  }
  if (event.status === 'expired') {
    return `候選已過期：${reason}。白話：上一輪未完成的 pending buy 已失效，避免隔天沿用舊訊號。`
  }
  if (event.status === 'filled') {
    return `已成交：${reason}。白話：paper order 已建立，候選已轉成持倉或買入紀錄。`
  }
  if (event.status === 'cancelled') {
    return `已取消：${reason}。白話：這筆候選曾進入執行流程，但最後取消。`
  }
  return null
}
