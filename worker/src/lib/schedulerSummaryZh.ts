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
}
const reason = (token: string | undefined) => (token ? REASON_ZH[token] : undefined) ?? '原因代碼見明細'

const STATUS_ZH: Record<string, string> = {
  success: '成功', error: '錯誤', failed: '失敗', fail: '未通過', pass: '通過', running: '執行中', waiting: '等待中',
  skipped: '略過', blocked: '被擋', missing: '無紀錄', triggered: '已觸發', queued: '已排隊', ready: '就緒',
  completed: '完成', pending: '待處理', dry_run: '試跑', not_scheduled: '未排程', closed_success: '已正常結束',
}
const statusZh = (token: string | undefined) => (token ? STATUS_ZH[token] : undefined) ?? '狀態代碼見明細'

const REGIME_ZH: Record<string, string> = { bull: '多頭', bear: '空頭', volatile: '高波動', sideways: '盤整' }
const BIAS_ZH: Record<string, string> = { bullish: '偏多', bearish: '偏空', neutral: '中性' }

const PREMARKET_STAGE_ZH: Record<string, string> = {
  setup: '盤前設定', 'market-health': '市場健康檢查', not_started: '尚未開始',
}
function premarketStage(stage: string | undefined): string {
  if (!stage) return '未知'
  const short = stage.replace(/^premarket_v3:/, '')
  if (PREMARKET_STAGE_ZH[short]) return PREMARKET_STAGE_ZH[short]
  if (short.startsWith('publish')) return '交易計畫發布'
  return /_/.test(short) ? '階段代碼見明細' : short
}

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
  if (m[2].startsWith('blocked')) return `${date} 策略學習補跑被擋：${reason(r)}`
  if (/^authority denied/.test(m[2])) {
    return `${date} 無補跑權限：盤後驗證狀態為${statusZh(p.map.get('post_verify_status'))}${more}`
  }
  if (status === 'success') {
    const root = p.map.get('root')
    return `${date} 策略學習已成功，無需補跑${root ? `（根流程${statusZh(root)}）` : ''}`
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
    if (/^status=skipped premarket_outside_window/.test(raw)) return '不在盤前時段，略過'
    if (/^status=skipped premarket_non_trading_day/.test(raw)) return '非交易日，略過盤前準備'
    if (/^status=error event_stage=market-health/.test(raw)) {
      return `盤前準備失敗：市場健康檢查錯誤，交易計畫${isTrue(p.map.get('plan_published')) ? '已' : '未'}發布`
    }
    if (/^status=error premarket_event_chain overdue=true/.test(raw)) {
      return `盤前流程逾時未完成：卡在${premarketStage(p.map.get('stage'))}階段，目標時間 ${p.map.get('ready_target') ?? '未知'}`
    }
    if (/^status=error event_stage=/.test(raw)) return `盤前準備失敗：卡在${premarketStage(p.map.get('event_stage'))}階段`
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
        chain && `晚間流程 ${chain[1]} 站已預建`,
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

  'allocator-ev-lifecycle-watchdog': () => undefined, // 只見過排程政策略過；由共用 policySkip 處理

  'active8-oof-daily': (p) => active8(p, '每日證據'),
  'active8-oof-weekly': (p) => active8(p, '每週 OOF'),

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
      edge && `策略邊際效果${edge[1] === 'shadow' ? '為影子模式' : `狀態${statusZh(edge[1])}`}，${edge[2]} 個策略合格（${edge[3]} 日樣本）`,
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
      config === 'no_challenger' ? '目前沒有挑戰者模型' : config ? `設定狀態${statusZh(config)}` : undefined,
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
    if (stored?.[1]) storedPart = '已存風控 v2 漂移檢查失敗'
    else if (stored) {
      const s = parse(stored[2])
      storedPart = clause(
        `已存風控 v2 漂移檢查 ${n(s.map.get('checked')) ?? 0} 筆${s.map.get('since') ? `（${s.map.get('since')} 起）` : ''}`,
        `${n(s.map.get('failed')) ?? 0} 筆失敗`,
        `${n(s.map.get('policy_changed')) ?? 0} 筆政策變動`,
        s.map.has('skipped_pre_v2') && `略過 v2 前 ${n(s.map.get('skipped_pre_v2'))} 筆`,
      )
    }
    return join(bad.length ? 'KV 設定比對發現漂移' : 'KV 設定比對完成', kvPart, storedPart)
  },

  'news-analyst': (p) => {
    const bias = p.map.get('bias')
    if (!bias) return undefined
    return `新聞分析：市場情緒${BIAS_ZH[bias] ?? '見明細'}（信心 ${p.map.get('conf') ?? '?'}），${n(p.map.get('factors')) ?? 0} 個關鍵因素`
  },

  'morning-setup': (p) => {
    if (/^status=success event_stage=setup/.test(p.raw)) return '盤前設定完成，後續階段立即接續'
    if (/^status=error event_stage=/.test(p.raw)) return `盤前設定失敗：卡在${premarketStage(p.map.get('event_stage'))}階段`
    return undefined
  },

  'premarket-evidence-watchdog': (p) => {
    const raw = p.raw
    if (/^status=skipped premarket_outside_window/.test(raw)) return '不在盤前時段，略過檢查'
    if (/^status=skipped premarket_non_trading_day/.test(raw)) return '非交易日，略過盤前檢查'
    if (/^status=error premarket_event_chain overdue=true/.test(raw)) {
      return `盤前流程逾時未完成：卡在${premarketStage(p.map.get('stage'))}階段，目標時間 ${p.map.get('ready_target') ?? '未知'}`
    }
    return undefined
  },

  'external-evidence': (p) => {
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
      challenger && '生命週期試跑：沒有挑戰者模型',
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
        high && `最佳組合 高 ${high}／中 ${p.map.get('med') ?? '?'}／低上限 ${p.map.get('maxLow') ?? '?'}`,
      ),
      p.map.get('allowed_use') === 'research_only' && '僅供研究，不調整配置',
    )
  },

  'storage-capacity-report': (p) => {
    if (!/^storage_capacity_report /.test(p.raw)) return undefined
    type Domain = { domain: string; role?: string; judged?: boolean; days_to_90pct?: number; alert?: boolean }
    type Capacity = { domain: string; role?: string; utilization_pct?: number; status?: string }
    const runway = json<{ alert_days?: number; alert_domains?: string[]; domains?: Domain[] }>(p.map.get('runway'))
    const health = json<{ healthy?: boolean }>(p.map.get('health'))
    const d1 = json<Capacity[]>(p.map.get('d1'))
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
  const formatter = FORMATTERS[jobId]
  if (!formatter) return undefined
  try {
    return clean(formatter(parse(raw)))
  } catch {
    return undefined
  }
}

const ERROR_PATTERNS: Array<[RegExp, string]> = [
  [/D1_ERROR: D1 DB is overloaded/, 'D1 資料庫過載（10 秒內資源用量超限），本次未完成'],
]

/** lastError：job 的 formatter 認得的錯誤句（例如 kv_config_drift 失敗時原樣 throw）優先，其次通用錯誤樣式。 */
export function schedulerLastErrorZh(jobId: string, lastError: string | null | undefined): string | undefined {
  const raw = (lastError ?? '').replace(/^Error:\s*/, '').trim()
  if (!raw) return undefined
  const own = schedulerSummaryZh(jobId, raw)
  if (own) return own
  for (const [re, zh] of ERROR_PATTERNS) if (re.test(raw)) return zh
  return undefined
}

/** 測試用：哪些 job 有專屬 formatter。 */
export const SCHEDULER_SUMMARY_ZH_JOB_IDS = Object.freeze(Object.keys(FORMATTERS))
