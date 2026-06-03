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

function formatMsAsSeconds(msText: string | null): string {
  const ms = Number(msText)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} 秒`
}

function parseDetailMap(detail: string | null | undefined): Record<string, string> {
  if (!detail) return {}
  return detail.split(';').reduce<Record<string, string>>((acc, part) => {
    const [rawKey, ...rawValue] = part.split('=')
    const key = rawKey?.trim()
    const value = rawValue.join('=').trim()
    if (key) acc[key] = value
    return acc
  }, {})
}

function formatPct(value: unknown, decimals = 0, trim = true): string | null {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  const text = (n * 100).toFixed(decimals)
  return `${trim ? text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : text}%`
}

export function explainExecutionEvent(raw: string): string | null {
  const event = parseExecutionEvent(raw)
  if (!event) return null

  const reason = normalizeReason(event.reason)
  const detail = event.detail ? normalizeReason(event.detail) : null
  const combined = `${reason} ${detail ?? ''}`.trim()
  const detailMap = parseDetailMap(event.detail)

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

  if (event.status === 'stale_quote' || /stale quote/i.test(combined)) {
    const age = formatMsAsSeconds(extractNumber(combined, /stale quote[: ]+([0-9.]+)ms/i))
    return `報價過期：即時報價${age ? `已超過 ${age}` : '已超過允許時間'}，系統 fail-closed，不用過期價格假裝成交。`
  }

  const isWaitingStatus = event.status === 'deferred' || event.status === 'pending'
  if (isWaitingStatus) {
    if (event.reason.startsWith('range_position_low') || /range position low/i.test(combined)) {
      const legacyPct = extractNumber(combined, /range position low[: ]+([0-9.]+)%/i)
      const observed = detailMap.range_position != null ? formatPct(detailMap.range_position) : legacyPct ? `${legacyPct}%` : null
      const threshold = formatPct(detailMap.min)
      return [
        '盤中暫緩進場：range_position_low（盤中區間位置過低）。',
        observed ? `目前位置 ${observed}` : null,
        threshold ? `門檻 ${threshold}` : null,
        '代表價格仍在當日區間偏低處，先避免接刀。',
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('volume_ratio_low') || /volume ratio low/i.test(combined)) {
      const ratio = detailMap.volume_ratio ?? extractNumber(combined, /volume ratio low[: ]+([0-9.]+)/i)
      const min = detailMap.min_volume_ratio
      return [
        '盤中暫緩進場：volume_ratio_low（量能比過低）。',
        ratio ? `目前量能比 ${ratio}` : null,
        min ? `門檻 ${min}` : null,
        '成交活躍度不足，先不追單。',
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('opening_fast_path_entry') || /opening fast path entry/i.test(combined)) {
      const premium = event.reason.split(':')[1] ?? extractNumber(combined, /opening fast path entry[: ]+([0-9.]+%)/i)
      const maxPremium = formatPct(detailMap.max_premium, 2, false)
      return [
        '開盤快路：opening_fast_path_entry，9:00-9:10 早盤 trend 尚未穩定時，用券商即時報價/L5 與可追價上限判斷。',
        premium ? `本次追價 ${premium}` : null,
        maxPremium ? `上限 ${maxPremium}` : null,
        detailMap.l5 ? `L5=${detailMap.l5}` : null,
        '仍受 chase ceiling、支撐破位、風險與成交量條件限制。',
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('price_above_entry') || /price above entry/i.test(combined)) {
      const premium = formatPct(detailMap.premium, 2, false)
      const max = formatPct(detailMap.max, 2, false)
      const priceText = detailMap.current && detailMap.entry
        ? `現價 ${detailMap.current} 高於進場價 ${detailMap.entry}。`
        : null
      return [
        '盤中暫緩進場：price_above_entry（現價高於允許進場價）。',
        priceText,
        premium ? `追價溢價 ${premium}` : null,
        max ? `上限 ${max}` : null,
        '等待回到合理掛單區間，避免無上限追高。',
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('waiting_for_ohlcv_confirmation')) {
      return [
        '盤中暫緩進場：waiting_for_ohlcv_confirmation（尚未站上 OHLCV 轉強確認）。',
        detailMap.current ? `現價 ${detailMap.current}` : null,
        detailMap.confirmation ? `轉強確認 ${detailMap.confirmation}` : null,
        '突破型單不在確認價下方偷買。',
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('price_above_ohlcv_optimistic_range')) {
      return [
        '盤中暫緩進場：price_above_ohlcv_optimistic_range（現價高於 OHLCV 可追價上限）。',
        detailMap.current ? `現價 ${detailMap.current}` : null,
        detailMap.optimistic_high ? `可追價上限 ${detailMap.optimistic_high}` : null,
        '等待回落、重新突破確認，或 L5 買盤持續支撐再評估。',
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('ohlcv_support_lost')) {
      return [
        '盤中暫緩進場：ohlcv_support_lost（OHLCV 關鍵支撐失守）。',
        detailMap.current ? `現價 ${detailMap.current}` : null,
        detailMap.support ? `關鍵支撐 ${detailMap.support}` : null,
        detailMap.atr_defense ? `ATR 防守 ${detailMap.atr_defense}` : null,
        '先避免下跌接刀。',
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('between_buy_reference_and_confirmation')) {
      return [
        '盤中暫緩進場：between_buy_reference_and_confirmation（高於買入參考區但尚未轉強）。',
        detailMap.current ? `現價 ${detailMap.current}` : null,
        detailMap.buy_reference_high ? `買入參考區上緣 ${detailMap.buy_reference_high}` : null,
        detailMap.confirmation ? `轉強確認 ${detailMap.confirmation}` : null,
        '不在中段尷尬位置追。'
      ].filter(Boolean).join(' ')
    }
    if (event.reason.startsWith('falling_5min') || /falling 5min/i.test(combined)) {
      return '盤中暫緩進場：falling_5min（5 分鐘動能轉弱）。短線價格斜率為負，先避免接刀。'
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
