/**
 * 排程摘要中文句（FE-SUMMARY-KV-LABELS，11/28 Wei 定案：後端每個 job 寫一句中文摘要，前端只顯示這句，
 * 機器原文保留在 summary／lastError）。
 *
 * 只在 /api/scheduler/status 讀取時計算：純字串解析，不讀 KV／D1、不改寫入端。
 * 每個 job 一個 formatter；原文格式認不得時回 undefined，前端退回 humanJobSummary。
 * 句子不得殘留 key=value 或 snake_case 識別字（guard 擋下時也回 undefined）。
 */

type Pair = [string, string]
type Parsed = { raw: string; pairs: Pair[]; map: Map<string, string>; words: string[] }
type Formatter = (p: Parsed) => string | undefined

// ── 解析 ──────────────────────────────────────────────────────────────

const KEY = /^[A-Za-z][\w.:-]*$/

/** 依頂層空白／;／| 切詞；{…}、[…] 視為一個值（JSON 字串內的括號不算）。 */
function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      cur += c
      if (c === '\\') { cur += text[i + 1] ?? ''; i++ } else if (c === '"') inString = false
      continue
    }
    if (depth > 0 && c === '"') { inString = true; cur += c; continue }
    if (c === '{' || c === '[') depth++
    else if ((c === '}' || c === ']') && depth > 0) depth--
    if (depth === 0 && (c === ' ' || c === ';' || c === '|' || c === '\n' || c === '\t')) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += c
  }
  if (cur) out.push(cur)
  return out
}

function parse(raw: string): Parsed {
  const pairs: Pair[] = []
  const words: string[] = []
  const add = (token: string) => {
    const eq = token.indexOf('=')
    const key = eq > 0 ? token.slice(0, eq) : ''
    if (!key || !KEY.test(key)) { words.push(token); return }
    let value = token.slice(eq + 1)
    if (!/^[[{]/.test(value)) value = value.replace(/,$/, '')
    pairs.push([key, value])
    // best=high=0.6、mature_recovery=mature_signal_date=… 內層也登記
    if (!/^[[{]/.test(value) && value.includes('=')) add(value)
  }
  for (const token of splitTopLevel(raw)) add(token.replace(/,$/, ''))
  const map = new Map<string, string>()
  for (const [k, v] of pairs) if (!map.has(k)) map.set(k, v)
  return { raw, pairs, map, words }
}

function json<T = unknown>(value: string | undefined): T | undefined {
  if (!value) return undefined
  try { return JSON.parse(value) as T } catch { return undefined }
}

/** 第一個頂層 JSON 物件（pre-market-warmup 把 cursor_key 整包接在摘要後面）。 */
function firstJsonObject(text: string): Record<string, any> | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  for (const token of splitTopLevel(text.slice(start))) {
    if (token.startsWith('{')) return json<Record<string, any>>(token)
  }
  return undefined
}

// ── 格式 ──────────────────────────────────────────────────────────────

function n(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  const [int, frac] = String(Math.abs(num)).split('.')
  return `${num < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`
}

function bytes(value: string | number | undefined): string | undefined {
  const num = Number(value)
  if (!Number.isFinite(num)) return undefined
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)} GB`
  if (num >= 1e6) return `${(num / 1e6).toFixed(1)} MB`
  if (num >= 1e3) return `${(num / 1e3).toFixed(1)} KB`
  return `${num} B`
}

function durationMs(value: string | undefined): string | undefined {
  const ms = Number(value)
  if (!Number.isFinite(ms)) return undefined
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`
}

const isTrue = (v: string | undefined) => v === 'true' || v === 'True' || v === '1'
const none = (v: string | undefined) => !v || v === 'none' || v === 'n/a' || v === '{}' || v === '[]'
const listCount = (v: string | undefined) => (none(v) ? 0 : v!.split(',').filter(Boolean).length)

function join(head: string, ...segments: Array<string | undefined | false | null>): string {
  const body = segments.filter(Boolean) as string[]
  return body.length ? `${head}：${body.join('；')}` : head
}
const clause = (...parts: Array<string | undefined | false | null>) => (parts.filter(Boolean) as string[]).join('，') || undefined

function dateRange(dates: string[]): string {
  return dates.length <= 3 ? dates.join('、') : `${dates[0]}～${dates[dates.length - 1]}`
}

// ── 代碼詞典（只翻譯認得的；認不得的一律「原因代碼見明細」，不硬翻） ─────────────────

const REASON_ZH: Record<string, string> = {
  awaiting_pipeline: '等待當日 Pipeline 完成',
  awaiting_premarket: '等待下一交易日盤前資訊',
  parked_ticket_resumed: '暫停中的工作已恢復，本輪不重派',
  r33_has_no_native_l4_refresh: 'R33 沒有原生 L4 更新可用',
  run_success: '執行已成功',
  recoverable_run_missing: '找不到可補跑的執行',
  recoverable_progress_invalid: '補跑進度紀錄無效',
  queued_without_lease: '已排隊但尚無租約',
  queued_with_lease: '已排隊並持有租約',
  active_lease: '已有執行中的租約',
  lease_expired: '租約已過期',
  stage_missing: '找不到階段紀錄',
  stage_success: '階段已成功',
  retry_exhausted: '重試次數已用完',
  screener_stage_missing: '找不到選股階段紀錄',
  callback_terminal_already_success: '回呼已成功結束',
  screener_callback_exact_funnel_missing: '回呼對應的選股漏斗紀錄不存在',
  screener_callback_lineage_mismatch: '回呼來源鏈不一致',
  screener_callback_producer_mismatch: '回呼的產生者不一致',
  screener_callback_stage_fence_lost: '回呼的階段鎖已失效',
  screener_callback_stale_non_success_after_success: '成功後又收到過期的非成功回呼',
  insufficient_data: '資料不足',
  durable_prep_first_oof_job_dispatched: '已派送第一個 OOF 工作',
}
const reason = (token: string | undefined) => (token ? REASON_ZH[token] : undefined) ?? '原因代碼見明細'

const STATUS_ZH: Record<string, string> = {
  success: '成功', error: '錯誤', failed: '失敗', fail: '未通過', pass: '通過', running: '執行中', waiting: '等待中',
  skipped: '略過', blocked: '被擋', missing: '無紀錄', triggered: '已觸發', queued: '已排隊', ready: '就緒',
  completed: '完成', pending: '待處理', dry_run: '試跑', not_scheduled: '未排程', closed_success: '已正常結束',
  closed_error: '已以錯誤結束',
  accepted: '已受理', sleep: '非本日排程', spawned: '已派送', disabled_by_design: '依設計停用', skip: '略過',
}
const statusZh = (token: string | undefined) => (token ? STATUS_ZH[token] : undefined) ?? '狀態代碼見明細'
/** 「狀態X」：認得的寫「狀態成功」，認不得的不疊成「狀態狀態代碼見明細」。 */
const stateOf = (token: string | undefined) => (token && STATUS_ZH[token] ? `狀態${STATUS_ZH[token]}` : '狀態代碼見明細')

const REGIME_ZH: Record<string, string> = {
  bull: '多頭', bear: '空頭', volatile: '高波動', sideways: '盤整', bull_market: '多頭', bear_market: '空頭',
}
const BIAS_ZH: Record<string, string> = {
  bullish: '偏多', bearish: '偏空', neutral: '中性', positive: '偏多', negative: '偏空',
}

const PREMARKET_STAGE_ZH: Record<string, string> = {
  setup: '盤前設定', 'market-health': '市場健康檢查', not_started: '尚未開始', context: '盤前脈絡', allocate: 'L4 配置',
  complete: '完成',
}
function premarketStage(stage: string | undefined): string {
  if (!stage) return '未知'
  const short = stage.replace(/^premarket_v3:/, '')
  if (PREMARKET_STAGE_ZH[short]) return PREMARKET_STAGE_ZH[short]
  if (short.startsWith('publish')) return '交易計畫發布'
  return '階段代碼見明細'
}

/** 「在 X 階段」：拉丁字開頭的階段名前補空格（如「在 L4 配置階段」）。 */
const stageAt = (stage: string) => (/^[A-Za-z0-9]/.test(stage) ? ` ${stage}階段` : `${stage}階段`)

const WARMUP_ZH: Record<string, string> = {
  predict_batch_v2: '批次預測', gnn_graphsage_universal_predict: 'GNN 預測', strategy_similarity_evidence: '策略相似度證據',
}

const ALPHA_BUCKET_ZH: Record<string, string> = {
  trend_following: '趨勢追蹤', mean_reversion: '均值回歸', breakout_vol_expansion: '突破量能擴張',
  defensive_accumulation: '防禦型吸籌',
}

const LEGACY_TARGET_ZH: Record<string, string> = {
  obsolete_screener_items: '過時選股項目', superseded_pending_items: '被取代的待辦項目',
  superseded_pending_events: '被取代的待辦事件', null_date_predictions: '缺日期的預測',
  intraday_report_manifests: '盤中報告清單', retired_state_space_shadow: '已退役的狀態空間影子資料',
  allocator_snapshot_staging_orphans: '配置器快照暫存孤兒',
}

// ── 共用子句 ──────────────────────────────────────────────────────────

function policySkip(raw: string): string | undefined {
  const m = /^skipped by scheduler policy: (.*)$/s.exec(raw)
  if (!m) return undefined
  const r = m[1]
  const day = /^(weekend|holiday):(\d{4}-\d{2}-\d{2})/.exec(r)
  if (day) return `${day[1] === 'weekend' ? '週末' : '假日休市'}（${day[2]}）非交易日，依排程政策略過`
  if (r.startsWith('global_pause')) return '排程已全域暫停，依排程政策略過'
  return '依排程政策略過（原因代碼見明細）'
}

/** strategyLearningRecoveryWatchdog 的回傳句（也嵌在 screener-v2-watchdog 裡）。 */
function strategyLearningRecovery(text: string): string | undefined {
  const t = text.trim()
  if (/^error\b/.test(t) && !/strategy-learning recovery/.test(t)) return '策略學習補跑檢查失敗（原因見明細）'
  const m = /^(?:(\w+) )?strategy-learning recovery\s*(.*)$/s.exec(t)
  if (!m) return undefined
  const status = (m[1] ?? '').toLowerCase()
  const p = parse(m[2])
  const date = p.map.get('date') ?? '日期未知'
  const r = p.map.get('reason')
  const candidates = listCount(p.map.get('candidates'))
  const more = candidates > 1 ? `（共 ${candidates} 個候選日未能補跑）` : ''
  if (m[2].startsWith('blocked')) {
    if (/\breason=run_error:/.test(m[2])) {
      const cause = /D1 DB is overloaded/.test(m[2]) ? 'D1 過載' : '錯誤見明細'
      return `${date} 策略學習補跑被擋：該日策略學習已以錯誤結束（${cause}），不自動重跑`
    }
    return `${date} 策略學習補跑被擋：${reason(r)}`
  }
  if (/^authority denied/.test(m[2])) {
    return `${date} 無補跑權限：盤後驗證狀態為${statusZh(p.map.get('post_verify_status'))}${more}`
  }
  if (status === 'success') {
    const root = p.map.get('root')
    return `${date} 策略學習已成功，無需補跑${root ? `（晚間流程${statusZh(root)}）` : ''}`
  }
  if (status === 'running') {
    const other = /^other_date_active:(\d{4}-\d{2}-\d{2})$/.exec(r ?? '')
    if (other) return `${date} 策略學習等待中，另一日（${other[1]}）仍在執行`
    return `${date} 策略學習執行中（${reason(r)}）`
  }
  if (status === 'triggered') return `已觸發 ${date} 策略學習補跑`
  if (status === 'skipped') return `策略學習補跑略過：${reason(m[2].trim().split(' ')[0])}`
  if (status === 'error') return `策略學習補跑檢查錯誤（${date}）：${reason(r)}${more}`
  return undefined
}

/** screenerRecoveryWatchdog 的回傳句。 */
function screenerRecovery(text: string): string | undefined {
  const t = text.trim()
  let m = /^status=error screener_run_missing:(\d{4}-\d{2}-\d{2}) evening_chain=(\w+)/.exec(t)
  if (m) return `${m[1]} 找不到正式選股執行紀錄，晚間流程狀態為${statusZh(m[2])}，已發告警`
  m = /^SKIPPED canonical screener run missing for (\d{4}-\d{2}-\d{2})(.*)$/s.exec(t)
  if (m) {
    const rest = m[2]
    if (/succeeded outside the canonical chain/.test(rest)) return `${m[1]} 正式選股紀錄缺漏，但已有鏈外手動選股成功，略過`
    if (/non_trading_day=/.test(rest)) return `${m[1]} 非交易日，略過選股補跑`
    const defer = /evening-chain=(\w+), alert deferred to (\d{1,2}:\d{2}) TW/.exec(rest)
    if (defer) return `${m[1]} 正式選股紀錄尚未出現，晚間流程${statusZh(defer[1])}，告警延到台灣時間 ${defer[2]}`
    return `${m[1]} 正式選股紀錄尚未出現，暫不告警`
  }
  m = /^(success|status=error pipeline_blocked) funnel=\S+ universe=(\d+) continuation=(queued|already_(\w+)) pipeline_recovery=(\S+)$/.exec(t)
  if (m) {
    const continuation = m[3] === 'queued'
      ? '已排入選股後續 Pipeline'
      : `選股後續 Pipeline 階段已是${m[4] === 'success' ? '成功' : statusZh(m[4])}，不重排`
    const recovery = m[1] !== 'success'
      ? 'Pipeline 補跑被擋，已發告警'
      : m[5] === 'not_needed' || m[5] === 'pipeline_not_error'
        ? 'Pipeline 未失敗，不需補跑'
        : m[5] === 'queued' ? '已排入 Pipeline 補跑' : 'Pipeline 補跑未排入（原因代碼見明細）'
    return `正式選股已確認（母體 ${n(m[2])} 檔），${continuation}，${recovery}`
  }
  m = /^LOCKED screener stage status=(\w+) attempt=(\d+)/.exec(t)
  if (m) return `選股階段已被鎖定（${statusZh(m[1])}，第 ${m[2]} 次嘗試）`
  m = /^SKIPPED screener recovery authority denied: (\S+)/.exec(t)
  if (m) return `選股補跑無權限，略過：${reason(m[1])}`
  m = /^running screener watchdog reason=(\S+) attempt=(\d+)/.exec(t)
  if (m) return `選股補跑執行中（${reason(m[1])}，第 ${m[2]} 次嘗試）`
  m = /^triggered same-day screener recovery reason=(\S+?);/.exec(t)
  if (m) return `已觸發當日選股補跑：${reason(m[1])}`
  return undefined
}

function compositeStatus(p: Parsed): string | undefined {
  const s = p.map.get('status')
  if (s === 'error') return '異常'
  if (s === 'success') return '正常'
  if (s === 'skipped') return '略過'
  if (s === 'running' || s === 'triggered') return '執行中'
  return undefined
}

// ── 各 job formatter ─────────────────────────────────────────────────

const FORMATTERS: Record<string, Formatter> = {
  'pre-market-warmup': (p) => {
    const raw = p.raw
    const published = /^盤前發布與健康檢查已完成；pending=(\w+)$/.exec(raw)
    if (published) return PENDING_PLAN_ZH[published[1]] ? `盤前發布與健康檢查已完成：${PENDING_PLAN_ZH[published[1]]}` : undefined
    if (/^status=skipped premarket_outside_window/.test(raw)) return '不在盤前時段，略過'
    if (/^status=skipped premarket_non_trading_day/.test(raw)) return '非交易日，略過盤前準備'
    if (/^status=error event_stage=market-health/.test(raw)) {
      return `盤前準備失敗：市場健康檢查錯誤，交易計畫${isTrue(p.map.get('plan_published')) ? '已' : '未'}發布`
    }
    if (/^status=error premarket_event_chain overdue=true/.test(raw)) {
      return `盤前流程逾時未完成：卡在${stageAt(premarketStage(p.map.get('stage')))}，目標時間 ${p.map.get('ready_target') ?? '未知'}`
    }
    if (/^status=error event_stage=/.test(raw)) return `盤前準備失敗：卡在${stageAt(premarketStage(p.map.get('event_stage')))}`
    if (!/^status=success event_driven_ready/.test(raw)) return undefined
    const health = p.map.get('market_health')
    const cursor = firstJsonObject(raw)
    const out = cursor?.output ?? {}
    const ctx = out.morning_context ?? cursor?.input?.morning_context ?? {}
    const symbols: string[] = Array.isArray(out.symbols) ? out.symbols.map(String) : []
    const plan = out.pending_status === 'empty' ? '今日無待買標的'
      : out.pending_status === 'halted' ? '交易計畫已暫停'
      : symbols.length ? `待買 ${symbols.length} 檔：${symbols.join('、')}` : undefined
    const degraded = typeof out.warmup === 'string'
      ? [...out.warmup.matchAll(/(\w+)=degraded/g)].map((m) => m[1]).filter((k) => k !== 'warmup')
      : []
    const marketRisk = ctx.news?.macro_evidence?.market_risk ?? ctx.market_risk
    const risk = marketRisk?.risk_level
    const riskZh = risk === 'red' ? '紅燈' : risk === 'yellow' ? '黃燈' : risk === 'green' ? '綠燈' : undefined
    const bias = ctx.news?.bias
    return join(
      '盤前準備完成',
      clause(
        health === 'success' ? '市場健康檢查成功' : health ? `市場健康檢查${statusZh(health)}` : undefined,
        `交易計畫已發布${out.signal_date || ctx.trade_date ? `（訊號日 ${out.signal_date ?? '未知'} → 交易日 ${ctx.trade_date ?? '未知'}）` : ''}`,
      ),
      plan,
      clause(
        riskZh && `市場風險燈號${riskZh}${marketRisk?.date ? `（${marketRisk.date}）` : ''}`,
        bias && BIAS_ZH[bias] && `新聞情緒${BIAS_ZH[bias]}`,
      ),
      degraded.length > 0 && `注意：暖機有 ${degraded.length} 項降級（${degraded.map((k) => WARMUP_ZH[k] ?? '其他服務').join('、')}）`,
    )
  },

  'market-close-refresh': (p) => {
    const raw = p.raw
    if (/^SKIP: market-close-refresh already ran/.test(raw)) {
      const m = /already ran for (\S+?);/.exec(raw)
      return `收盤資料今日已更新過${m ? `（${m[1]}）` : ''}，略過：最新日線 ${n(p.map.get('price')) ?? '?'} 檔`
    }
    const ok = raw.startsWith('market-close refresh complete')
    if (!ok && !raw.startsWith('error: market-close refresh incomplete')) return undefined
    const date = p.map.get('date')
    const latest = p.map.get('price_latest')
    const chain = /^precreated:(\d+)$/.exec(p.map.get('chain_state') ?? '')
    const official = p.map.get('official_prices')
    const day = p.map.get('taifex_day')
    const night = p.map.get('taifex_night')
    const cache = /^(\d+)\/(\d+)$/.exec(p.map.get('post_close_price_cache_refreshed') ?? '')
    const cacheFailed = Number(p.pairs.find(([k]) => k === 'failed')?.[1] ?? 0)
    const warns = [
      latest && date && latest !== date && `最新日線停在 ${latest}`,
      p.map.has('official_prices_waiting') && '官方收盤價尚未就緒',
      official === 'disabled' && '官方收盤價抓取已停用',
      p.map.has('wave2_warn') && '第二輪資料抓取失敗',
      p.map.has('taifex_warn') && '台指期收盤抓取失敗',
      day === 'missing' && '台指期日盤收盤未取到',
      night === 'missing' && '台指期夜盤收盤未取到',
      cache && cacheFailed > 0 && `持倉收盤價快取只更新 ${cache[1]}/${cache[2]} 檔（${cacheFailed} 檔失敗）`,
      p.map.has('post_close_price_warn') && '持倉收盤價快取更新失敗',
    ].filter(Boolean) as string[]
    return join(
      ok ? `收盤資料更新完成（${date}）` : `收盤資料更新未完成（${date}），需重試`,
      clause(
        `最新日線 ${n(p.map.get('price_rows')) ?? '?'} 檔`,
        official && n(official) && `官方收盤價 ${n(official)} 檔`,
        chain && `每日就緒鏈 ${chain[1]} 站已預建`,
      ),
      clause(
        day && day !== 'missing' && `台指期日盤收盤 ${n(day) ?? day}`,
        night && night !== 'missing' && `台指期夜盤收盤 ${n(night) ?? night}`,
      ),
      warns.length > 0 && `注意：${warns.join('、')}`,
    )
  },

  'finlab-v4-backfill': (p) => {
    if (!/^FinLab V4 backfill/.test(p.raw)) return undefined
    const status = p.map.get('status')
    const canonical = p.map.get('canonical')
    const issues = [
      p.map.has('macro_context') && p.map.get('macro_context') !== 'ok' && '總經脈絡異常',
      p.map.has('external_evidence') && p.map.get('external_evidence') !== 'ok' && '外部證據異常',
    ].filter(Boolean) as string[]
    const head = status === 'ready' ? 'FinLab V4 回補完成' : `FinLab V4 回補${statusZh(status)}`
    return join(
      head,
      clause(
        p.map.has('rows') && `${isTrue(canonical) ? '正式資料' : '資料'} ${n(p.map.get('rows'))} 列`,
        canonical && !isTrue(canonical) && '非正式資料',
        issues.length === 0 && p.map.has('macro_context') && '總經脈絡與外部證據皆正常',
        p.map.has('dispatch_attempt') && `第 ${p.map.get('dispatch_attempt')} 次派送`,
      ),
      issues.length > 0 && `注意：${issues.join('、')}`,
    )
  },

  'allocator-ev-lifecycle-watchdog': (p) => allocatorLifecycle(p),

  'active8-oof-daily': (p) => active8(p, '每日證據'),
  'active8-oof-weekly': (p) => active8(p, '每週 OOF'),
  'active8-oof-monthly': (p) => active8(p, '每月 OOF'),

  update: (p) => {
    const raw = p.raw
    if (/^FinLab canonical backfill blocked market data continuation:/.test(raw)) return '行情更新被擋：FinLab 正式資料回補未完成，後續行情更新未接續'
    if (/^failed:/.test(raw)) return '行情更新失敗（原因見明細）'
    const m = /^market data update ready for (\d{4}-\d{2}-\d{2})/.exec(raw)
    if (!m) return undefined
    const g = (k: string) => n(p.map.get(k))
    const pe = /valuation_daily_pe canonical=(\d+) raw=(\d+) parity=(\w+)/.exec(raw)
    const pb = /valuation_daily_pb canonical=(\d+) raw=(\d+) parity=(\w+)/.exec(raw)
    const parityOk = pe && pb && pe[3] === 'exact' && pb[3] === 'exact'
    const serving = /market data ready for \S+: price=(\d+) TWSE=(\d+) OTC=(\d+), chip=(\d+), margin=(\d+), indicators=(\d+)/.exec(raw)
    return join(
      `行情更新完成（${m[1]}）`,
      clause(
        g('canonical_market_daily') && `FinLab 正式日線 ${g('canonical_market_daily')} 檔`,
        g('canonical_chip_daily') && `籌碼 ${g('canonical_chip_daily')} 檔`,
        g('canonical_broker_flow_daily') && `券商分點 ${g('canonical_broker_flow_daily')} 檔`,
        g('canonical_broker_rank_daily') && `券商排行 ${g('canonical_broker_rank_daily')} 檔`,
      ),
      serving && `服務表日線 ${n(serving[1])} 檔（上市 ${n(serving[2])}、上櫃 ${n(serving[3])}）、籌碼 ${n(serving[4])}、融資券 ${n(serving[5])}、技術指標 ${n(serving[6])}`,
      pe && pb && (parityOk
        ? `本益比 ${n(pe[1])} 檔、股價淨值比 ${n(pb[1])} 檔與原始資料一致`
        : '注意：本益比或股價淨值比與原始資料不一致'),
      /TWSE\/TPEX supplemental bulk fetch skipped/.test(raw) && 'TWSE/TPEX 補充抓取略過（以 FinLab 為主）',
    )
  },

  'indicator-queue': (p) => {
    const wait = /^indicator queue finalize wait (\d+)\/(\d+) for (\d{4}-\d{2}-\d{2}); run_id=\S+; attempt=(\d+)$/.exec(p.raw)
    if (wait) return `技術指標佇列收尾等待中（${wait[3]}）：${wait[1]}/${wait[2]} 個分片完成，第 ${wait[4]} 次檢查`
    const m = /^indicator queue complete for (\d{4}-\d{2}-\d{2})/.exec(p.raw)
    if (!m) return undefined
    return `技術指標佇列完成（${m[1]}）：${n(p.map.get('shards')) ?? '?'} 個分片處理完畢`
  },

  'regime-compute': (p) => {
    const raw = p.raw
    let m = /regime-compute started for (\d{4}-\d{2}-\d{2})/.exec(raw)
    if (m) return `盤勢判定執行中（${m[1]}）`
    m = /regime-compute failed for (\d{4}-\d{2}-\d{2})/.exec(raw)
    if (m) return `盤勢判定失敗（${m[1]}），原因見明細`
    const label = p.map.get('regime')
    if (!label) return undefined
    const kv = p.map.get('kv')
    return join(
      '盤勢判定完成',
      clause(
        `HMM 判定為「${REGIME_ZH[label] ?? label}」（狀態 ${p.map.get('idx') ?? '?'}）`,
        kv === 'verified' ? 'KV 已驗證' : kv === 'restored' ? 'KV 已從歷史紀錄還原' : undefined,
        p.map.get('source') === 'matching_hmm_version' && '與目前 HMM 版本一致',
        regimeShift(p.map.get('shift')),
      ),
    )
  },

  'strategy-learning-mature-evidence': (p) => {
    if (!p.map.has('mature_signal_date') && !p.map.has('labels')) return undefined
    const blocked = none(p.map.get('blocked')) ? [] : p.map.get('blocked')!.split(',')
    const targeted = p.map.get('targeted')
    const edge = /^(\w+):eligible=(\d+):dates=(\d+)$/.exec(p.map.get('edge') ?? '')
    return join(
      '成熟證據更新完成',
      clause(
        none(p.map.get('mature_signal_date')) ? '尚無成熟訊號日' : `成熟訊號日 ${p.map.get('mature_signal_date')}`,
        p.map.has('inspected_dates') && `檢查 ${n(p.map.get('inspected_dates'))} 日`,
        p.map.has('gaps_before') && `缺口 ${p.map.get('gaps_before')} → ${p.map.get('gaps_after') ?? '?'} 日`,
        !none(targeted) && `本輪補 ${targeted!.split(',').join('、')}，寫入 ${n(p.map.get('labels_persisted')) ?? 0} 筆標籤`,
      ),
      blocked.length > 0 && `仍有 ${blocked.length} 日無法補（${dateRange(blocked)}）`,
      p.map.has('labels') && `標籤 ${n(p.map.get('labels'))} 筆（待成熟 ${n(p.map.get('pending')) ?? 0}、無法取得 ${n(p.map.get('unavailable')) ?? 0}）`,
      edge && `策略邊際效果${edge[1] === 'shadow' ? '為影子模式' : stateOf(edge[1])}，${edge[2]} 個策略合格（${edge[3]} 日樣本）`,
      p.map.has('reward_rows') && `策略回饋紀錄 ${n(p.map.get('reward_rows'))} 筆（來源 ${n(p.map.get('reward_source')) ?? 0} 筆）`,
    )
  },

  screener: (p) => {
    if (!p.map.has('universe')) return undefined
    return join(
      '選股完成',
      `選股母體 ${n(p.map.get('universe'))} 檔 → 候選 ${n(p.map.get('candidates')) ?? '?'} 檔 → 最終 ${n(p.map.get('final')) ?? '?'} 檔`,
      clause(`興櫃 ${n(p.map.get('emerging')) ?? 0} 檔`, `熱門產業 ${n(p.map.get('hot_sectors')) ?? 0} 個`),
      p.map.has('duration_ms') && `耗時 ${durationMs(p.map.get('duration_ms'))}`,
    )
  },

  'screener-v2-watchdog': (p) => {
    const screener = /screener=\{(.*?)\} strategy_learning=\{/s.exec(p.raw)?.[1]
    const learning = /strategy_learning=\{(.*)\}\s*$/s.exec(p.raw)?.[1]
    if (screener === undefined && learning === undefined) return undefined
    const state = compositeStatus(p)
    return join(
      `選股／策略學習補跑檢查${state ? state : ''}`,
      screener !== undefined && (screenerRecovery(screener) ?? '選股補跑狀態見明細'),
      learning !== undefined && (strategyLearningRecovery(learning) ?? '策略學習補跑狀態見明細'),
    )
  },

  'strategy-learning-watchdog': (p) => {
    const s = strategyLearningRecovery(p.raw)
    return s && `策略學習補跑檢查：${s}`
  },

  'allocator-ev-readiness': (p) => {
    const m = /^L4 allocation readiness before pipeline for (\d{4}-\d{2}-\d{2})/.exec(p.raw)
    if (!m) return undefined
    const ready = p.map.get('readiness_state') === 'ready' && p.map.get('action_ready') === '1'
    const alerts = listCount(p.map.get('hard_alerts'))
    const owner = p.map.get('expected_return_owner')
    const serving = p.map.get('expected_return_serving_state')
    return join(
      ready ? `配置就緒檢查通過（${m[1]}）` : `配置就緒檢查失敗（${m[1]}），本日不可執行配置`,
      clause(
        owner === 'l4_distribution' ? '預期報酬由 L4 分布模型供應' : owner === 'none' ? '沒有預期報酬來源' : '預期報酬來源見明細',
        serving === 'production_primary' ? '正式主線' : serving ? '供應狀態見明細' : undefined,
        p.map.get('legacy_ev_oof') === 'retired_incompatible' && '舊版 EV OOF 已退役',
      ),
      alerts > 0 && `硬性告警 ${alerts} 項`,
      ready && '可執行配置',
    )
  },

  'postclose-research-dispatch': (p) => {
    const jobs = p.map.get('research_jobs')
    if (jobs === undefined) return undefined
    if (/^no_published_work/.test(p.raw)) return '盤後研究：今日沒有已發布的工作，未派送'
    const head = p.raw.startsWith('dispatched') ? `盤後研究已派送 ${jobs} 個工作` : `盤後研究派送 ${jobs} 個工作`
    return p.map.get('research_completion') === 'awaiting_callback' ? `${head}，等待完成回呼` : head
  },

  'dataset-snapshot-export': (p) => {
    const detached = /^detached dataset snapshot ready snapshot_id=backtest_dataset:(\d{4}-\d{2}-\d{2}):/.exec(p.raw)
    if (detached) return `研究資料快照已就緒（${detached[1]}，由獨立工作匯出）`
    const rows = p.pairs.filter(([k]) => k === 'rows').map(([, v]) => v)
    const backtest = /backtest=backtest_dataset:(\d{4}-\d{2}-\d{2})/.exec(p.raw)
    if (!backtest || rows.length < 1) return undefined
    return join(
      `研究資料快照已匯出（${backtest[1]}）`,
      clause(`回測資料集 ${n(rows[0])} 列`, rows[1] && p.map.has('price') && `價格歷史 ${n(rows[1])} 列`),
    )
  },

  'model-ic-full-check': (p) => {
    if (!/^IC n_rows=/.test(p.raw)) return undefined
    const config = p.map.get('config')
    return join(
      '模型 IC 全面檢查完成',
      clause(`${n(p.map.get('n_rows')) ?? '?'} 筆樣本`, `晉升佇列 ${n(p.map.get('queue')) ?? 0} 件`),
      config === 'no_challenger' ? '目前沒有挑戰者交易參數組' : config ? `設定${stateOf(config)}` : undefined,
    )
  },

  'kv-config-drift': (p) => {
    if (!/kv_config_drift /.test(p.raw)) return undefined
    const label = (key: string) => (key === 'trading:config' ? '交易設定' : key === 'trading:risk_config' ? '風控設定' : '其他設定')
    const results = p.pairs
      .filter(([k]) => /^trading:/.test(k))
      .map(([k, v]) => ({ key: label(k), status: v.split(':')[0] }))
    const bad = results.filter((r) => r.status !== 'match')
    const kvPart = results.length
      ? bad.length === 0
        ? `${results.map((r) => r.key).join('、')}皆與 manifest 一致`
        : `${bad.map((r) => `${r.key}${r.status === 'drift' ? '與 manifest 不一致' : r.status === 'missing' ? '不存在' : '無法計算 digest'}`).join('、')}`
      : undefined
    const stored = /stored_risk_v2_drift(_error)?\b(.*)$/s.exec(p.raw)
    let storedPart: string | undefined
    let storedBad = Boolean(stored?.[1])
    if (stored?.[1]) storedPart = '已存風控 v2 漂移檢查失敗'
    else if (stored) {
      const s = parse(stored[2])
      // failed>0 時 task 會 throw 記成 error（adminTriggerWorkerDomainTasks），標題不能講完成
      storedBad = Number(s.map.get('failed') ?? 0) > 0
      storedPart = clause(
        `已存風控 v2 漂移檢查 ${n(s.map.get('checked')) ?? 0} 筆${s.map.get('since') ? `（${s.map.get('since')} 起）` : ''}`,
        `${n(s.map.get('failed')) ?? 0} 筆失敗`,
        `${n(s.map.get('policy_changed')) ?? 0} 筆政策變動`,
        s.map.has('skipped_pre_v2') && `略過 v2 前 ${n(s.map.get('skipped_pre_v2'))} 筆`,
      )
    }
    return join(bad.length ? 'KV 設定比對發現漂移' : storedBad ? 'KV 設定比對發現問題' : 'KV 設定比對完成', kvPart, storedPart)
  },

  'news-analyst': (p) => {
    const wait = premarketWait(p.raw, 'news-analyst', '新聞分析')
    if (wait) return wait
    const bias = p.map.get('bias')
    if (!bias) return undefined
    return `新聞分析：市場情緒${BIAS_ZH[bias] ?? '見明細'}（信心 ${p.map.get('conf') ?? '?'}），${n(p.map.get('factors')) ?? 0} 個關鍵因素`
  },

  'morning-setup': (p) => {
    if (/^status=success event_stage=setup/.test(p.raw)) return '盤前設定完成，後續階段立即接續'
    if (/^status=error event_stage=/.test(p.raw)) return `盤前設定失敗：卡在${stageAt(premarketStage(p.map.get('event_stage')))}`
    return premarketEventChain(p)
  },

  'premarket-evidence-watchdog': (p) => {
    const raw = p.raw
    if (/^status=skipped premarket_outside_window/.test(raw)) return '不在盤前時段，略過檢查'
    if (/^status=skipped premarket_non_trading_day/.test(raw)) return '非交易日，略過盤前檢查'
    if (/^status=error premarket_event_chain overdue=true/.test(raw)) {
      return `盤前流程逾時未完成：卡在${stageAt(premarketStage(p.map.get('stage')))}，目標時間 ${p.map.get('ready_target') ?? '未知'}`
    }
    const wrapped = /^本次盤前鏈檢查已完成，等待下游階段；(.*)$/s.exec(raw)
    if (wrapped) {
      const inner = premarketEventChain(parse(wrapped[1]))
      return inner && `本次盤前鏈檢查已完成，等待下游階段：${inner}`
    }
    return premarketEventChain(p)
  },

  'external-evidence': (p) => {
    const http = /^external evidence materialize HTTP(\d{3})\b/.exec(p.raw)
    if (http) return `外部證據產生失敗：controller 回應 HTTP ${http[1]}${http[1] === '524' ? '（逾時）' : ''}`
    if (!/^external evidence /.test(p.raw)) return undefined
    const receipt = p.map.get('receipt')
    const gdelt = p.map.get('gdelt')
    const gdeltZh = gdelt === 'ok' || gdelt === 'success' ? 'GDELT 抓取成功' : gdelt === 'fetch_failed' ? 'GDELT 抓取失敗' : gdelt ? 'GDELT 狀態見明細' : undefined
    return join(
      receipt === 'ready' || receipt === 'ready_via_d1_readback'
        ? `外部證據已就緒（${p.map.get('target')}）`
        : `外部證據未就緒（${p.map.get('target')}）`,
      receipt === 'ready_via_d1_readback' && 'controller 逾時（HTTP 524），改由 D1 讀回確認',
      clause(
        gdeltZh && `${gdeltZh}${p.map.has('items') ? `，建立 ${n(p.map.get('items'))} 則` : ''}`,
        p.map.has('stock_theme_features') && `個股題材特徵 ${n(p.map.get('stock_theme_features'))} 筆`,
      ),
      p.map.has('d1_queries') && `D1 查詢 ${n(p.map.get('d1_queries'))} 次、重試 ${n(p.map.get('d1_retries')) ?? 0} 次、寫入 ${n(p.map.get('write_batches')) ?? 0} 批`,
    )
  },

  'debate-memory-retention': (p) => {
    if (!p.map.has('deleted') || !p.map.has('rows_read')) return undefined
    return `辯論記憶保留期清理：讀取 ${n(p.map.get('rows_read'))} 筆、刪除 ${n(p.map.get('deleted'))} 筆`
  },

  'artifact-reconcile': (p) => {
    const failed = /^artifact reconcile failed (\{.*\})$/s.exec(p.raw)
    if (failed) return integrityFailure('Artifact 對帳失敗', failed[1])
    if (!/^artifact_reconcile /.test(p.raw)) return undefined
    const checked = Number(p.map.get('checked'))
    const verified = Number(p.map.get('verified'))
    return join(
      'Artifact 對帳完成',
      `檢查 ${n(checked)} 件、驗證通過 ${n(verified)} 件`,
      `配置器引用檢查 ${n(p.map.get('allocator_refs_checked')) ?? 0} 件、釋放 ${n(p.map.get('allocator_refs_released')) ?? 0} 件、略過 ${n(p.map.get('allocator_refs_skipped')) ?? 0} 件`,
      verified < checked && `注意：${n(checked - verified)} 件未通過驗證`,
    )
  },

  'retention-archive-only': (p) => {
    if (!/^retention_archive_only /.test(p.raw)) return undefined
    const status = p.map.get('status')
    const policies = /^(\d+)\/(\d+)$/.exec(p.map.get('policies') ?? '')
    const failed = listCount(p.map.get('failed'))
    return join(
      `保留期封存${status === 'success' ? '完成' : statusZh(status)}（${p.map.get('date')}）`,
      policies && `${policies[1]}/${policies[2]} 項政策成功`,
      clause(
        `掃描 ${n(p.map.get('scanned')) ?? 0} 列`,
        `封存 ${n(p.map.get('archived')) ?? 0} 列${p.map.has('bytes') ? `（${bytes(p.map.get('bytes'))}）` : ''}`,
        `刪除 ${n(p.map.get('deleted')) ?? 0} 列`,
      ),
      failed > 0 && `注意：${failed} 項政策失敗`,
      isTrue(p.map.get('backlog_remaining')) && '仍有積壓待下輪處理',
    )
  },

  'retention-hot-window-drain': (p) => {
    if (!/^retention_hot_window_drain /.test(p.raw)) return undefined
    const dry = isTrue(p.map.get('dry_run'))
    const status = p.map.get('status')
    const failed = listCount(p.map.get('failed'))
    const pending = listCount(p.map.get('pending'))
    const stop = p.map.get('stop')
    return join(
      `熱資料視窗清理${status === 'error' || failed > 0 ? (dry ? '預檢失敗（dry run，未寫入）' : '失敗') : dry ? '預檢（dry run，未寫入）' : status === 'success' ? '完成' : statusZh(status)}`,
      clause(
        `${n(p.map.get('policies')) ?? '?'} 項政策嘗試 ${n(p.map.get('attempts')) ?? '?'} 次`,
        stop === 'preflight' ? '於預檢階段停止' : stop && stop !== 'none' && stop !== 'complete' ? '提前停止（原因見明細）' : undefined,
      ),
      clause(
        `掃描 ${n(p.map.get('scanned')) ?? 0} 列`,
        `封存 ${n(p.map.get('archived')) ?? 0} 列`,
        `刪除 ${n(p.map.get('deleted')) ?? 0} 列`,
      ),
      clause(
        pending > 0 && `${pending} 項政策待處理`,
        Number(p.map.get('blocked')) > 0 && `${n(p.map.get('blocked'))} 個資料集被擋`,
        failed > 0 && `${failed} 項政策失敗`,
      ),
      isTrue(p.map.get('backlog')) && '仍有積壓',
    )
  },

  'legacy-hot-data-retirement': (p) => {
    if (!/^legacy_hot_data_retirement /.test(p.raw)) return undefined
    const dry = isTrue(p.map.get('dry_run'))
    const targets = [...p.raw.matchAll(/(\w+):archived=(\d+),deleted=(\d+),artifacts=(\d+),backlog=(\w+)/g)]
    const skipped = [...p.raw.matchAll(/(\w+):skipped=/g)]
    if (targets.length === 0 && skipped.length === 0) return undefined
    return join(
      `舊熱資料退役${dry ? '（dry run，未寫入）' : '完成'}`,
      ...targets.map((m) => `${LEGACY_TARGET_ZH[m[1]] ?? '其他資料'}封存 ${n(m[2])}、刪除 ${n(m[3])}、artifact ${n(m[4])}${m[5] === 'true' ? '，仍有積壓' : '，無積壓'}`),
      skipped.length > 0 && `${skipped.map((m) => LEGACY_TARGET_ZH[m[1]] ?? '其他資料').join('、')}本輪略過`,
    )
  },

  'r2-retention-sweep': (p) => {
    if (!/^r2_retention_sweep /.test(p.raw)) return undefined
    return join(
      'R2 保留期清理',
      `候選 ${n(p.map.get('candidates')) ?? 0} 件、刪除 ${n(p.map.get('deleted')) ?? 0} 件、略過 ${n(p.map.get('skipped')) ?? 0} 件`,
      clause(
        isTrue(p.map.get('budget_exhausted')) && '本輪額度用盡',
        isTrue(p.map.get('backlog_remaining')) ? '仍有積壓待下輪處理' : '無積壓',
      ),
    )
  },

  'audit-json-retention': (p) => {
    const raw = p.raw
    const legacy = /^audit_json_retention status=(\w+) durable=\w+ queued=(\w+) reason=(\w+)/.exec(raw)
    if (legacy) {
      if (legacy[3] === 'failure_cooldown') return '稽核 JSON 清理在失敗後冷卻中，本輪未執行'
      if (legacy[3] === 'active') return '稽核 JSON 清理已有一輪在執行，本輪略過'
      return undefined
    }
    const complete = /^durable_drain complete audit-json-retention confirmed date=(\S+) cutoff=(\S+) retention_days=(\d+) total_archived=(\d+) total_scrubbed=(\d+) bytes=(\d+)/.exec(raw)
    if (complete) {
      return `稽核 JSON 清理完成（${complete[1]}）：保留 ${complete[3]} 天，清理 ${complete[2]} 以前的資料；封存 ${n(complete[4])} 筆、清除 ${n(complete[5])} 筆（${bytes(complete[6])}）`
    }
    if (!/^durable_drain /.test(raw)) return undefined
    const backlog = isTrue(p.map.get('backlog_remaining')) ? '，仍有積壓' : ''
    if (p.map.get('deferred') === 'window_closed') {
      return `稽核 JSON 清理延後：不在執行時段（UTC ${p.map.get('utc_window') ?? '?'}）${backlog}`
    }
    if (/^durable_drain queued/.test(raw)) return '稽核 JSON 清理已排入佇列，等待完成'
    if (/^durable_drain failed/.test(raw)) return `稽核 JSON 清理失敗，自動接續已停止${backlog}`
    if (/^durable_drain retry_pending/.test(raw)) return `稽核 JSON 清理等待重試（第 ${p.map.get('failure_attempt') ?? '?'} 次失敗）${backlog}`
    if (/^durable_drain owner_superseded/.test(raw)) return `稽核 JSON 清理已由新一輪接手，本輪略過${backlog}`
    if (/^durable_drain continuation_send_failed/.test(raw)) return `稽核 JSON 清理接續訊息送出失敗${backlog}`
    if (p.map.has('terminal')) return `稽核 JSON 清理結束：${statusZh(p.map.get('terminal'))}`
    return undefined
  },

  'orphan-reachability-gc': (p) => {
    if (!/^orphan_reachability_gc /.test(p.raw)) return undefined
    return `孤兒資料回收：掃描 ${n(p.map.get('scanned')) ?? 0} 件、刪除 ${n(p.map.get('deleted')) ?? 0} 件、仍被引用 ${n(p.map.get('referenced')) ?? 0} 件`
  },

  'post-close-price-refresh': (p) => postClosePriceCache(p),

  'weekly-audit': (p) => {
    const m = /^report verified date=(\d{4}-\d{2}-\d{2})/.exec(p.raw)
    return m ? `週稽核報告已驗證（${m[1]}）` : undefined
  },

  'weekly-cleanup': (p) => {
    if (!/^weekly_cleanup_v2 /.test(p.raw)) return undefined
    type Tasks = { ok?: boolean; tasks?: Array<{ ok?: boolean; changed?: number }> }
    const cleanup = json<Tasks>(p.map.get('cleanup'))
    const maintenance = json<Tasks>(p.map.get('maintenance'))
    const all = [...(cleanup?.tasks ?? []), ...(maintenance?.tasks ?? [])]
    const failed = all.filter((t) => t.ok === false).length
    const changed = all.reduce((sum, t) => sum + Number(t.changed ?? 0), 0)
    const kelly = (p.map.get('paper-kelly') ?? '').split(':')[0]
    const challenger = p.pairs.some(([k, v]) => k === 'dry-run' && v === 'no_challenger')
    return join(
      failed ? '每週清理有項目失敗' : '每週清理完成',
      clause(
        `清理 ${cleanup?.tasks?.length ?? 0} 項、維護 ${maintenance?.tasks?.length ?? 0} 項${failed ? `，${failed} 項失敗` : '皆成功'}`,
        `共變更 ${n(changed)} 筆`,
      ),
      p.map.get('readback') && clause(
        `模型登錄讀回${p.map.get('readback') === 'ok' ? '正常' : '異常'}`,
        p.map.has('queue') && `佇列 ${n(p.map.get('queue'))} 件（自動 ${n(p.map.get('auto')) ?? 0}、擋下 ${n(p.map.get('blocked')) ?? 0}）`,
      ),
      challenger && '參數生命週期試跑：沒有挑戰者參數組',
      kelly === 'pending_maturity' ? 'Paper Kelly 校準等待樣本成熟' : kelly ? `Paper Kelly 校準${statusZh(kelly)}` : undefined,
    )
  },

  'alpha-quality': (p) => {
    const raw = p.raw
    const skip = /^skipped:(\w+) \((\d+)\/([\d-]+)\)/.exec(raw)
    if (skip) return `Alpha 品質檢查略過：${reason(skip[1])}（樣本 ${n(skip[2])}/${skip[3]}）`
    if (/^failed/.test(raw)) return 'Alpha 品質檢查失敗（原因見明細）'
    if (!p.map.has('samples')) return undefined
    const weak = /weak=\[([^\]]*)\]/.exec(raw)?.[1]
    const buckets = weak ? weak.split(',').map((s) => {
      const i = s.lastIndexOf(':')
      const value = Number(s.slice(i + 1))
      return `${ALPHA_BUCKET_ZH[s.slice(0, i)] ?? '其他策略'} ${Number.isFinite(value) ? value.toFixed(2) : '?'}R`
    }) : []
    return join(
      'Alpha 品質檢查',
      `${n(p.map.get('samples'))} 筆樣本、${n(p.map.get('alerts')) ?? 0} 個警示`,
      buckets.length > 0 && `平均損益為負的策略（列出前 ${buckets.length} 個）：${buckets.join('、')}`,
    )
  },

  'adaptive-meta-policy-replay': (p) => {
    if (!/^adaptive_meta_replay /.test(p.raw)) return undefined
    const status = p.map.get('status')
    const gates = (p.map.get('gates') ?? '').split(',').filter(Boolean)
    const passed = gates.filter((g) => g.endsWith(':pass')).length
    const failedGates = (p.map.get('failed_gates') ?? '').split(',').filter((g) => g && g !== 'none')
    const best = p.map.get('best')
    return join(
      `自適應元策略回放${status === 'pass' ? '通過' : status === 'fail' ? '未通過' : statusZh(status)}`,
      clause(
        best && best !== 'none' && `最佳方法 ${best}`,
        failedGates.includes('beats_current_heuristic') && '未能勝過現行經驗法則',
        gates.length > 0 && `${gates.length} 項關卡 ${passed} 項通過`,
      ),
      clause(
        p.map.has('source_rows') && `${n(p.map.get('source_rows'))} 筆資料`,
        p.map.has('windows') && `${n(p.map.get('windows'))} 個驗證視窗`,
      ),
      p.map.get('allowed_use') === 'research_only' && '僅供研究，不調整配置',
      p.map.get('meta_controller') === 'reject' && '元控制器拒絕套用',
    )
  },

  's12-smcvwap-calibration': (p) => {
    if (!/^s12_tw_calibration /.test(p.raw)) return undefined
    const status = p.map.get('status')
    const failedGates = json<Record<string, unknown>>(p.map.get('failed_gates'))
    const failedCount = failedGates ? Object.keys(failedGates).length : 0
    return join(
      `S12 SMC/VWAP ${p.map.get('cadence') === 'weekly' ? '每週' : ''}校準${status === 'frozen' ? '凍結中（不寫入參數）' : status === 'promoted' ? '完成並已套用新參數' : status === 'validated' ? '驗證通過（試跑，未套用）' : status === 'success' ? '完成' : statusZh(status)}`,
      clause(
        `證據 ${n(p.map.get('evidence')) ?? 0} 筆、${n(p.map.get('scopes')) ?? 0} 個範圍`,
        `候選 ${n(p.map.get('candidates')) ?? 0}（核准 ${n(p.map.get('approved')) ?? 0}、否決 ${n(p.map.get('rejected')) ?? 0}）`,
        `寫入 ${n(p.map.get('written')) ?? 0}`,
      ),
      p.map.has('lifecycle_complete') && clause(
        `生命週期完成 ${n(p.map.get('lifecycle_complete'))} 筆`,
        `待結束 ${n(p.map.get('lifecycle_pending_terminal')) ?? 0} 筆`,
        `排除缺漏或其他 ${n(p.map.get('lifecycle_missing_or_other_excluded')) ?? 0} 筆`,
      ),
      failedCount > 0 && `${failedCount} 項關卡未通過`,
    )
  },

  'linucb-multiplier-replay': (p) => {
    if (!/^linucb_multiplier_replay /.test(p.raw)) return undefined
    const status = p.map.get('status')
    const gates = (p.map.get('gates') ?? '').split(',').filter(Boolean)
    const passed = gates.filter((g) => g.endsWith(':pass')).length
    const failedGates = (p.map.get('failed_gates') ?? '').split(',').filter((g) => g && g !== 'none')
    const high = p.map.get('high')
    return join(
      `LinUCB 乘數回放${status === 'pass' ? '通過' : status === 'fail' ? '未通過' : statusZh(status)}`,
      clause(
        failedGates.includes('beats_baseline') && '未勝過基準',
        gates.length > 0 && `${gates.length} 項關卡 ${passed} 項通過`,
      ),
      clause(
        p.map.has('source_rows') && `${n(p.map.get('source_rows'))} 筆資料`,
        p.map.has('candidates') && `${n(p.map.get('candidates'))} 組候選`,
        high && `最佳組合：高損失門檻 ${high}、中損失門檻 ${p.map.get('med') ?? '?'}、低檔乘數上限 ${p.map.get('maxLow') ?? '?'}`,
      ),
      p.map.get('allowed_use') === 'research_only' && '僅供研究，不調整配置',
    )
  },

  'storage-capacity-report': (p) => {
    if (!/^storage_capacity_report /.test(p.raw)) return undefined
    type Domain = { domain: string; role?: string; judged?: boolean; days_to_90pct?: number; alert?: boolean }
    type Capacity = { domain: string; role?: string; utilization_pct?: number; status?: string }
    type OldRunway = { domain: string; utilization_pct?: number; forecast_status?: string; projected_days_to_critical_90pct?: number }
    const health = json<{
      healthy?: boolean; capacity_runway?: OldRunway[]; capacity_runway_alert_days?: number; capacity_runway_alert_domains?: string[]
    }>(p.map.get('health'))
    const d1 = json<Capacity[]>(p.map.get('d1'))
    // 11/24 前的舊版報告沒有 runway=，容量跑道放在 health.capacity_runway；當時還沒有凍結舊庫的 role，全部列入判定
    const runway = json<{ alert_days?: number; alert_domains?: string[]; domains?: Domain[] }>(p.map.get('runway'))
      ?? (Array.isArray(health?.capacity_runway) ? {
        alert_days: health!.capacity_runway_alert_days,
        alert_domains: health!.capacity_runway_alert_domains,
        domains: health!.capacity_runway!
          .filter((d) => d.forecast_status === 'ready' && Number(d.utilization_pct) < 90)
          .map((d) => ({ domain: d.domain, judged: true, days_to_90pct: d.projected_days_to_critical_90pct })),
      } : undefined)
    if (!runway?.domains) return undefined
    const judged = runway.domains.filter((d) => d.judged)
    const nearest = [...judged].sort((a, b) => Number(a.days_to_90pct) - Number(b.days_to_90pct)).slice(0, 2)
    const alerts = runway.alert_domains ?? []
    const frozen = (d1 ?? []).filter((d) => d.role === 'frozen_rollback_source')
    const warned = (d1 ?? []).filter((d) => d.role !== 'frozen_rollback_source' && ['warning', 'drain', 'critical'].includes(d.status ?? ''))
    const level = (d: Capacity) => (d.status === 'critical' ? '已超過 90% 上限警戒' : d.status === 'drain' ? '已超過 75%（清理模式）' : '已超過 65% 警戒線')
    const pct = (d: Capacity) => `${Number(d.utilization_pct).toFixed(1)}%`
    return join(
      `儲存容量報告（${p.map.get('observed_date')}）`,
      alerts.length
        ? `注意：${alerts.join('、')} 將在 ${runway.alert_days ?? 30} 天內達 90%`
        : `${judged.length} 個使用中 D1 皆無 ${runway.alert_days ?? 30} 天內達 90% 的告警`,
      warned.length > 0 && `注意：${warned.map((d) => `${d.domain} ${pct(d)} ${level(d)}`).join('、')}`,
      nearest.length > 0 && `最接近 90% 的是 ${nearest.map((d) => `${d.domain}（約 ${n(d.days_to_90pct)} 天）`).join('、')}`,
      health && `儲存健康檢查${health.healthy ? '正常' : '異常'}`,
      frozen.length > 0 && `凍結的 ${frozen.map((d) => `${d.domain} 庫使用率 ${pct(d)}`).join('、')}（不列入判定）`,
    )
  },
}

function regimeShift(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (value === 'same') return '盤勢未切換'
  const m = /^shift:(\w+)→(\w+)/.exec(value)
  if (m) return `盤勢由${REGIME_ZH[m[1]] ?? '其他'}切換為${REGIME_ZH[m[2]] ?? '其他'}`
  return undefined
}

function active8(p: Parsed, label: string): string | undefined {
  if (/^run_id=active8-oof-\w+:\d{4}-\d{2}-\d{2}:/.test(p.raw)) return active8Resolved(p, label)
  if (!/^active8_oof_lifecycle status=/.test(p.raw)) return undefined
  const status = p.map.get('status')
  const r = p.map.get('reason')
  const dispatched = p.map.get('job_dispatched')
  const detail = clause(
    p.map.get('signal_date') && `訊號日 ${p.map.get('signal_date')}`,
    p.map.get('pipeline_status') && `Pipeline ${statusZh(p.map.get('pipeline_status'))}`,
  )
  if (status === 'skipped' || status === 'pending') {
    const waiting = status === 'pending' || /^awaiting_/.test(r ?? '')
    return `Active-8 ${label}${/[A-Za-z0-9]$/.test(label) ? ' ' : ''}${waiting ? '尚未執行' : '略過'}：${reason(r)}${detail ? `（${detail}）` : ''}${dispatched === 'false' ? '，未派送工作' : ''}`
  }
  const cohort = p.map.get('cohort')
  return join(
    `Active-8 ${label}${/[A-Za-z0-9]$/.test(label) ? ' ' : ''}${status === 'success' ? '完成' : statusZh(status)}`,
    clause(
      cohort && cohort !== 'none' && '已產生 cohort',
      p.map.has('promoted') && (isTrue(p.map.get('promoted')) ? '已晉升' : '未晉升'),
      r && r !== 'none' && `原因：${reason(r)}`,
    ),
  )
}

function postClosePriceCache(p: Parsed): string | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(p.map.get('post_close_price_cache_refreshed') ?? '')
  if (!m) return undefined
  const failed = Number(p.map.get('failed') ?? 0)
  const total = Number(m[2])
  if (total === 0) return `持倉收盤價快取（${p.map.get('date')}）：目前沒有持倉，無需更新`
  return join(
    `持倉收盤價快取（${p.map.get('date')}）`,
    `${m[1]}/${m[2]} 檔更新成功${failed > 0 ? `，${failed} 檔失敗` : ''}`,
  )
}

// ── 第二批：非 key=value 摘要（JSON／英文句）、通用排程句、Pipeline 執行中 ─────────────────────

/** D1 的 datetime('now') 是 UTC（'YYYY-MM-DD HH:MM:SS'）；畫面一律台灣時間。 */
function twTime(utc: string | undefined): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(utc ?? '')
  if (!m) return undefined
  const ms = Date.parse(`${m[1]}T${m[2]}:${m[3]}:00Z`)
  if (!Number.isFinite(ms)) return undefined
  const tw = new Date(ms + 8 * 3600_000).toISOString()
  return `台灣時間 ${tw.slice(0, 10)} ${tw.slice(11, 16)}`
}

/** schedulerStatus formatAgeForSummary 的「1h5m」「45m」。 */
function age(text: string): string | undefined {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text)
  if (!m || (!m[1] && !m[2])) return undefined
  return [m[1] && `${m[1]} 小時`, m[2] && `${m[2]} 分`].filter(Boolean).join(' ')
}

function pct(value: unknown, digits = 2): string | undefined {
  const num = Number(value)
  if (value === null || value === undefined || !Number.isFinite(num)) return undefined
  const v = num * 100
  return `${v > 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function fixed(value: unknown, digits = 2): string | undefined {
  const num = Number(value)
  return value === null || value === undefined || !Number.isFinite(num) ? undefined : num.toFixed(digits)
}

function jsonTail<T = Record<string, any>>(raw: string, prefix: RegExp): T | undefined {
  const m = prefix.exec(raw)
  if (!m) return undefined
  return json<T>(raw.slice(m[0].length).trim())
}

/** 排程表的 job id（也出現在租約、就緒檢查、後續鏈摘要裡）→ 中文名。認不得一律「其他工作」。 */
const TASK_ZH: Record<string, string> = {
  'audit-json-retention': '稽核 JSON 清理', 'artifact-reconcile': 'Artifact 對帳', 's12-replay-lifecycle': 'S12 重播生命週期',
  'retention-archive-only': '保留期封存', 'retention-hot-window-drain': '熱資料視窗清理', 'legacy-hot-data-retirement': '舊熱資料退役',
  'r2-retention-sweep': 'R2 保留期清理', 'orphan-reachability-gc': '孤兒資料回收', 'debate-memory-retention': '辯論記憶保留期清理',
  'legacy-strategy-evidence-migration': '舊策略證據搬遷', 'storage-integrity-audit': '儲存完整性稽核', 'storage-health-check': '儲存健康檢查',
  'weekly-backtest': '每週回測', 'weekly-optuna': '每週 Optuna', 'sector-leaders': '產業龍頭', 'adaptive-meta-policy-replay': '自適應元策略回放',
  'linucb-multiplier-replay': 'LinUCB 乘數回放', 'active8-oof-weekly': 'Active-8 每週 OOF', 'active8-oof-monthly': 'Active-8 每月 OOF',
  'active8-oof-daily': 'Active-8 每日證據', 'monthly-strategy-mining': '每月策略挖掘', 'monthly-optuna': '每月 Optuna',
  'weekly-drift-retrain': '每週漂移重訓', 'weekly-cleanup': '每週清理', 'weekly-audit': '週稽核', 'alpha-quality': 'Alpha 品質檢查',
  's12-smcvwap-calibration': 'S12 SMC/VWAP 校準', 'model-ic-full-check': '模型 IC 全面檢查',
  'active8-action-authority': 'Active-8 行動授權', 'allocator-ev-feature-snapshot-backfill': '配置器特徵快照',
  'pit-residual-funnel-enrichment': 'PIT 殘差漏斗補充', 'pit-residual-funnel-recovery': 'PIT 殘差漏斗補救', 'verify-v2': '預測驗證',
  'strategy-learning': '策略學習', 'linucb-reward-ledger': 'LinUCB 回饋帳本', adapt: '自適應參數更新', 'daily-report': '每日報告',
  'paper-active-postmarket': '模擬盤盤後評估', 'obsidian-sync': 'Obsidian 同步', 'meta-learning-shadow': '元學習影子',
  'paper-intraday-cache-clear': '盤中價格快取清除', 'model-ic-rolling': '滾動 IC', 'price-horizon-projection': '價格期間標籤',
  'strategy-multi-horizon-outcomes': '策略多期間結果', 'strategy-evidence-current': '策略現行證據',
}
const taskZh = (id: string | undefined) => (id ? TASK_ZH[id] : undefined) ?? '其他工作'

const PENDING_PLAN_ZH: Record<string, string> = { ready: '交易計畫已就緒', empty: '今日無待買標的', halted: '交易計畫已暫停' }

const PIPELINE_PHASE_ZH: Record<string, string> = {
  startup: '工作啟動', node_load_inputs: '讀取選股輸入', node_load_market_env: '市場環境', node_attach_serving_context: '服務合約驗證',
  node_prepare_l2_inputs: 'L2 前輸入封存', node_resume_l2_inputs: 'L2 前輸入重新驗證', awaiting_premarket: '次交易日盤前資訊',
  modal_prediction: 'L3 模型運算結果', input_prep: '特徵批次結果', input_adjusted: '還原股價', node_capture_atomic_inputs: 'Atomic 輸入重播',
  input_snapshot: '輸入快照匯出', feature_preparation: '特徵資料準備', node_build_payloads: '特徵與推論輸入',
  node_prepare_sequence_inputs: '序列與 L2 輸入準備', seal_l2_inputs: '封存 L2 輸入', prepare_prediction_request: '準備 L3 請求',
  dispatch_prediction: '派送 L3 模型', node_l2_timesfm_enrich: 'L2 時序特徵', modal_inference: 'Modal 模型推論',
  node_l3_formal_predict: 'L3 結果驗證與整合', seal_l3_results: '封存 L3 結果', node_compute_personas: '推薦特徵', node_recommend: 'L4 配置',
  node_llm_reasons: '推薦說明', node_write_d1: '寫入結果', node_paired_nav_setup: '配對證據', node_compute_sector_flow: '產業資金流',
  node_compute_pit_residual_shadow: '殘差證據', node_export_dataset_snapshot: '研究快照',
}
const PHASE_STATUS_ZH: Record<string, string> = {
  running: '執行中', waiting: '等待依賴', completed: '階段結束', failed: '階段失敗', blocked: '輸入條件未滿足',
}

const STORAGE_ADMISSION_ZH: Record<string, string> = {
  legacy_d1_capacity_unknown: '讀不到 D1 容量', critical_blocks_high_write_producer: 'D1 使用率已達 90% 上限，高寫入工作暫停',
}

const SEALED_SENTENCE = 'L3 已封存，等待下一交易日盤前接續；Cloud Run 已停止運算'

/** 所有 job 共用的排程框架句（租約、票據、持久階段、派生、過期、觸發）。認不得回 undefined。 */
const GENERIC: Array<(raw: string) => string | undefined> = [
  (raw) => {
    const m = /^skipped non-production-authoritative callback run_date=(\d{4}-\d{2}-\d{2}); \S+ is live-canonical only$/.exec(raw)
    return m ? `未執行：${m[1]} 只以歷史重播送達，這個工作只在正式當日執行` : undefined
  },
  (raw) => {
    const m = /^maintenance_lease_busy:([a-z0-9-]+?)(?::queue)?:(.+)$/.exec(raw)
    if (!m) return undefined
    const until = twTime(m[2])
    return `維護租約正被「${taskZh(m[1])}」使用${until ? `（租約到期 ${until}）` : ''}，本輪未執行`
  },
  (raw) => (raw === 'admitted delivery ended before execution started' ? '排程已受理，但在開始執行前中斷，本輪未執行' : undefined),
  (raw) => (raw === 'sync delivery ended after execution started without settling its ticket'
    ? '開始執行後同步連線中斷，沒有寫回結果，本輪結果不明' : undefined),
  (raw) => (/^[a-z0-9-]+ requires sync=1\b/.test(raw) ? '觸發方式不符：此工作必須以同步模式觸發，已擋下未執行' : undefined),
  (raw) => {
    const m = /^blocked by storage admission: (\S+) utilization=([\d.]+|unknown)%$/.exec(raw)
    if (!m) return undefined
    return `儲存容量管制擋下，未執行：${STORAGE_ADMISSION_ZH[m[1]] ?? '原因代碼見明細'}（使用率${m[2] === 'unknown' ? '未知' : ` ${m[2]}%`}）`
  },
  (raw) => (raw === 'historical learning lineage boundary blocked' ? '歷史學習資料邊界擋下補跑，未執行' : undefined),
  (raw) => {
    const m = /^(\w+); durable stage=\S+ run_id=\S+ attempt=(\d+)$/.exec(raw)
    if (!m) return undefined
    if (m[1] === 'Recovered') return `先前失敗，已由持久階段紀錄確認恢復成功（第 ${m[2]} 次嘗試）`
    return STATUS_ZH[m[1]] ? `持久階段紀錄：${STATUS_ZH[m[1]]}（第 ${m[2]} 次嘗試）` : undefined
  },
  (raw) => {
    const m = /^(\w+); durable scheduler execution ticket$/.exec(raw)
    return m && STATUS_ZH[m[1]] ? `執行票據狀態：${STATUS_ZH[m[1]]}` : undefined
  },
  (raw) => {
    if (/^scheduler_ticket_accepted_before_schedule; historical record is not current-cycle completion;/.test(raw)) {
      return '執行票據早於排程時間受理，屬於舊紀錄，不算本輪完成'
    }
    if (/^scheduler_ticket_dispatch_is_not_closure; historical record is not current-cycle completion;/.test(raw)) {
      return '執行票據只記到派送，不代表本輪已完成'
    }
    return undefined
  },
  (raw) => {
    let m = /^derived from pipeline: (\d+) (predictions|recommendations); duration is parent elapsed time$/.exec(raw)
    if (m) return `由 Pipeline 結果推得：${m[2] === 'predictions' ? `已寫入 ${n(m[1])} 筆預測` : `已更新 ${n(m[1])} 筆推薦`}（耗時為 Pipeline 整體時間）`
    m = /^derived from pipeline: \S+ started; duration is parent elapsed time$/.exec(raw)
    return m ? '由 Pipeline 結果推得：已隨 Pipeline 開始執行（耗時為 Pipeline 整體時間）' : undefined
  },
  (raw) => (/^(?:Error: )?D1_ERROR: D1 DB is overloaded/.test(raw) ? 'D1 資料庫過載（10 秒內資源用量超限），本次未完成' : undefined),
  (raw) => {
    const m = /^stale (\w+): no final callback after (\S+); SLA (\S+)$/.exec(raw)
    if (!m || !age(m[2]) || !age(m[3])) return undefined
    return `超過時限仍未收到完成回呼（已過 ${age(m[2])}，時限 ${age(m[3])}），視為失敗`
  },
  (raw) => {
    if (!/^triggered\b.*\bcallback expected$/.test(raw)) return undefined
    const attempt = /\bdispatch_attempt=(\d+)\b/.exec(raw)?.[1]
    return `已觸發，等待完成回呼${attempt ? `（第 ${attempt} 次派送）` : ''}`
  },
  (raw) => {
    const m = /^status=(\w+) producer_stage=premarket_v2:(news-analyst|us-leading) attempt=(\d+)$/.exec(raw)
    if (!m) return undefined
    const name = m[2] === 'news-analyst' ? '新聞分析' : '美股領先指標'
    const state = { success: '已完成', running: '執行中', waiting: '等待中', error: '失敗' }[m[1]]
    return state ? `盤前${name}${state}（第 ${m[3]} 次嘗試）` : undefined
  },
]

/** premarket_event_chain 進度句（morning-setup／premarket-evidence-watchdog）。 */
function premarketEventChain(p: Parsed): string | undefined {
  const m = /^status=(pending|success) premarket_event_chain queued=(\d+) ready_target=(\d{1,2}:\d{2}) overdue=false stage=(\S+)$/.exec(p.raw)
  if (!m) return undefined
  if (m[1] === 'success' && m[4] === 'complete') return `盤前流程已完成（目標 ${m[3]}）`
  if (m[1] !== 'pending') return undefined
  return `盤前流程進行中：目前在${stageAt(premarketStage(m[4]))}，佇列 ${m[2]} 件，目標 ${m[3]} 前完成`
}

/** premarket_wait:<stage>:running:attempt=N:next=<UTC>（producer 租約還在別的執行手上）。 */
function premarketWait(raw: string, stage: string, name: string): string | undefined {
  const m = /^status=pending premarket_wait:([a-z-]+):running:attempt=(\d+):next=(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/.exec(raw)
  if (!m || m[1] !== stage) return undefined
  return `${name}仍在執行（第 ${m[2]} 次嘗試），本輪租約到期 ${twTime(m[3])}`
}

/** artifact 稽核失敗 JSON：{checked, verified, missing, mismatched, errors[]}。 */
function integrityFailure(head: string, body: string): string | undefined {
  const r = json<{ checked?: number; verified?: number; missing?: number; mismatched?: number; errors?: string[] }>(body)
  if (!r || r.checked === undefined) return undefined
  const errors = Array.isArray(r.errors) ? r.errors : []
  const overloaded = errors.filter((e) => /D1 DB is overloaded/.test(String(e))).length
  return join(
    head,
    `檢查 ${n(r.checked)} 件、驗證通過 ${n(r.verified) ?? 0} 件`,
    clause(`遺失 ${n(r.missing) ?? 0}`, `不一致 ${n(r.mismatched) ?? 0}`, `讀取錯誤 ${n(errors.length)}`),
    overloaded > 0 && `其中 ${overloaded} 件因 D1 過載讀不到（不是資料損壞）`,
  )
}

/** 單日補救句：status=<s> allocator EV lifecycle <phrase> date=<D> …（allocatorEvDailyLifecycle.ts）。 */
const LIFECYCLE_PHRASES: Array<[RegExp, string]> = [
  [/^recovery_dispatch=post_verify_queued\b/, '已重新排入驗證後續鏈'],
  [/^recovery_dispatch=post_pipeline_queued\b/, '已重新排入 Pipeline 後續鏈'],
  [/^recovery_observation=post_verify_current\b/, '驗證後續鏈已是最新，無需補派'],
  [/^recovery_observation=post_pipeline_current\b/, 'Pipeline 後續鏈已是最新，無需補派'],
  [/^post-verify waiting_stale\b/, '驗證後續鏈等待超過 24 小時，未自動補派'],
  [/^post-verify redispatch exhausted\b/, '驗證後續鏈重新派送次數已用完'],
  [/^post-pipeline redispatch exhausted\b/, 'Pipeline 後續鏈重新派送次數已用完'],
  [/^post-verify dispatch incomplete\b/, '驗證後續鏈未完成'],
  [/^post-pipeline dispatch incomplete\b/, 'Pipeline 後續鏈未完成'],
  [/^post-verify recovery deferred\b/, '驗證後續鏈補救延後'],
  [/^post-pipeline recovery deferred\b/, 'Pipeline 後續鏈補救延後'],
  [/^post-verify closed by failed strategy-learning\b/, '驗證後續鏈因策略學習失敗而關閉'],
  [/^post-verify blocked by terminal strategy-learning\b/, '驗證後續鏈被已結束的策略學習擋下'],
  [/^post-verify authority mismatch\b/, '驗證後續鏈權限不一致'],
  [/^stale post-verify is not recoverable\b/, '過期的驗證後續鏈無法補救'],
  [/^post-pipeline unrecoverable head_advanced\b/, 'Pipeline 後續鏈已無法補救（後續交易日已推進）'],
  [/^l4_distribution_original_plan_closure_incomplete\b/, 'L4 分布原始計畫收斂未完成'],
  [/^callback_observation=pending\b/, '等待完成回呼'],
  [/^observed\b/, '已觀察生命週期狀態'],
  [/^replay_not_applicable=/, '重播不適用（S12 重播已退役）'],
  [/^replay_dispatch=enqueued\b/, '重播已排入'],
  [/^replay (?:deferred|source error back-off)\b/, '重播延後'],
]

function lifecycleDateDetail(date: string, encoded: string): string | undefined {
  const text = encoded.replace(/_/g, ' ')
  const head = /^status:(\w+) allocator EV lifecycle (.*)$/s.exec(text)
  if (!head) return undefined
  const phrase = LIFECYCLE_PHRASES.find(([re]) => new RegExp(re.source.replace(/_/g, ' ')).test(head[2]))?.[1]
  if (!phrase) return undefined
  const attempts = /\bpost pipeline attempts=(\d+)/.exec(text)?.[1]
  const failed = /\bpost pipeline status:(?:error|failed)\b/.test(text)
  const notes = clause(
    failed && attempts && `已重試 ${attempts} 次仍失敗`,
    /\bmanual review required\b/.test(text) && '需人工檢查',
    /\balready reported\b/.test(text) && '先前已回報',
  )
  return `${date} ${phrase}${notes ? `，${notes}` : ''}`
}

function allocatorLifecycle(p: Parsed): string | undefined {
  const raw = p.raw
  const single = /^status=(success|failed|waiting) allocator EV lifecycle (.+?) date=(\d{4}-\d{2}-\d{2})\b/.exec(raw)
  if (single && !/^window=/.test(single[2])) {
    const phrase = LIFECYCLE_PHRASES.find(([re]) => re.test(single[2]))?.[1]
    if (!phrase) return undefined
    const previous = /\bprevious_status=(\w+) previous_attempts=(\d+)/.exec(raw)
    return join(
      `配置器 EV 生命週期（${single[3]}）${single[1] === 'failed' ? '失敗' : single[1] === 'waiting' ? '等待中' : ''}`,
      phrase,
      previous && `前一輪${statusZh(previous[1])}（已試 ${previous[2]} 次）`,
      phrase !== '已重新排入驗證後續鏈' && p.map.get('recovery_dispatch') === 'post_verify_queued' && '已重新排入驗證後續鏈',
      /\bmanual_review_required\b/.test(raw) && '需人工檢查',
      /\balready_reported\b/.test(raw) && '先前已回報',
    )
  }
  const m = /^status=(success|failed) allocator EV lifecycle window=(\S+)\.\.(\S+) dates=(\d+) incomplete=(\d+)/.exec(raw)
  if (!m) return undefined
  const perDate = raw.split('; ').slice(1).map((part) => /^(\d{4}-\d{2}-\d{2})=(complete|pending_pipeline_execution|failed|ok)\b/.exec(part))
  if (perDate.some((x) => !x)) return undefined
  const count = (kind: string) => perDate.filter((x) => x![2] === kind).length
  const failedDates = perDate.filter((x) => x![2] === 'failed').map((x) => x![1])
  // ok／failed 後面是該日的單日摘要（allocatorEvDailyLifecycle summaryDetail：status= → status:、空白 → _），
  // 逐日還原後翻；ok 只代表單日檢查沒丟錯，不等於已補好，所以每日都要講出結果。
  const detailed = raw.split('; ').slice(1).flatMap((part) => {
    const d = /^(\d{4}-\d{2}-\d{2})=(ok|failed):(.*)$/s.exec(part)
    return d ? [lifecycleDateDetail(d[1], d[3])] : []
  })
  if (detailed.some((x) => !x)) return undefined
  const newOutside = Number(p.map.get('outside_window_new') ?? 0)
  const gap = p.map.get('gap_scan') ?? ''
  return join(
    `配置器 EV 生命週期檢查${m[1] === 'success' ? '完成' : '失敗'}（${m[2]}～${m[3]}，${m[4]} 日）`,
    clause(
      count('complete') > 0 && `已完成 ${count('complete')} 日`,
      count('pending_pipeline_execution') > 0 && `等待 Pipeline ${count('pending_pipeline_execution')} 日`,
      failedDates.length > 0 && `未完成 ${failedDates.length} 日（${failedDates.join('、')}）`,
    ),
    detailed.length > 0 && detailed.join('；'),
    clause(
      `視窗外新發現 ${n(newOutside)} 筆、已知 ${n(p.map.get('outside_window_known')) ?? 0} 筆`,
      /^failed:/.test(gap) ? '缺口掃描失敗' : undefined,
    ),
    newOutside > 0 && /manual_review_required/.test(raw) && !detailed.some((x) => x!.includes('需人工檢查')) && '需人工檢查',
  )
}

function active8Resolved(p: Parsed, label: string): string | undefined {
  const m = /^run_id=active8-oof-\w+:(\d{4}-\d{2}-\d{2}):/.exec(p.raw)
  const status = p.map.get('status')
  const head = `Active-8 ${label}${/[A-Za-z0-9]$/.test(label) ? ' ' : ''}`
  // 帶 error= 的是終止失敗（job lastStatus=error），不論 status 寫 pending／unknown 都不能講成「尚未完成」
  const failed = p.map.has('error')
  const state = failed ? '失敗'
    : status === 'native_l4_daily_accounted' ? '已入帳（原生 L4 每日結果）'
    : status === 'materialized' ? '已產生 OOF 結果'
    : status === 'pending' ? '尚未完成'
    : status === 'unknown' ? '狀態不明' : undefined
  if (!m || !state) return undefined
  const excluded = none(p.map.get('forward_excluded')) ? [] : p.map.get('forward_excluded')!.split(',')
  const forward = p.map.get('forward_data')
  const fullFit = p.map.get('full_fit')
  const exhausted = /\boof_dependency_continuation_exhausted:\S*?attempt=(\d+)/.exec(p.raw)?.[1]
  return join(
    `${head}${state}（${m[1]}）`,
    clause(
      p.map.has('promoted') && (isTrue(p.map.get('promoted')) ? '已晉升' : '未晉升'),
      p.map.get('reason') === 'full_fit_poll_only_terminal_failure' ? '全量訓練已到終止失敗'
        : fullFit === 'completed' ? '全量訓練完成' : fullFit === 'blocked' ? '全量訓練被擋' : undefined,
      forward === 'refreshed' ? '前瞻資料已更新'
        : forward === 'refreshed_with_exclusions' ? `前瞻資料已更新，排除 ${excluded.length} 日（${dateRange(excluded)}）` : undefined,
    ),
    failed && (exhausted ? `依賴接續重試 ${exhausted} 次已用完，不會自動再跑` : '錯誤原因見明細'),
  )
}

const EVENING_STAGE_ZH: Record<string, string> = {
  pipeline_execution: 'Pipeline', post_pipeline_chain: 'Pipeline 後續鏈', verify_v2: '預測驗證', screener_v2: '選股',
  post_verify_chain: '驗證後續鏈', strategy_learning: '策略學習', active8_oof_daily: 'Active-8 每日證據',
  dataset_snapshot_export: '研究快照匯出',
}
const BLOCKER_STATE_ZH: Record<string, string> = {
  error: '錯誤', missing: '無紀錄', running: '執行中', waiting: '等待中', queued: '已排隊', pending: '待處理', triggered: '已觸發',
  failed: '失敗', canonical_run_id_mismatch: '執行代號不一致', snapshot_run_id_lineage_mismatch: '快照來源不一致',
}

function eveningBlockers(list: string): string | undefined {
  const items = list.split(',').map((item) => /^([a-z0-9_]+):(\w+)$/.exec(item))
  if (items.length === 0 || items.some((x) => !x)) return undefined
  return items.map((x) => `${EVENING_STAGE_ZH[x![1]] ?? '其他階段'}${BLOCKER_STATE_ZH[x![2]] ?? '有問題（見明細）'}`).join('、')
}

/** post-pipeline-chain／post-verify-chain 的「task:status task:status」。 */
function chainResults(text: string): string | undefined {
  const items = text.trim().split(/\s+/).map((item) => /^([a-z0-9-]+):(\w+)$/.exec(item))
  if (items.length === 0 || items.some((x) => !x)) return undefined
  const groups = new Map<string, string[]>()
  for (const x of items) groups.set(x![2], [...(groups.get(x![2]) ?? []), taskZh(x![1])])
  const order = ['error', 'running', 'triggered', 'waiting', 'skipped', 'disabled_by_design', 'success']
  if ([...groups.keys()].some((k) => !order.includes(k))) return undefined
  const parts = order.filter((k) => groups.has(k)).map((k) => {
    const names = groups.get(k)!
    return k === 'success' ? `成功 ${names.length}` : `${statusZh(k)} ${names.length}（${names.join('、')}）`
  })
  return `${items.length} 項子工作：${parts.join('、')}`
}

function strategyLearningMaterialized(p: Parsed): string | undefined {
  const c = /^(\d+)\/(\d+)$/.exec(p.map.get('candidates') ?? '')
  const r = /^(\d+)\/(\d+)$/.exec(p.map.get('rows') ?? '')
  if (!c || !r) return undefined
  const blocked = none(p.map.get('blocked')) ? [] : p.map.get('blocked')!.split(',')
  return join(
    `策略學習資料已完整產生${p.map.get('run_scope') === 'historical_replay' ? '（歷史重播）' : ''}`,
    clause(`候選 ${n(c[1])}/${n(c[2])}`, `決策矩陣 ${n(r[1])}/${n(r[2])} 列`),
    clause(
      p.map.get('mature_signal_date') && !none(p.map.get('mature_signal_date')) && `成熟訊號日 ${p.map.get('mature_signal_date')}`,
      p.map.has('gaps_before') && `缺口 ${p.map.get('gaps_before')} → ${p.map.get('gaps_after') ?? '?'} 日`,
    ),
    blocked.length > 0 && `仍有 ${blocked.length} 日無法補（${dateRange(blocked)}）`,
    /^disabled_by_design:/.test(p.map.get('policy') ?? '') && '政策更新依設計停用（由月度晉升負責）',
    p.map.get('policy_closure') === 'evidence_only' && '只記錄證據，不改政策',
  )
}

function strategyLearningConfirmed(raw: string): string | undefined {
  const m = /^durable strategy-learning finalize confirmed date=(\S+) run_id=\S+(?: policy_closure=(\w+) candidates=(\d+)\/(\d+) decision_rows=(\d+)\/(\d+))?$/.exec(raw)
  if (!m) return undefined
  if (!m[2]) return `策略學習已完成並確認（${m[1]}）`
  return join(
    `策略學習已完成並確認（${m[1]}）`,
    clause(`候選 ${n(m[3])}/${n(m[4])}`, `決策紀錄 ${n(m[5])}/${n(m[6])}`),
    m[2] === 'evidence_only' ? '只記錄證據，不改政策' : '政策收斂狀態見明細',
  )
}

/** cadenceReadiness.cadenceJobClosureProblem 的原因代碼；其他原因是該工作的錯誤原文，只講狀態。 */
const READINESS_PROBLEM_ZH: Record<string, string> = {
  'terminal callback missing': '未收到完成回呼',
  current_cycle_completion_missing: '本週期尚未完成',
  completion_timestamp_missing: '缺完成時間',
  completion_timestamp_invalid: '完成時間無效',
  research_sources_incomplete: '研究來源不完整',
  dispatch_is_not_terminal_closure: '只派送、尚未收尾',
  active8_terminal_receipt_missing: '缺終端收據',
  active8_terminal_receipt_not_closed: '終端收據未收齊',
  active8_full_fit_terminal_receipt_missing: '缺全量訓練終端收據',
}
function readinessBlocker(b: { task: string; status: string; reason?: string }): string {
  const problem = b.reason ? READINESS_PROBLEM_ZH[b.reason] : undefined
  if (problem) return `${taskZh(b.task)}${problem}`
  // 不在成功狀態的工作才會被列為阻擋；「非本日排程」單獨講會像沒事，補上未完成
  return b.status === 'sleep' ? `${taskZh(b.task)}本週期未完成（非本日排程）` : `${taskZh(b.task)}${statusZh(b.status)}`
}

function readiness(raw: string): string | undefined {
  const m = /^(weekly|monthly)_readiness_(blocked|closed) /.exec(raw)
  if (!m) return undefined
  const label = m[1] === 'weekly' ? '每週' : '每月'
  if (m[2] === 'closed') {
    const req = /required=(\d+)\/(\d+)/.exec(raw)
    return req ? `${label}就緒檢查通過：必要工作 ${req[1]}/${req[2]} 全數完成` : undefined
  }
  type Row = { task: string; status: string; reason?: string }
  const r = json<{ missing?: string[]; blockers?: Row[]; optional?: Row[]; paused_expected?: string[] }>(raw.slice(m[0].length))
  if (!r || !Array.isArray(r.blockers)) return undefined
  const optionalBad = (r.optional ?? []).filter((o) => !['success', 'sleep'].includes(o.status))
  return join(
    `${label}就緒檢查被擋`,
    r.blockers.length > 0 && `${r.blockers.length} 項必要工作未收斂（${r.blockers.map(readinessBlocker).join('、')}）`,
    (r.missing ?? []).length > 0 && `缺少 ${r.missing!.length} 項（${r.missing!.map(taskZh).join('、')}）`,
    optionalBad.length > 0 && `選配工作：${optionalBad.map((o) => `${taskZh(o.task)}${statusZh(o.status)}`).join('、')}`,
    (r.paused_expected ?? []).length > 0 && `預期暫停：${r.paused_expected!.map(taskZh).join('、')}`,
  )
}

const MORE_FORMATTERS: Record<string, Formatter> = {
  pipeline: (p) => {
    const raw = p.raw
    const phase = /^phase=([a-z0-9_]+) phase_status=(\w+) execution=\S*$/.exec(raw)
    if (phase) {
      return PIPELINE_PHASE_ZH[phase[1]] && PHASE_STATUS_ZH[phase[2]] ? `Pipeline ${PHASE_STATUS_ZH[phase[2]]}：${PIPELINE_PHASE_ZH[phase[1]]}` : undefined
    }
    const sealed = /^awaiting_premarket l3_sealed=true cloud_compute_stopped=true(?: atomic_inputs=(\w+))?(?: run_id=\S+)?$/.exec(raw)
    if (sealed) {
      const atomic = sealed[1]
      return `${SEALED_SENTENCE}${atomic === 'waiting' ? '；Atomic 輸入等待中' : atomic === 'ready' ? '；Atomic 輸入已就緒' : atomic ? '；Atomic 輸入狀態見明細' : ''}`
    }
    const done = /^run_id=\S+ preds=(\d+) recos_updated=(\d+) seed_rows=(\d+) llm_reasons=(\d+) snapshot=(\S+) errors=(\d+)$/.exec(raw)
    if (!done) return undefined
    const snapshot = done[5] === 'queued_postclose' ? '研究快照排入收盤後匯出' : done[5] === 'success' ? '研究快照已匯出' : done[5] === 'n/a' ? undefined : '研究快照狀態見明細'
    return join(
      'Pipeline 完成',
      clause(`預測 ${n(done[1])} 筆`, `推薦更新 ${n(done[2])} 筆（種子 ${n(done[3])} 筆）`, `推薦說明 ${n(done[4])} 則`),
      snapshot,
      Number(done[6]) > 0 ? `注意：${n(done[6])} 個錯誤` : '沒有錯誤',
    )
  },

  'evening-chain': (p) => {
    const raw = p.raw
    if (/^awaiting_premarket l3_sealed=true cloud_compute_stopped=true(?: run_id=\S+)?$/.test(raw)) return SEALED_SENTENCE
    const replay = /\brun_scope=historical_replay\b/.test(raw) ? '，歷史重播' : ''
    let m = /^evening-chain durable DAG complete date=(\S+) run_id=\S+ stages=(\d+) strategy_learning=success dataset_snapshot=success active8_oof_daily=success historical_excluded=(\S+)/.exec(raw)
    if (m) {
      const excluded = none(m[3]) ? [] : m[3].split(',')
      return join(
        `晚間流程完成（${m[1]}${replay}）`,
        `${m[2]} 個必要階段與策略學習、研究快照、Active-8 每日證據皆成功`,
        excluded.length > 0 && `正式證據排除 ${excluded.length} 日（${excluded.join('、')}）`,
      )
    }
    m = /^evening-chain durable DAG failed date=(\S+) run_id=\S+ root_closure_deadline_exceeded:(\S+)/.exec(raw)
    if (m) {
      const b = eveningBlockers(m[2])
      return b && `晚間流程逾時關閉為失敗（${m[1]}${replay}）：${b}`
    }
    m = /^evening-chain (?:durable DAG failed|root pending) date=(\S+) run_id=\S+ blockers=(\S+)/.exec(raw)
    if (m) {
      const b = eveningBlockers(m[2])
      const pending = raw.startsWith('evening-chain root pending')
      return b && `晚間流程${pending ? '尚未收齊' : '失敗'}（${m[1]}${replay}）：${b}`
    }
    m = /^pipeline serving published; research waits for the after-close dispatch(?: at (\S+ \d{2}:\d{2}))? run_id=\S+$/.exec(raw)
    if (m) return `盤前服務已發布；研究等待收盤後派送${m[1] ? `（台灣時間 ${m[1]}）` : ''}`
    return undefined
  },

  'ml-predict': (p) => {
    const raw = p.raw
    if (raw === 'L3 預測已完成並封存；未重新執行模型') return undefined
    const m = /^run_id=\S+ symbols=(\d+)\/(\d+) rows=(\d+) models=(\d+) incomplete_active_model_symbols=(\d+) symbol_closure=(True|False) active_model_closure=(True|False)$/.exec(raw)
    if (m) {
      const ok = m[6] === 'True' && m[7] === 'True'
      return join(
        ok ? 'L3 預測完成' : 'L3 預測未完整',
        clause(`${n(m[1])}/${n(m[2])} 檔`, `${n(m[3])} 筆預測`, `${m[4]} 個模型`),
        m[6] === 'False' && '注意：個股覆蓋未完整',
        Number(m[5]) > 0 && `注意：${n(m[5])} 檔缺部分模型預測`,
      )
    }
    const legacy = /^run_id=\S+ predictions=(\d+)$/.exec(raw)
    return legacy ? `L3 預測寫入 ${n(legacy[1])} 筆（未回報個股覆蓋）` : undefined
  },

  recommendation: (p) => {
    const m = /^run_id=\S+ recos_updated=(\d+) filtered=(\d+) seed_rows=(\d+) closure=(True|False)$/.exec(p.raw)
    if (!m) return undefined
    return m[4] === 'True'
      ? `L4 推薦完成：更新 ${n(m[1])} 筆、標為非買進 ${n(m[2])} 筆，${n(m[3])} 筆種子全數處理`
      : `L4 推薦未完整：更新 ${n(m[1])} 筆＋非買進 ${n(m[2])} 筆，與種子 ${n(m[3])} 筆不符`
  },

  'post-pipeline-chain': (p) => {
    const raw = p.raw
    const m = /^Serving published; research and verification wait for the after-close dispatch(?: at (\S+ \d{2}:\d{2}))? run_id=\S+$/.exec(raw)
    if (m) return `盤前服務已發布；研究與驗證等待收盤後派送${m[1] ? `（台灣時間 ${m[1]}）` : ''}`
    const list = chainResults(raw)
    return list && `Pipeline 後續鏈：${list}`
  },

  'post-verify-chain': (p) => {
    const raw = p.raw
    const closed = /^strategy-learning durable finalize closed; (.*)$/s.exec(raw)
    if (closed) {
      const inner = strategyLearningConfirmed(closed[1]) ?? strategyLearningMaterialized(parse(closed[1]))
      return inner && `驗證後續鏈已由策略學習收尾：${inner}`
    }
    const recovered = /^durable learning recovery complete policy_closure=(\w+)$/.exec(raw)
    if (recovered) return `策略學習補跑已完成${recovered[1] === 'evidence_only' ? '（只記錄證據，不改政策）' : ''}`
    const failed = /^status=failed post-verify-chain closed by strategy-learning terminal failure date=(\S+)/.exec(raw)
    if (failed) return `驗證後續鏈因策略學習失敗而關閉（${failed[1]}）`
    const waiting = /^waiting for queued strategy-learning: (.*)$/.exec(raw)
    const list = chainResults(waiting ? waiting[1] : raw)
    return list && `驗證後續鏈${waiting ? '等待已排隊的策略學習' : ''}：${list}`
  },

  'strategy-learning': (p) => strategyLearningConfirmed(p.raw) ?? (/^materialized_complete /.test(p.raw) ? strategyLearningMaterialized(p) : undefined),

  'allocator-ev-feature-snapshot-backfill': (p) => {
    const m = /^allocator snapshot already ready date=(\S+) rows=(\d+)$/.exec(p.raw)
    if (m) return `配置器特徵快照已就緒（${m[1]}），共 ${n(m[2])} 列，無需補齊`
    if (/^snapshot readback incomplete /.test(p.raw)) {
      return `配置器特徵快照讀回不完整：預期 ${n(p.map.get('expected')) ?? '?'} 列、實際 ${n(p.map.get('actual')) ?? '?'} 列`
    }
    return undefined
  },

  'verify-v2': (p) => {
    const m = /^verified (\d+)\/(\d+)(?: written (\d+))? correct (\d+) pnl (-?[\d.]+)% arf (\d+)$/.exec(p.raw)
    if (!m) return undefined
    return join(
      '預測驗證完成',
      clause(`待驗證 ${n(m[2])} 筆中驗證 ${n(m[1])} 筆`, m[3] && `寫入 ${n(m[3])} 筆`, `判定正確 ${n(m[4])} 筆`),
      clause(`損益 ${m[5]}%`, `ARF 更新 ${n(m[6])} 筆`),
    )
  },

  'model-ic-rolling': (p) => {
    const m = /^rolling_ic owner=D1Registry run_date=(\S+) n_rows=(\d+) \| (.*)$/.exec(p.raw)
    if (!m) return undefined
    const values = m[3].trim() === 'none' ? [] : m[3].trim().split(/\s+/).map((x) => /:(-?[\d.]+)\((\d+)\)$/.exec(x))
    if (values.some((x) => !x)) return undefined
    const ics = values.map((x) => Number(x![1]))
    return join(
      `滾動 IC 更新（${m[1] === 'latest' ? '最新' : m[1]}）`,
      `${n(m[2])} 筆樣本`,
      ics.length ? `${ics.length} 個模型已計算 IC（最高 ${Math.max(...ics).toFixed(3)}、最低 ${Math.min(...ics).toFixed(3)}）` : '沒有模型達計算門檻',
    )
  },

  'linucb-reward-ledger': (p) => {
    const m = /^linucb reward ledger (\w+): source_rows=(\d+) ledger_rows=(\d+) total_samples=(\d+)$/.exec(p.raw)
    if (!m) return undefined
    return `LinUCB 回饋帳本${m[1] === 'updated' ? '已更新' : statusZh(m[1])}：來源 ${n(m[2])} 筆 → 帳本 ${n(m[3])} 列，累計樣本 ${n(m[4])} 筆`
  },

  'daily-report': (p) => {
    const m = /^daily report sent via (\S+): (\d+) BUY \/ (\d+) SELL$/.exec(p.raw)
    if (!m) return undefined
    // dailyReport.ts 的買進／賣出清單有 LIMIT 15／10，這兩個數字是報告列出的檔數，不是訊號總數
    const counts = `報告列出買進 ${n(m[2])} 檔、賣出 ${n(m[3])} 檔`
    if (m[1] === 'not_sent:no_channel_configured') return `每日報告未寄出（未設定通知管道）：${counts}`
    if (m[1].startsWith('not_sent')) return `每日報告未寄出（原因見明細）：${counts}`
    return `每日報告已送出：${counts}`
  },

  'paper-active-postmarket': (p) => {
    if (p.raw === 'SKIP: paper-active postmarket controller route unavailable') return '模擬盤盤後評估略過：controller 尚未提供此路由'
    const m = /^paper-active-postmarket run_date=(\S+) candidate_count=(\d+) evaluated=(\d+) persisted candidates=(\d+) metrics=(\d+) audits=(\d+)$/.exec(p.raw)
    if (!m) return undefined
    return `模擬盤盤後評估（${m[1] === 'latest' ? '最新' : m[1]}）：候選 ${n(m[2])} 個、評估 ${n(m[3])} 個；寫入候選 ${n(m[4])}、每日指標 ${n(m[5])}、稽核事件 ${n(m[6])}`
  },

  'meta-learning-shadow': (p) => {
    if (!p.map.has('reward_hydrated') || !p.map.has('decision_contexts')) return undefined
    const policies = ['neural_ucb', 'neural_ts', 'neucb'].map((k) => p.map.get(k))
    const notRun = policies.filter((v) => v === 'not_run_no_current_decision_context').length
    const parsed = policies.map((v) => json<{ success?: boolean; mode?: string; policy_id?: string }>(v))
    const ok = parsed.filter((x) => x?.success === true && x.mode === 'persisted')
    const failed = policies.length - notRun - ok.length
    return join(
      '元學習影子更新',
      clause(
        `回饋補齊 ${n(p.map.get('reward_hydrated'))} 筆（無法回溯待處理 ${n(p.map.get('reward_unseekable_pending')) ?? 0}）`,
        `決策情境 ${n(p.map.get('decision_contexts'))} 筆`,
        `模型登錄新增 ${n(p.map.get('registry_created')) ?? 0}／共 ${n(p.map.get('registry_total')) ?? '?'}`,
      ),
      notRun === policies.length ? '當日沒有決策情境，影子策略未執行'
        : clause(
          ok.length > 0 && `${ok.length} 個影子策略已訓練並寫入（${ok.map((x) => x!.policy_id ?? '其他').join('、')}）`,
          failed > 0 && `注意：${failed} 個影子策略未成功`,
          notRun > 0 && `${notRun} 個未執行`,
        ),
    )
  },

  'us-leading': (p) => {
    const wait = premarketWait(p.raw, 'us-leading', '美股領先指標')
    if (wait) return wait
    if (!p.raw.startsWith('{')) return undefined
    const d = json<Record<string, any>>(p.raw)
    if (!d?.date || !d.sentiment) return undefined
    return join(
      `美股領先指標（${d.date}）`,
      `情緒${BIAS_ZH[d.sentiment] ?? '見明細'}`,
      clause(
        pct(d.sox_return) && `費半 ${pct(d.sox_return)}`,
        pct(d.tsm_return) && `台積電 ADR ${pct(d.tsm_return)}`,
        pct(d.gspc_return) && `標普 500 ${pct(d.gspc_return)}`,
        pct(d.dxy_return) && `美元指數 ${pct(d.dxy_return)}`,
      ),
      clause(
        fixed(d.vix_close) && `VIX ${fixed(d.vix_close)}`,
        fixed(d.hy_spread) && `高收益債利差 ${fixed(d.hy_spread)}${fixed(d.hy_spread_chg) ? `（${Number(d.hy_spread_chg) > 0 ? '+' : ''}${fixed(d.hy_spread_chg)}）` : ''}`,
      ),
    )
  },

  'daily-snapshot': (p) => {
    const raw = p.raw
    const mismatch = /^paper_snapshot_mark_date_mismatch:(\d{4}-\d{2}-\d{2}):(.+)$/.exec(raw)
    if (mismatch) {
      const marks = mismatch[2].split(',').map((x) => /^(\w+)@(\S+)$/.exec(x))
      if (marks.some((x) => !x)) return undefined
      const undated = marks.filter((x) => x![2] === 'undated').map((x) => x![1])
      const other = marks.filter((x) => x![2] !== 'undated').map((x) => `${x![1]}（${x![2]}）`)
      return join(
        `模擬盤每日快照失敗（${mismatch[1]}）：${marks.length} 檔持股的收盤價日期不是估值日`,
        clause(undated.length > 0 && `${undated.join('、')} 沒有價格日期`, other.length > 0 && `${other.join('、')} 日期不符`),
        '未寫入快照，價格到齊後可重跑',
      )
    }
    if (!raw.startsWith('{')) return undefined
    const d = json<Record<string, any>>(raw)
    const v = d?.valuation
    if (!d?.date || !v) return undefined
    const positions = Object.keys(v.positions ?? {}).length
    const reward = d.l4Reward
    return join(
      `模擬盤每日快照（${d.date}${d.rerun ? '，重跑' : ''}）`,
      v.valuation_complete
        ? clause(`淨值 ${n(v.nav)}`, `持股 ${positions} 檔`, '估值完整')
        : clause(`淨值區間 ${n(v.nav_lower_bound) ?? '?'}～${n(v.nav_upper_bound) ?? '?'}`, `持股 ${positions} 檔`, '估值未完整（有未定價權利）'),
      reward?.status === 'unavailable'
        ? `L4 回饋暫無${reward.reason === 'l4_reward_session_plan_missing' ? '（當日沒有 L4 交易計畫）' : '（原因見明細）'}`
        : reward?.status ? `L4 回饋${statusZh(reward.status)}` : undefined,
    )
  },

  'daily-execution-paper-lineage': (p) => {
    const notReady = /^daily_paper_snapshot_not_ready:(\S+)$/.exec(p.raw)
    if (notReady) return `執行／模擬盤來源鏈失敗：${notReady[1]} 的模擬盤每日快照尚未產生`
    const d = jsonTail<{ status?: string; business_date?: string; execution_ready?: boolean; paper_ready?: boolean }>(p.raw, /^daily_execution_paper_lineage /)
    if (!d?.business_date || !['written', 'reused'].includes(d.status ?? '')) return undefined
    return `執行／模擬盤來源鏈（${d.business_date}）：${d.status === 'written' ? '已寫入' : '沿用既有紀錄'}；執行端${d.execution_ready ? '就緒' : '未就緒'}、模擬盤${d.paper_ready ? '就緒' : '未就緒'}`
  },

  'storage-health-check': (p) => {
    const m = /^(storage_health_check (?:warning (.*?) )?|storage health check failed )(\{.*\})$/s.exec(p.raw)
    if (!m) return undefined
    const r = json<Record<string, any>>(m[3])
    if (!r || typeof r.healthy !== 'boolean') return undefined
    const failed = m[1].startsWith('storage health check failed')
    const warn = parse(m[2] ?? '')
    const drain = (warn.map.get('capacity_drain') ?? '').split(',').filter(Boolean)
    const runway = (warn.map.get('capacity_runway_alert') ?? '').split(',').filter(Boolean)
    const domains: Array<{ domain: string; utilization_pct?: number; status?: string }> = Array.isArray(r.capacity_domains) ? r.capacity_domains : []
    const frozen = r.legacy_capacity_role === 'frozen_rollback_source'
    const judged = domains.filter((d) => !(frozen && d.domain === 'legacy'))
    const warned = judged.filter((d) => ['warning', 'drain', 'critical'].includes(d.status ?? ''))
    const schema: Array<{ ready?: boolean }> = Array.isArray(r.domain_schema) ? r.domain_schema : []
    return join(
      failed ? '儲存健康檢查未通過' : drain.length || runway.length ? '儲存健康檢查有警示' : '儲存健康檢查正常',
      clause(
        `完整性阻擋 ${n(r.integrity_blocked) ?? 0}`,
        `清理積壓逾 24 小時 ${n(r.cleanup_backlog_over_24h) ?? 0}`,
        `DLQ 待處理 ${n(r.dlq_pending) ?? 0}`,
        `孤兒引用 ${n(r.artifact_true_orphan_references) ?? 0}`,
      ),
      schema.length > 0 && (schema.every((s) => s.ready)
        ? `受檢的 ${schema.length} 個資料庫 schema 皆就緒`
        : `受檢的 ${schema.length} 個資料庫中 ${schema.filter((s) => !s.ready).length} 個 schema 未就緒`),
      drain.length > 0 && `注意：${drain.join('、')} 已進入清理區間（75–90%）`,
      runway.length > 0 && `注意：${runway.join('、')} 將在 ${r.capacity_runway_alert_days ?? 30} 天內達 90%`,
      warned.length > 0 && `使用率：${warned.map((d) => `${d.domain} ${Number(d.utilization_pct).toFixed(1)}%`).join('、')}`,
      frozen && domains.some((d) => d.domain === 'legacy') && '舊庫為凍結的回滾來源，不列入判定',
    )
  },

  'learning-retention-readiness': (p) => {
    const r = jsonTail<Record<string, any>>(p.raw, /^learning_retention_readiness /)
    if (!r || typeof r.complete !== 'boolean') return undefined
    const blockers: string[] = Array.isArray(r.blockers) ? r.blockers.map(String) : []
    const kind = (prefix: string) => blockers.filter((b) => b.startsWith(prefix)).length
    const known = kind('cold_reader_not_verified:') + kind('retention_executor_not_current:') + kind('retention_backlog:')
    const nav = r.nav_cold_storage
    return join(
      `學習資料十年保留就緒檢查（${r.as_of_date ?? '日期未知'}，唯讀）：${r.complete ? '已就緒' : '尚未就緒'}`,
      clause(`熱資料 ${n(r.hot_days)} 天、冷資料 ${n(r.cold_days)} 天`, r.policy_ready === true ? '保留政策已就緒' : '保留政策未就緒'),
      r.candidate_rows !== undefined && `待處理候選 ${n(r.candidate_rows)} 列`,
      blockers.length > 0 && clause(
        `阻擋 ${blockers.length} 項`,
        kind('cold_reader_not_verified:') > 0 && `冷資料讀取未驗證 ${kind('cold_reader_not_verified:')}`,
        kind('retention_executor_not_current:') > 0 && `保留執行器非最新 ${kind('retention_executor_not_current:')}`,
        kind('retention_backlog:') > 0 && `保留積壓 ${kind('retention_backlog:')}`,
        blockers.length > known && `其他 ${blockers.length - known}`,
      ),
      nav && `NAV 冷儲存${nav.ready ? '就緒' : '未就緒'}（${n(nav.cold_snapshots) ?? 0}/${n(nav.snapshots) ?? 0} 份快照已冷存）`,
    )
  },

  'legacy-learning-deletion-readiness': (p) => {
    const r = jsonTail<Record<string, any>>(p.raw, /^legacy_learning_deletion_readiness /)
    if (!r || typeof r.technical_ready_for_explicit_approval !== 'boolean') return undefined
    const blockers: string[] = Array.isArray(r.blockers) ? r.blockers.map(String) : []
    const parity = r.evidence?.parity
    const pending = r.evidence?.legacy_hot_final_archive?.pending_datasets
    const drift: string[] = Array.isArray(r.evidence?.post_cutover_target_drift) ? r.evidence.post_cutover_target_drift.map(String) : []
    const fences = drift.filter((d) => /^control_table_revision_fence:/.test(d)).length
    const named = blockers.map((b) => (b === 'legacy_hot_r2_v1_final_archive_not_cycle_complete' ? '舊熱資料 R2 最終封存尚未完成' : undefined))
    return join(
      `舊學習庫刪除就緒檢查（${r.as_of_date ?? '日期未知'}，唯讀）：${r.technical_ready_for_explicit_approval ? '技術上已可送審' : '技術上尚未就緒'}`,
      clause(
        r.delete_authorized ? '已授權刪除' : '未授權刪除',
        r.automatic_delete ? '會自動刪除' : '不會自動刪除',
        r.requires_explicit_wei_approval && '需 Wei 明確核准',
      ),
      blockers.length > 0 && `阻擋 ${blockers.length} 項${named.every(Boolean) ? `（${named.join('、')}）` : ''}`,
      clause(
        r.earliest_clear_date && `最早可清日 ${r.earliest_clear_date}`,
        parity && `最近一次全表比對 ${n(parity.matched_tables)}/${n(parity.checked_tables)} 張一致`,
        Array.isArray(pending) && pending.length > 0 && `最終封存待處理 ${pending.length} 個資料集`,
      ),
      drift.length > 0 && clause(
        `切換後目標端有 ${drift.length} 項漂移`,
        fences > 0 && `其中 ${fences} 張控制表版本落後`,
      ),
    )
  },

  'storage-integrity-audit': (p) => {
    const ok = /^storage_integrity_audit checked=(\d+) verified=(\d+)$/.exec(p.raw)
    if (ok) return `儲存完整性稽核${ok[1] === ok[2] ? '通過' : '未全數通過'}：檢查 ${n(ok[1])} 件、驗證 ${n(ok[2])} 件`
    const failed = /^storage integrity audit failed (\{.*\})$/s.exec(p.raw)
    return failed ? integrityFailure('儲存完整性稽核失敗', failed[1]) : undefined
  },

  'intraday-check': (p) => {
    if (/^SKIPPED: 非台股盤中時段/.test(p.raw)) return '非台股盤中時段，略過'
    if (!p.raw.startsWith('{')) return undefined
    const r = json<{ status?: string; positions?: number; quoted?: number; missing_symbols?: string[] }>(p.raw)
    if (!r?.status) return undefined
    if (r.status === 'healthy_empty') return '盤中持股檢查：不在盤中時段或沒有持股，無需檢查報價'
    if (r.status === 'ok') return `盤中持股檢查正常：${n(r.positions)} 檔持股皆取得報價`
    if (r.status === 'partial') {
      const missing = Array.isArray(r.missing_symbols) ? r.missing_symbols : []
      return `盤中持股檢查不完整：${n(r.positions)} 檔持股只取得 ${n(r.quoted) ?? 0} 檔報價${missing.length ? `（缺 ${missing.join('、')}）` : ''}`
    }
    return undefined
  },

  'eod-exit': (p) => (/^SKIPPED: 僅限 EOD /.test(p.raw) ? '不在收盤出場時段，略過' : undefined),

  'weekly-readiness': (p) => readiness(p.raw),
  'monthly-readiness': (p) => readiness(p.raw),

  'weekly-backtest': (p) => {
    const m = /^CorporateCoverageError: research_corporate_coverage_incomplete:(\{.*\})$/s.exec(p.raw)
    if (!m) return undefined
    const r = json<{ start_date?: string; end_date?: string; sessions?: number; issue_count?: number; issues?: Array<{ reason?: string }>; candidate_search_started?: boolean }>(m[1])
    if (!r?.start_date || r.issue_count === undefined) return undefined
    const reasons = new Set((r.issues ?? []).map((i) => i.reason))
    const example = reasons.size === 1 && reasons.has('session_missing') ? '（列出的缺口都是該日公司行為快照缺漏）'
      : reasons.size === 1 && reasons.has('source_incomplete') ? '（列出的缺口都是來源資料不完整）' : ''
    return `每週回測被擋：公司行為資料覆蓋不足，${r.start_date}～${r.end_date} 共 ${n(r.sessions)} 個交易日中 ${n(r.issue_count)} 日有缺口${example}${r.candidate_search_started === false ? '，候選搜尋未開始' : ''}`
  },

  'optuna-queue': (p) => {
    const raw = p.raw
    if (raw === 'empty') return 'Optuna 佇列沒有待處理工作'
    if (/^locked: optuna queue processor already running/.test(raw)) return 'Optuna 佇列處理器已在執行中，本輪略過'
    if (/^failed: optuna queue claim /.test(raw)) return 'Optuna 佇列取件失敗（原因見明細）'
    const m = /^success: dispatched (\S+) (\w+)=\S+ child_receipt_owner=optuna-per-regime$/.exec(raw)
    if (!m) return undefined
    const regime = /^per_regime:regime_shift:(\w+):(\d{4}-\d{2}-\d{2})$/.exec(m[1])
    const executor = m[2] === 'cloud_run_job' ? 'Cloud Run job' : m[2] === 'modal' ? 'Modal' : '其他執行環境'
    return regime
      ? `已派送 Optuna 分盤勢搜尋（${regime[2]} 盤勢切換為${REGIME_ZH[regime[1]] ?? '其他'}），由 ${executor} 執行，等待完成回呼`
      : `已派送 Optuna 工作，由 ${executor} 執行，等待完成回呼`
  },

  'sector-leaders': (p) => {
    const m = /^sectors=(\d+) leaders=(\d+)$/.exec(p.raw)
    return m ? `產業龍頭更新：${n(m[1])} 個產業、${n(m[2])} 檔龍頭股` : undefined
  },

  'sector-flow-pre-screener': (p) => {
    const m = /^sector_flow date=(\S+) status=(\w+) rebuild_run_id=\S+$/.exec(p.raw)
    if (!m) return undefined
    return `產業資金流${m[2] === 'computed' ? '已計算並確認收斂' : `${stateOf(m[2])}，已確認收斂`}（${m[1]}）`
  },

  'monthly-strategy-mining': (p) => {
    const m = /^monthly Pymoo strategy mining (success|error) run_id=\S+ backend=(\w+)$/.exec(p.raw)
    if (!m) return undefined
    return `每月 Pymoo 策略挖掘${m[1] === 'success' ? '成功' : '失敗'}${m[2] === 'modal' ? '（在 Modal 執行）' : ''}`
  },

  'legacy-strategy-evidence-migration': (p) => {
    const queued = /^legacy_strategy_evidence_migration durable=true queued=(true|false) run_id=\S+$/.exec(p.raw)
    if (queued) return queued[1] === 'true' ? '舊策略證據搬遷已排入持久佇列' : '舊策略證據搬遷未排入佇列（已有一輪在處理）'
    if (!/^legacy_strategy_evidence_migration contexts=/.test(p.raw)) return undefined
    return join(
      '舊策略證據搬遷',
      `情境 ${n(p.map.get('contexts'))}、決策 ${n(p.map.get('decisions')) ?? 0}、artifact ${n(p.map.get('artifacts')) ?? 0}`,
      p.map.has('original_bytes') && `大小 ${bytes(p.map.get('original_bytes'))} → ${bytes(p.map.get('compact_bytes'))}`,
      isTrue(p.map.get('backlog_remaining')) ? '仍有積壓' : '無積壓',
    )
  },

  'hmm-maintenance': (p) => {
    if (p.raw === 'hmm=deferred next_session_beyond_9_day_horizon') return 'HMM 維護延後：下一交易日在 9 天以外'
    const m = /^status=(success|triggered|running) hmm=(\w+) coverage=(true|false) call=\S+$/.exec(p.raw)
    if (!m) return undefined
    const state = m[2] === 'not_due' ? 'HMM 維護尚未到期，無需重訓' : m[2] === 'dispatched' ? 'HMM 維護已派送，等待完成' : m[2] === 'running' ? 'HMM 維護執行中' : undefined
    return state && `${state}；盤勢涵蓋${m[3] === 'true' ? '已就緒' : '尚未就緒'}`
  },

  'finlab-backfill-watchdog': (p) => {
    const raw = p.raw
    const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
      [/^skipped: no pending FinLab trigger for (\S+)$/, (m) => `${m[1]} 沒有待處理的 FinLab 觸發，略過`],
      [/^skipped: FinLab canonical handoff already completed market update for (\S+)$/, (m) => `${m[1]} FinLab 正式資料已接續完成行情更新，略過`],
      [/^status=pending FinLab canonical handoff already progressing market update for (\S+)$/, (m) => `${m[1]} FinLab 正式資料正在接續行情更新，等待完成`],
      [/^skipped: evening-chain already succeeded for (\S+)$/, (m) => `${m[1]} 晚間流程已成功，略過`],
      [/^skipped: FinLab canonical cutoff terminal already recorded for (\S+)/, (m) => `${m[1]} FinLab 已過截止時間並記錄結束，略過`],
      [/^skipped: FinLab canonical handoff age=(\d+)s below watchdog threshold$/, (m) => `FinLab 正式資料剛交接（${m[1]} 秒），未達檢查門檻，略過`],
      [/^skipped: FinLab post-canonical watchdog already claimed /, () => 'FinLab 接續檢查已由另一輪接手，略過'],
      [/^status=triggered FinLab post-canonical watchdog resumed market continuation for (\S+?);/, (m) => `已恢復 ${m[1]} FinLab 之後的行情更新`],
      [/^skipped: FinLab \w+ past the (\d{1,2}:\d{2}) TW cutoff for (\S+?)(?:;|$)/, (m) => `${m[2]} FinLab 已過台灣時間 ${m[1]} 截止，不再重送，略過`],
      [/^failed: /, () => 'FinLab 接續檢查失敗（原因見明細）'],
    ]
    for (const [re, fmt] of rules) {
      const m = re.exec(raw)
      if (m) return fmt(m)
    }
    return undefined
  },

  'indicator-queue-watchdog': (p) => {
    const raw = p.raw
    const rules: Array<[RegExp, (m: RegExpExecArray) => string]> = [
      [/^skipped: indicator queue receipt missing for (\S+)$/, (m) => `${m[1]} 沒有技術指標佇列收據，略過`],
      [/^skipped: indicator queue and finalizer already complete for (\S+?);/, (m) => `${m[1]} 技術指標佇列與收尾皆已完成，略過`],
      [/^skipped: indicator queue watchdog exhausted already reported for (\S+?);/, (m) => `${m[1]} 技術指標補救次數已用完並已告警，略過`],
      [/^skipped: indicator queue heartbeat fresh for (\S+?);/, (m) => `${m[1]} 技術指標佇列仍在回報進度，略過`],
      [/^skipped: indicator finalizer lease active for (\S+?);/, (m) => `${m[1]} 技術指標收尾正在執行，略過`],
      [/^skipped: indicator finalizer continuation deferred for (\S+?);/, (m) => `${m[1]} 技術指標收尾接續已延後，略過`],
      [/^skipped: indicator run handed off to screener_v2 for (\S+?);/, (m) => `${m[1]} 技術指標已交給選股接續，略過`],
      [/^skipped: indicator queue watchdog lease active for (\S+?);/, (m) => `${m[1]} 已有另一輪技術指標檢查在執行，略過`],
      [/^indicator finalizer re-enqueued for (\S+?); run_id=\S+; recovery=(\d+)\/(\d+); done=(\d+)\/(\d+)$/,
        (m) => `已重新排入 ${m[1]} 技術指標收尾（第 ${m[2]}/${m[3]} 次補救，分片完成 ${m[4]}/${m[5]}）`],
      [/^indicator queue stale shards re-enqueued for (\S+?); run_id=\S+; recovery=(\d+)\/(\d+); done=(\d+)\/(\d+);/,
        (m) => `已重新排入 ${m[1]} 停滯的技術指標分片（第 ${m[2]}/${m[3]} 次補救，分片完成 ${m[4]}/${m[5]}）`],
    ]
    for (const [re, fmt] of rules) {
      const m = re.exec(raw)
      if (m) return fmt(m)
    }
    return undefined
  },

  'rescore-10': (p) => rescore(p.raw),
  'rescore-11': (p) => rescore(p.raw),
  'rescore-12': (p) => rescore(p.raw),
  'rescore-1230': (p) => rescore(p.raw),
}

function rescore(raw: string): string | undefined {
  if (raw === 'No open positions') return '目前沒有持股，無需重評'
  if (raw === 'No intraday prices available') return '取不到盤中報價，未重評'
  if (raw === 'SKIP: rescoreEnabled=false') return '盤中重評已停用（設定關閉）'
  if (raw === 'SKIP: no ML_CONTROLLER_URL') return '未設定 controller 位址，略過盤中重評'
  const m = /^(\d+) positions: (\d+) auto EXIT, (\d+) EXIT_SIGNAL, (\d+) WARN, (\d+) HOLD$/.exec(raw)
  if (!m) return undefined
  return `盤中重評 ${m[1]} 檔持股：自動出場 ${m[2]}、出場訊號 ${m[3]}（不自動賣出）、警示 ${m[4]}、續抱 ${m[5]}`
}

// ── 對外 ──────────────────────────────────────────────────────────────

const RESIDUE = [/\b[A-Za-z][\w.-]*=\S/, /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i]

/** 句子殘留機器識別字時不輸出（前端退回 humanJobSummary），不讓半翻譯的句子上畫面。 */
function clean(sentence: string | undefined): string | undefined {
  if (!sentence) return undefined
  const s = sentence.replace(/\s+/g, ' ').trim()
  return RESIDUE.some((re) => re.test(s)) ? undefined : s
}

export function schedulerSummaryZh(jobId: string, summary: string | null | undefined): string | undefined {
  const raw = (summary ?? '').trim()
  if (!raw) return undefined
  const skip = policySkip(raw)
  if (skip) return skip
  try {
    for (const generic of GENERIC) {
      const sentence = generic(raw)
      if (sentence) return clean(sentence)
    }
    const formatter = FORMATTERS[jobId] ?? MORE_FORMATTERS[jobId]
    const own = formatter ? clean(formatter(parse(raw))) : undefined
    if (own) return own
    // 摘要本身就是錯誤訊息時（例如 D1 50 MB 上限），套用同一組錯誤句。
    const bare = raw.replace(/^Error:\s*/, '')
    return ERROR_PATTERNS.find(([re]) => re.test(bare))?.[1]
  } catch {
    return undefined
  }
}

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/D1_ERROR: D1 DB is overloaded/, 'D1 資料庫過載（10 秒內資源用量超限），本次未完成'],
  [/D1 query result exceeded the maximum response size limit of 50 MB/, 'D1 查詢結果超過 50 MB 上限，本次未完成'],
  [/^abandoned_before_execution$/, '排程已受理，但在開始執行前中斷，本輪未執行'],
  [/^abandoned_while_running$/, '開始執行後同步連線中斷，沒有寫回結果，本輪結果不明'],
  [/^new_l4_daily_closure_unverified$/, '新的 L4 每日收斂尚未驗證，本輪不算完成'],
  [/^RuntimeError: oof_dependency_continuation_exhausted:/, 'OOF 依賴接續重試次數已用完，本次未完成'],
  [/^postclose_dispatch_incomplete:/, '盤後研究派送未完成（原因見明細）'],
  [/^RuntimeError: immutable feature prep failed: prep_source_inventory_incomplete/, '不可變特徵準備失敗：來源檔案清單不完整，本次未完成'],
  [/^HMM_MAINTENANCE_(?:not_approved|dispatch_failed|attempt_limit)$/, 'HMM 維護無法派送（未核准、派送失敗或次數已滿），本次未完成'],
]

/** lastError：job 的 formatter 認得的錯誤句（例如 kv_config_drift 失敗時原樣 throw）優先，其次通用錯誤樣式。 */
export function schedulerLastErrorZh(jobId: string, lastError: string | null | undefined): string | undefined {
  const raw = (lastError ?? '').replace(/^Error:\s*/, '').trim()
  if (!raw) return undefined
  const own = schedulerSummaryZh(jobId, raw)
  if (own) return own
  // evening-chain 失敗時 lastError 只放 blockers 清單（eveningChainRootClosure.ts）。
  if (jobId === 'evening-chain' && /^[a-z0-9_]+:\w+(?:,[a-z0-9_]+:\w+)*$/.test(raw)) {
    const blockers = eveningBlockers(raw)
    if (blockers) return clean(`晚間流程卡在：${blockers}`)
  }
  for (const [re, zh] of ERROR_PATTERNS) if (re.test(raw)) return zh
  return undefined
}

/** 測試用：哪些 job 有專屬 formatter。 */
export const SCHEDULER_SUMMARY_ZH_JOB_IDS = Object.freeze([...new Set([...Object.keys(FORMATTERS), ...Object.keys(MORE_FORMATTERS)])])
