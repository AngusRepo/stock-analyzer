import type { PendingBuyExecutionPreview } from './pendingBuyTradePreview'

export function checklistEvidence(preview?: PendingBuyExecutionPreview | null, nowMs = Date.now()) {
  const current = preview?.or15
  const timingOnly = current?.reason === 'swing_next_bar_submission_missed'
    && typeof current.conditions?.plan !== 'boolean'
  const signal = timingOnly ? preview?.last_or15_assessment ?? current : current
  const historical = !!signal && signal !== current
  const conditions = { ...signal?.conditions, ...current?.conditions }
  // A historical quote/price check is not a current execution authorization.
  const windowExpired = signal?.latest_bar_ms != null && nowMs >= signal.latest_bar_ms + 60_000
  if (historical || windowExpired) for (const key of ['quote', 'buy_limit', 'chase']) conditions[key] = null
  if (windowExpired) conditions.window = false
  return { signal, historical, conditions, checkedAt: signal?.checked_at ?? null }
}
export function checklistUnknownReason(key: string, hasEvidence: boolean): string {
  if (['quote','buy_limit','chase','l5','final'].includes(key)) return '待送單時檢查'
  if (key === 'position') return '待持倉／當日成交確認'
  if (key === 'allocation') return '待配置檢查'
  return hasEvidence ? '前置未通過／資料不足' : '等待完整訊號檢查'
}

export function evidenceTime(value?: string | number | null): string {
  if (value == null) return '時間未記錄'
  const ms=typeof value==='number'?value:Date.parse(value.replace(' ','T')+(/Z$|[+-]\d{2}:\d{2}$/.test(value)?'':'Z'))
  return Number.isFinite(ms)?new Date(ms).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'時間未記錄'
}
const num=(v:unknown)=>typeof v==='number' && Number.isFinite(v)
const price=(v:number|null|undefined)=>num(v)?'$'+v!.toFixed(2):'未記錄'
const percent=(v:number|null|undefined)=>num(v)?(v!>0?'+':'')+(v!*100).toFixed(2)+'%':'未記錄'
export function checklistNumbers(key:string,s:PendingBuyExecutionPreview['or15']):string {
  if (!s) return '等待原始檢查數值'
  if(key==='ma60') return `0050 昨收 ${price(s.benchmark_previous_close)} ＞ MA60 ${price(s.ma60)}`
  if(key==='opening_limit') return `ORH ${price(s.or_high)} ／ 漲停 ${price(s.limit_up)}`
  if(key==='or_touch') return `當根最高 ${price(s.signal_high)} ／ ORH ${price(s.or_high)}`
  if(key==='vwap') return `訊號收盤 ${price(s.signal_close)} ／ 累積 VWAP ${price(s.vwap)}${s.vwap_basis==='five_minute_typical'?'（5 分 K 典型價近似）':''}`
  if(key==='relative_strength') return `個股 ${percent(s.stock_return)} ／ 0050 ${percent(s.benchmark_return)} ／ 差 ${num(s.relative_return)?(s.relative_return!*100).toFixed(2)+' 個百分點':'未記錄'}`
  if(key==='quote') {
    const age=num(s.assessed_at_ms)&&num(s.quote_observed_at_ms)?(s.assessed_at_ms!-s.quote_observed_at_ms!)/1000:null
    return `檢查時 ${price(s.quote_price)} · 報價 ${evidenceTime(s.quote_observed_at_ms)} · 當時距報價 ${age!=null?age.toFixed(1)+' 秒':'未記錄'}（≤90 秒且須在訊號確認後）`
  }
  if(key==='chase') return `檢查價 ${price(s.quote_price)} ／ 上限 ${price(s.max_buy_price)}`
  if(key==='buy_limit') return `檢查價 ${price(s.quote_price)} ／ 漲停 ${price(s.limit_up)}`
  if(key==='window' && s.latest_bar_ms) return `訊號根 ${evidenceTime(s.latest_bar_ms-300000)}～${evidenceTime(s.latest_bar_ms)}；送單窗口 ${evidenceTime(s.latest_bar_ms)}～${evidenceTime(s.latest_bar_ms+60000)}（不含終點）`
  return ''
}
