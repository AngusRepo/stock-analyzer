/**
 * 把後端識別名（table／key／reason code）換成給人看的名稱。
 * 原始代碼只放 tooltip（title），不印在畫面上。
 */

/** 看起來像內部識別：snake_case、帶點的鍵名、全大寫常數、legacy_fallback:… 之類。 */
export function looksInternal(text: unknown): boolean {
  if (typeof text !== 'string') return false
  const t = text.trim()
  if (!t) return false
  if (/[一-鿿]/.test(t)) return false
  return (/^[a-z0-9]+(?:[_.:/-][a-z0-9]+)+$/i.test(t) && /[_.:]/.test(t)) || /^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(t)
}

const SOURCE_LABELS: Array<[RegExp, string]> = [
  [/^canonical_market_index_daily/i, '指數日資料'],
  [/^canonical_regime_context_daily/i, '盤勢日資料'],
  [/^canonical_chip_daily/i, '籌碼日資料'],
  [/^canonical_margin/i, '融資融券日資料'],
  [/^canonical_futures/i, '期貨日資料'],
  [/^canonical_market_summary_daily/i, '市場彙總日資料'],
  [/^canonical_market_daily/i, '市場日資料'],
  [/^canonical_institutional_amount/i, '法人買賣金額日資料'],
  [/^canonical_/i, '正式日資料'],
  [/^external_evidence_items/i, '外部證據資料'],
  [/finlab official date fallback/i, 'FinLab（官方日期）'],
  [/finlab/i, 'FinLab'],
  [/gdelt/i, '國際新聞事件'],
  [/twse/i, '證交所'],
  [/tpex/i, '櫃買中心'],
  [/taifex/i, '期交所'],
  [/shioaji/i, '永豐行情'],
  [/fred/i, 'FRED 美國經濟資料'],
  [/yahoo/i, 'Yahoo 行情'],
  [/^legacy_fallback/i, '舊版資料（備援）'],
]

/** 資料來源名稱。認不得的內部識別回傳 fallback（預設「系統資料」）。 */
export function humanSource(raw: unknown, fallback = '系統資料'): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  for (const [pattern, label] of SOURCE_LABELS) if (pattern.test(raw)) return label
  return looksInternal(raw) ? fallback : raw
}

const STATUS_LABELS: Record<string, string> = {
  ok: '正常',
  success: '正常',
  ready: '就緒',
  fresh: '最新',
  stale: '資料過期',
  missing: '缺資料',
  fetch_failed: '讀取失敗',
  failed: '失敗',
  error: '失敗',
  timeout: '逾時',
  pending: '等待中',
  running: '執行中',
  skipped: '已略過',
  unavailable: '暫不可用',
  not_materialized: '尚未產生',
  finlab_not_materialized: 'FinLab 尚未產生',
  shadow: '觀察中',
}

export function humanStatus(raw: unknown, fallback = '狀態不明'): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  const key = raw.trim().toLowerCase()
  if (STATUS_LABELS[key]) return STATUS_LABELS[key]
  return looksInternal(raw) ? fallback : raw
}

/** 用自己的對照表換名；找不到且像內部識別就用 fallback。 */
export function humanizeId(raw: unknown, labels: Record<string, string>, fallback: string): string {
  if (typeof raw !== 'string' || !raw.trim()) return fallback
  if (labels[raw]) return labels[raw]
  return looksInternal(raw) ? fallback : raw
}

/**
 * 策略 id 的可讀標籤：momentum_breakout_v3 → "momentum breakout · v3"。
 * Worker 的 daily pipeline payload 只帶 strategy_id，沒有顯示名稱欄位；這裡只做機械轉換，
 * 不自創中文名。原始 id 仍要放 title。
 */
/** 策略顯示名：後端 strategy_summary.strategies[].display_name 優先（batch2 起），null／空字串才用機械轉換。 */
export function strategyDisplayLabel(id: unknown, displayName?: unknown): string {
  return typeof displayName === 'string' && displayName.trim() ? displayName.trim() : strategyIdLabel(id)
}

export function strategyIdLabel(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id) return '未命名策略'
  const version = id.match(/^(.+?)[_-](v\d+)$/i)
  const base = (version ? version[1] : id).replace(/[_-]+/g, ' ').trim()
  return version ? `${base} · ${version[2].toLowerCase()}` : base
}

/**
 * tooltip（title）專用：含 snake_case 識別名或 JSON 的字串一律不放進 title（Wei 規則：tooltip 不露原碼）。
 * 回傳 undefined 時 React 不會輸出 title 屬性。
 */
export function humanTitle(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined
  const t = text.trim()
  if (!t) return undefined
  if (/\b[a-z]+(?:_[a-z0-9]+)+\b/.test(t) || /^[[{]/.test(t) || looksInternal(t)) return undefined
  return t
}

/**
 * 排程摘要：後端常把整段 JSON（checksum、receipt）塞進 key=value 摘要。畫面只放人看的文字，
 * 40 字以上的 {…}／[…] 區塊拿掉並註明字數；底線換空白。不截斷、不收合（11/28 Wei 定案）。
 */
export function humanJobSummary(text: unknown): string {
  const t = typeof text === 'string' ? text : ''
  let out = ''
  let hidden = 0
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (c === '{' || c === '[') {
      let depth = 0
      let inString = false
      let j = i
      for (; j < t.length; j++) {
        const ch = t[j]
        if (inString) {
          if (ch === '\\') j++
          else if (ch === '"') inString = false
        } else if (ch === '"') inString = true
        else if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') {
          depth--
          if (depth === 0) break
        }
      }
      if (j - i + 1 >= 40) {
        hidden += Math.min(j, t.length - 1) - i + 1
        i = j
        continue
      }
    }
    out += c
  }
  const human = out.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
  return hidden ? `${human}（另有機器明細 ${hidden.toLocaleString()} 字）` : human
}
