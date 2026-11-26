import { knownOr15Reason } from './pendingBuyTradePreview'

/**
 * 交易紀錄的備註（paper_orders.note）與進場卡控原因 → 一句中文；原始字串只放 title，不上畫面。
 * 出場與進場分兩張表：同一個字（例如 target）在兩邊意思不同，混用會把 L4 目標鎖定翻成「停利出場」。
 */
export type OrderReasonView = { text: string; raw: string }

// Worker paperExitAttribution.exitCategory() 的分類（新版 sell note 一定有 exit_category）。
const EXIT_CATEGORY_LABEL: Record<string, string> = {
  take_profit: '停利出場',
  hard_stop: '停損出場',
  structural_stop: '結構停損出場',
  portfolio_derisk: '組合風控減碼',
  model_rotation: 'L4 目標權重調整',
  time_stop: '持有到期出場',
  forced_close: '收盤前強制平倉',
}

// 舊版 note 沒有 exit_category，只有 reason 字串：先剝掉 [Intraday]／[L4Target] 前綴與 (mkt=…) 註記再對照。
// 只認 Worker 實際會寫的字樣（paperExitPolicy、paperSwingLifecycle、s12 出場）。
const EXIT_REASON_PATTERNS: Array<[RegExp, string]> = [
  [/(^|_)tp[12](\b|_|$)|take[ _]?profit/i, '停利出場'],
  [/trailing[ _]?stop|trail_stop|atr_trail/i, '移動停損出場'],
  [/^initstop|初始停損/i, '初始停損出場'],
  [/^hard[ _]stop|swing_hard_stop/i, '停損出場'],
  [/swing_daily_orl|structural_stop/i, '結構停損出場'],
  [/ehat_decay/i, '預期報酬衰退出場'],
  [/^time[ _]stop|swing_20_sessions|max_hold/i, '持有到期出場'],
  [/^ml[ _]sell$/i, '模型賣出訊號'],
  [/force[ _]close|forced_close/i, '收盤前強制平倉'],
]

const RISK_LEVEL_ZH: Record<string, string> = { red: '紅燈', orange: '橘燈', yellow: '黃燈', black: '黑燈', green: '綠燈', p9: 'P9' }

/** 剝掉 Worker 加的 [xxx] 前綴與「(mkt=…, -1 tick fill)」成交註記，留下主因代碼。 */
export function stripReasonDecoration(raw: string): string {
  return raw.replace(/^(\[[^\]]*\]\s*)+/, '').replace(/\s*\(mkt[ =][^)]*\)\s*$/i, '').trim()
}

function leadingTags(raw: string): string[] {
  const head = raw.match(/^(\[[^\]]*\]\s*)+/)?.[0] ?? ''
  return [...head.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1].trim())
}

export function humanExitReason(code: unknown, fallback: string): string {
  if (typeof code !== 'string' || !code.trim()) return fallback
  const raw = code.trim()
  const tags = leadingTags(raw)
  const core = stripReasonDecoration(raw)
  if (tags.some((tag) => /^L4Target$/i.test(tag))) return 'L4 目標權重調整'
  if (tags.some((tag) => /^PortfolioRisk$/i.test(tag))) {
    const level = RISK_LEVEL_ZH[String(core.match(/^([a-z0-9]+)/i)?.[1] ?? '').toLowerCase()]
    return level ? `組合風控減碼（市場風險${level}）` : '組合風控減碼'
  }
  // 主因優先；主因認不得時才看前綴（例如 [13:24 daytrade force close]）。
  for (const text of [core, ...tags]) {
    for (const [pattern, label] of EXIT_REASON_PATTERNS) if (pattern.test(text)) return label
  }
  return fallback
}

// 進場卡控（gate calibration）／待買列的原因：先用盤中進場說明（knownOr15Reason），再用這張表。
const ENTRY_REASON_LABEL: Record<string, string> = {
  l4_target_locked: 'L4 目標鎖定，不再加碼',
  l4_target_met_or_cash_reserved: '已達 L4 目標或保留現金',
  l4_target_missing: '缺 L4 目標權重',
  l4_target_reconciliation: 'L4 目標與持倉對帳中',
  l4_target_remaining: 'L4 目標尚有剩餘股數',
  l4_sparse_weight: 'L4 權重過小，不進場',
  l4_distribution_execution_plan_expired: 'L4 執行計畫已過期',
  l4_distribution_execution_plan_not_found: '找不到 L4 執行計畫',
  l4_distribution_execution_head_changed: 'L4 計畫版本已更新，舊計畫不執行',
  l4_distribution_pending_plan_missing: '缺 L4 待執行計畫',
  l4_board_lot_book_not_ready: '整股委託簿未就緒',
  l4_odd_lot_book_not_ready: '零股委託簿未就緒',
  l4_entry_fill_outside_original_authorization: '可成交價超出原授權範圍',
  regime_gate_closed: '盤勢閘門關閉，不進場',
  swing_entry_window_closed: '今日進場時段已結束',
  swing_entry_window_not_open: '進場時段尚未開始',
  swing_next_bar_submission_missed: '訊號後未趕上送單時窗',
  swing_plan_not_authorized: '計畫未授權進場',
  swing_existing_position_or_daily_fill: '已持有或今日已成交',
  daily_plan_existing_position: '已持有，不重複進場',
  paper_outside_continuous_session: '非盤中連續交易時段',
  s12_hard_veto: 'S12 結構否決',
  s12_structure_stale: 'S12 結構資料過期',
  s12_data_unavailable: 'S12 結構資料不足',
  s12_market_data_unavailable: '盤中行情暫不可用',
  s12_structure_primary_waiting: '等待 S12 結構成形',
  // 以下對照 Worker paperEntryTasks／l4PortfolioPlan／preTradeExecutionPolicy 實際寫入的擋單原因。
  // l4TargetExecutionDecision：hardVeto = S12 否決或五檔品質未通過。
  l4_hard_risk_veto: 'S12 否決或五檔品質未通過，L4 不進場',
  // 同產業持股數已達 riskCfg.position.maxPerSector。
  position_sector_cap: '同產業持股已達上限',
  // assessPositionCorrelation：與現有持股相關性過高。
  position_correlation_cap: '與現有持股相關性過高',
  // validateOrder（canonical 下單風控）未核准。
  paper_order_risk_blocked: '下單風控驗證未通過',
  quote_unavailable: '報價暫不可用',
  authoritative_market_data_unavailable: '盤中行情暫不可用',
  execution_book_unavailable: '委託簿暫不可用',
  // preTradeExecutionPolicy DEFER：`stale_quote:<age>`，等新報價再查。
  stale_quote: '報價過期，等待新報價',
  untrusted_quote_source: '報價來源未受信任，等待券商報價',
  broker_quote_required: '需要券商即時報價',
  // loadTradingRestrictionBuckets 的 hardBlockedSymbols（處置、下市等官方交易限制）。
  restricted_execution_gate: '官方交易限制（處置、下市等），不進場',
  max_daily_buy_orders_reached: '今日買單數已達上限',
  // 組合層級閘門（paperEntryTasks 對全部待買各寫一筆 paper_order blocked，然後停止本輪新倉）。
  holding_risk_evidence_unavailable: '持倉風險資料不全，暫停新倉',
  // circuit breaker cb.halt。
  portfolio_risk_halt: '組合熔斷，暫停新倉',
  // checkP8DailyPnl：當日虧損達上限；基準淨值缺失時 fail-closed 為 p8_fail_closed。
  p8_daily_loss: '當日虧損達上限，暫停新倉',
  p8_fail_closed: '前一日淨值基準缺失，暫停新倉',
  // checkP9IntradayDrawdown：盤中回撤達上限；無法評估時為 p9_state_unavailable。
  p9_intraday_drawdown_halt: '盤中回撤達上限，暫停新倉',
  p9_state_unavailable: '盤中回撤無法評估，暫停新倉',
  // 持股既無即時報價也無前一交易日收盤，淨值未知，不依它配置新倉。
  intraday_nav_marks_missing: '持股缺報價、淨值無法估算，暫停新倉',
  // finlabL5MarketData 五檔品質。
  l5_depth_incomplete: '五檔深度不足',
  missing_l5_quote: '缺五檔報價',
  stale_l5_quote: '五檔報價過期',
  wide_l5_spread: '五檔價差過大',
  thin_top_ask: '賣一掛量不足',
  weak_l5_imbalance: '五檔買盤偏弱',
  // 自動換股：替代標的沒有券商報價或掛價不可成交。
  auto_swap_replacement_not_executable: '換股標的目前無法成交',
  // resolveS12UnifiedDecision 的 action → `s12_unified_<action>`。
  s12_unified_no_buy: 'S12 空方防守成立，今日不買',
  s12_unified_invalidated: 'S12 結構失效，今日不買',
  s12_unified_wait: '等待 S12 結構成形',
  s12_unified_defer: 'S12 結構等待過久，延後判斷',
  s12_unified_quote_unavailable: 'S12 報價暫不可用',
}

export function humanEntryReason(code: unknown, fallback: string): string {
  if (typeof code !== 'string' || !code.trim()) return fallback
  const core = stripReasonDecoration(code.trim())
  // `stale_quote:95s`、`broker_quote_required:finlab` 這類「代碼:細節」只用冒號前的代碼對照。
  const head = core.split(':')[0]
  return knownOr15Reason(core) ?? ENTRY_REASON_LABEL[core] ?? ENTRY_REASON_LABEL[head] ?? fallback
}

function parseNote(note: unknown): Record<string, any> | null {
  if (!note) return null
  if (typeof note === 'object') return note as Record<string, any>
  if (typeof note !== 'string') return null
  try {
    const parsed = JSON.parse(note)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function money(value: unknown): string | null {
  const n = Number(value)
  return value != null && value !== '' && Number.isFinite(n) && n > 0 ? `$${n.toFixed(n >= 1000 ? 0 : 2)}` : null
}

export function humanOrderReason(order: any): OrderReasonView {
  const rawNote = order?.note
  const raw = typeof rawNote === 'string' ? rawNote : rawNote ? JSON.stringify(rawNote) : ''
  const side = String(order?.side ?? '').toLowerCase()
  const fallback = side === 'sell' ? '依出場規則賣出' : side === 'buy' ? '依計畫進場' : '—'
  const note = parseNote(rawNote)
  if (!note) {
    // 非 JSON 的舊 note（例如 "[intraday] Hard stop -8.1% (mkt=…)"）：只顯示解析出的主因，原字串留在 title。
    if (typeof rawNote === 'string' && rawNote.trim()) {
      return { text: side === 'buy' ? humanEntryReason(rawNote, fallback) : humanExitReason(rawNote, fallback), raw }
    }
    return { text: fallback, raw }
  }
  if (side !== 'buy') {
    const category = typeof note.exit_category === 'string' ? EXIT_CATEGORY_LABEL[note.exit_category] : undefined
    if (category === '組合風控減碼') return { text: humanExitReason(note.reason, category), raw }
    if (category) return { text: category, raw }
    const reason = note.exit_reason ?? note.reason
    if (reason) return { text: humanExitReason(reason, fallback), raw }
    return { text: fallback, raw }
  }
  const entry = money(note.ml_entry)
  if (entry) {
    const parts = [`計畫進場 ${entry}`]
    const stop = money(note.ml_stop)
    const t1 = money(note.ml_t1)
    if (stop) parts.push(`停損 ${stop}`)
    if (t1) parts.push(`目標 ${t1}`)
    return { text: parts.join(' · '), raw }
  }
  if (note.reason) return { text: humanEntryReason(note.reason, fallback), raw }
  return { text: fallback, raw }
}
