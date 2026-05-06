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

function normalizeReason(value: unknown): string {
  return String(value ?? '')
    .replace(/_/g, ' ')
    .replace(/-/g, ':')
    .trim()
}

export function formatExecutionEvent(event: StructuredExecutionEvent): string {
  const base = `${cleanPart(event.kind)}:${cleanPart(event.status)}:${cleanPart(event.reason)}`
  const detail = cleanPart(event.detail)
  return detail ? `${base}:${detail}` : base
}

export function parseExecutionEvent(raw: string): StructuredExecutionEvent | null {
  const [kind, status, reason, ...detailParts] = String(raw ?? '').split(':')
  if ((kind !== 'execution' && kind !== 'debate') || !status || !reason) return null
  return {
    kind,
    status,
    reason,
    detail: detailParts.length > 0 ? detailParts.join(':') : null,
  }
}

function extractNumber(text: string, pattern: RegExp): string | null {
  return text.match(pattern)?.[1] ?? null
}

export function explainExecutionEvent(raw: string): string | null {
  const event = parseExecutionEvent(raw)
  if (!event) return null

  const reason = normalizeReason(event.reason)
  const detail = event.detail ? normalizeReason(event.detail) : null
  const combined = `${reason} ${detail ?? ''}`.trim()

  if (event.kind === 'debate') {
    if (event.status === 'failed') {
      return `辯論流程失敗：${reason}。系統採 fail-closed，不會在辯論未完成時硬下單。`
    }
    if (event.status === 'pending') {
      return `辯論等待中：${reason}。先保留候選，等 verdict 回寫後再進入執行。`
    }
    return `辯論狀態：${event.status}，原因 ${reason}。`
  }

  if (event.kind !== 'execution') return null

  if (event.status === 'deferred') {
    if (/volume ratio low/i.test(combined)) {
      const ratio = extractNumber(combined, /volume ratio low[: ]+([0-9.]+)/i)
      return `盤中暫緩進場：量能比${ratio ? ` ${ratio}` : ''}低於門檻，代表目前成交活躍度不足，先不追單。`
    }
    if (/price above entry/i.test(combined)) {
      return '盤中暫緩進場：現價高於允許買入價，避免追高，等待回到合理掛單區間。'
    }
    if (/momentum unavailable|trend http 404|snapshot http|http 404/i.test(combined)) {
      return '盤中資料錯誤：趨勢或動能資料服務沒有回傳有效資料；這是資料品質問題，不是股票本身的看空訊號，所以系統 fail-closed 不進場。'
    }
    return `盤中暫緩進場：${reason}。系統判定當下價格、量能或風險條件尚未達到執行標準。`
  }

  if (event.status === 'requote') {
    return `重新估價：${reason}${detail ? `，${detail}` : ''}。現價與原掛單條件偏離，需重新計算買入價。`
  }
  if (event.status === 'skipped') {
    return `略過進場：${reason}。這通常代表候選已過期、辯論未通過或風控條件不允許。`
  }
  if (event.status === 'expired') {
    return `掛單過期：${reason}。候選沒有在有效時間內完成進場。`
  }
  if (event.status === 'filled') {
    return `已成交：${reason}。Paper order 已完成，並進入持倉與後續風控追蹤。`
  }
  if (event.status === 'cancelled') {
    return `已取消：${reason}。通常是收盤、ROD 清理或系統風控取消。`
  }

  return null
}
