type SchedulerPolicyKind = 'trading_day' | 'trading_week' | 'maintenance' | 'research' | 'queue'

export interface SchedulerTaskPolicy {
  kind: SchedulerPolicyKind
  holidayGated: boolean
  description: string
}

export interface SchedulerRunDecision {
  shouldRun: boolean
  reason: string
  policy: SchedulerTaskPolicy
  twDate: string
}

const DEFAULT_POLICY: SchedulerTaskPolicy = {
  kind: 'maintenance',
  holidayGated: false,
  description: 'non-market maintenance task',
}

export const TASK_POLICIES: Record<string, SchedulerTaskPolicy> = {
  'intraday-check': { kind: 'trading_day', holidayGated: true, description: 'market-hours intraday execution guard' },
  'intraday-rescore': { kind: 'trading_day', holidayGated: true, description: 'market-hours intraday ML re-score' },
  'eod-exit': { kind: 'trading_day', holidayGated: true, description: 'market close exit workflow' },
  'post-close-price-refresh': { kind: 'trading_day', holidayGated: true, description: 'post-close open-position price cache refresh' },
  'daily-snapshot': { kind: 'trading_day', holidayGated: true, description: 'post-market account snapshot' },
  'daily-execution-paper-lineage': { kind: 'trading_day', holidayGated: true, description: 'idempotent post-snapshot canonical execution and paper lineage closure watchdog' },
  'market-close-refresh': { kind: 'trading_day', holidayGated: true, description: '18:10 market-close data refresh before evening chain' },
  'meta-learning-shadow': { kind: 'research', holidayGated: false, description: 'evidence-only neural meta-policy comparison and reward hydration' },
  'evening-chain': { kind: 'trading_day', holidayGated: true, description: 'post-market event-driven chain root' },
  'screener-v2-watchdog': { kind: 'trading_day', holidayGated: true, description: 'recover incomplete same-session screener funnel and callback stages' },
  'finlab-backfill-watchdog': { kind: 'trading_day', holidayGated: true, description: 'reclaim orphaned FinLab Modal pending dispatches' },
  'indicator-queue-watchdog': { kind: 'trading_day', holidayGated: true, description: 'recover stale or dead-lettered indicator shards and orphaned finalizers' },
  'allocator-ev-lifecycle-watchdog': { kind: 'trading_day', holidayGated: true, description: 'recover incomplete allocator EV lineage, snapshot, verify, and replay stages' },
  'active8-oof-daily': { kind: 'maintenance', holidayGated: false, description: 'post-midnight continuation that materializes the prior session ready purged OOF cohort' },
  update: { kind: 'trading_day', holidayGated: true, description: 'post-market TWSE/TPEX market data update' },
  'indicator-queue': { kind: 'trading_day', holidayGated: true, description: 'post-market full-market technical indicator queue' },
  'ml-warmup': { kind: 'trading_day', holidayGated: true, description: 'post-market ML control-plane warmup' },
  'post-pipeline-chain': { kind: 'trading_day', holidayGated: true, description: 'callback-driven verify chain after pipeline' },
  'post-verify-chain': { kind: 'trading_day', holidayGated: true, description: 'callback-driven IC/adapt/report chain after verify' },
  'post-screener-pipeline': { kind: 'trading_day', holidayGated: true, description: 'manual repair continuation from successful screener into regime and pipeline' },
  'paper-active-postmarket': { kind: 'trading_day', holidayGated: true, description: 'non-critical paper-active promotion audit after verify/daily report' },
  pipeline: { kind: 'trading_day', holidayGated: true, description: 'post-market prediction/recommendation pipeline' },
  ml: { kind: 'trading_day', holidayGated: true, description: 'manual ML prediction alias' },
  recommendation: { kind: 'trading_day', holidayGated: true, description: 'daily recommendation after ML predict' },
  screener: { kind: 'trading_day', holidayGated: true, description: 'daily market screener' },
  'screener-v2': { kind: 'trading_day', holidayGated: true, description: 'daily market screener Cloud Run Job trigger' },
  adapt: { kind: 'trading_day', holidayGated: true, description: 'adaptive parameter refresh' },
  'daily-report': { kind: 'trading_day', holidayGated: true, description: 'daily report after market close' },
  'obsidian-sync': { kind: 'trading_day', holidayGated: true, description: 'daily trading-note sync' },
  'obsidian-daily': { kind: 'trading_day', holidayGated: true, description: 'daily trading-note sync' },
  'regime-compute': { kind: 'trading_day', holidayGated: true, description: 'daily market regime compute' },
  'allocator-ev-readiness': { kind: 'trading_day', holidayGated: true, description: 'in-chain L4 alpha and allocator EV readiness before pipeline allocation' },
  'opb-arm-prior-refresh': { kind: 'research', holidayGated: false, description: 'production-gated OPB counterfactual arm-prior refresh' },
  'allocator-ev-feature-snapshot-backfill': { kind: 'trading_day', holidayGated: true, description: 'post-pipeline point-in-time allocator feature snapshot before verify' },
  'verify-v2': { kind: 'trading_day', holidayGated: true, description: 'daily verify and IC refresh' },
  'us-leading': { kind: 'trading_day', holidayGated: true, description: 'pre-market US leading signal' },
  'news-analyst': { kind: 'trading_day', holidayGated: true, description: 'pre-market news analyst' },
  'morning-setup': { kind: 'trading_day', holidayGated: true, description: 'morning setup and debate' },
  'morning-briefing': { kind: 'trading_day', holidayGated: true, description: 'morning briefing delivery' },
  'pre-market-warmup': { kind: 'trading_day', holidayGated: true, description: 'pre-market control-plane warmup' },
  'external-evidence': { kind: 'trading_day', holidayGated: true, description: 'daily formal-shadow GDELT and official evidence materialization' },
  'paper-trade': { kind: 'trading_day', holidayGated: true, description: 'paper trading execution' },

  'weekly-audit': { kind: 'trading_week', holidayGated: true, description: 'weekly trading audit' },
  'model-ic-rolling': { kind: 'trading_day', holidayGated: true, description: 'post-verify rolling model IC evidence refresh' },
  'model-ic-full-check': { kind: 'trading_week', holidayGated: true, description: 'Friday full model IC, promotion dry-run, and config evaluation' },
  'artifact-auto-promotion': { kind: 'research', holidayGated: false, description: 'evidence-complete artifact auto-promotion and serving projection readback' },

  'debate-memory-retention': { kind: 'maintenance', holidayGated: false, description: 'daily debate memory retention' },
  'audit-json-retention': { kind: 'maintenance', holidayGated: false, description: 'archive old D1 audit JSON blobs to R2 and scrub D1 pointers' },
  'retention-archive-only': { kind: 'maintenance', holidayGated: false, description: 'bounded checksum-verified archive-only retention; deleted_rows is always zero' },
  'artifact-reconcile': { kind: 'maintenance', holidayGated: false, description: 'reconcile interrupted R2 artifact manifests and checksum verification' },
  'legacy-evidence-migration': { kind: 'maintenance', holidayGated: false, description: 'cursor-safe R2 migration of noncanonical legacy D1 evidence' },
  'legacy-strategy-evidence-migration': { kind: 'maintenance', holidayGated: false, description: 'checksum-verified R2 migration of legacy strategy decision JSON while preserving scalar learning rows' },
  'legacy-hot-data-retirement': { kind: 'maintenance', holidayGated: false, description: 'archive checksum-verified obsolete D1 cohorts before deletion while preserving execution ledgers' },
  'd1-evidence-scrub': { kind: 'maintenance', holidayGated: false, description: 'scrub only explicitly queued D1 blobs backed by verified R2 artifacts' },
  'r2-retention-sweep': { kind: 'maintenance', holidayGated: false, description: 'apply lineage-aware R2 retention policies' },
  'orphan-reachability-gc': { kind: 'maintenance', holidayGated: false, description: 'remove unreachable staging objects after grace period' },
  'cleanup-dlq-replay': { kind: 'maintenance', holidayGated: false, description: 'replay blocked artifact cleanup work' },
  'storage-health-check': { kind: 'maintenance', holidayGated: false, description: 'fail-close integrity and producer admission health assertion; trading paths remain exempt' },
  'storage-health-gate': { kind: 'maintenance', holidayGated: false, description: 'deprecated compatibility alias for storage-health-check' },
  'storage-integrity-audit': { kind: 'maintenance', holidayGated: false, description: 'manifest to R2 checksum and lineage audit' },
  'storage-capacity-report': { kind: 'maintenance', holidayGated: false, description: 'daily D1 and R2 retention capacity report' },
  'learning-retention-readiness': { kind: 'maintenance', holidayGated: false, description: 'daily read-only 730-day hot and 3650-day cold Learning retention audit' },
  'legacy-learning-deletion-readiness': { kind: 'maintenance', holidayGated: false, description: 'daily read-only legacy Learning rollback and deletion prerequisite audit; never deletes' },
  'strategy-learning-finalize': { kind: 'maintenance', holidayGated: false, description: 'idempotent labels, marginal-edge and reward-ledger finalizer without rematerializing decisions' },
  'data-domain-shadow-backfill': { kind: 'maintenance', holidayGated: false, description: 'bounded keyset copy and checksum parity into an inactive D1 domain shard' },
  'data-domain-shadow-backfill-next': { kind: 'maintenance', holidayGated: false, description: 'sequential one-domain-at-a-time shadow backfill coordinator; never activates routing' },
  'weekly-cleanup': { kind: 'maintenance', holidayGated: false, description: 'weekly cleanup and lifecycle check; no retrain' },
  'weekly-readiness': { kind: 'maintenance', holidayGated: false, description: 'weekly cycle terminal closure and fail-close summary' },
  'weekly-backtest': { kind: 'research', holidayGated: false, description: 'weekly lightweight backtest, Monte Carlo, PBO validation' },
  'alpha-quality': { kind: 'research', holidayGated: false, description: 'weekly alpha quality research' },
  'weekly-optuna': { kind: 'research', holidayGated: false, description: 'weekly lightweight Optuna/GA calibration' },
  's12-smcvwap-calibration': { kind: 'research', holidayGated: false, description: 'weekly/monthly walk-forward S12 Taiwan-equity calibration and automatic promotion' },
  's12-research-recovery': { kind: 'maintenance', holidayGated: false, description: 'one-shot Shioaji quota preflight and point-in-time S12 reconstruction repair' },
  'active8-oof-lifecycle': { kind: 'research', holidayGated: false, description: 'manual cadence-compatible immutable purged OOF lifecycle' },
  'active8-oof-weekly': { kind: 'research', holidayGated: false, description: 'weekly deterministic Active-8 purged OOF cohort generation' },
  'active8-oof-monthly': { kind: 'research', holidayGated: false, description: 'monthly post-retrain Active-8 purged OOF cohort generation' },
  'l4-alpha-ev-refresh': { kind: 'research', holidayGated: false, description: 'weekly production-gated L4 alpha EV artifact refresh' },
  'allocator-ev-fusion-refresh': { kind: 'research', holidayGated: false, description: 'weekly production-gated allocator EV fusion artifact refresh' },
  'monthly-opb-arm-prior-refresh': { kind: 'research', holidayGated: false, description: 'monthly production-gated OPB counterfactual arm-prior refresh' },
  'adaptive-meta-policy-replay': { kind: 'research', holidayGated: false, description: 'weekly guarded dynamic active-8 Meta policy replay with bounded canary and rollback' },
  'linucb-multiplier-replay': { kind: 'research', holidayGated: false, description: 'weekly evidence-only LinUCB bandit multiplier replay' },
  'weekly-drift-retrain': { kind: 'research', holidayGated: false, description: 'evidence-gated weekly drift candidate; automatic promotion only after full serving gates pass' },
  'sector-leaders': { kind: 'research', holidayGated: false, description: 'weekly sector leader refresh' },
  'monthly-optuna': { kind: 'research', holidayGated: false, description: 'monthly Optuna research sweep' },
  'monthly-l4-alpha-ev-refresh': { kind: 'research', holidayGated: false, description: 'monthly production-gated L4 alpha EV artifact refresh' },
  'monthly-allocator-ev-fusion-refresh': { kind: 'research', holidayGated: false, description: 'monthly production-gated allocator EV fusion artifact refresh' },
  'monthly-strategy-mining': { kind: 'research', holidayGated: false, description: 'monthly pymoo NSGA-III + novelty strategy mining preflight/research ledger' },
  'monthly-readiness': { kind: 'maintenance', holidayGated: false, description: 'monthly cycle terminal closure and fail-close summary' },
  'optuna-queue': { kind: 'queue', holidayGated: false, description: 'Optuna queue processor' },
  retrain: { kind: 'research', holidayGated: false, description: 'model retrain lifecycle trigger' },
  'monthly-retrain': { kind: 'research', holidayGated: false, description: 'monthly universal retrain lifecycle' },
}

const DOW_NAME_TO_NUM: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
}

const NUM_TO_DOW_NAME = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

function twNowDate(): Date {
  return new Date(Date.now() + 8 * 3600_000)
}

function twDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function parseDowValue(token: string): number | null {
  const upper = token.trim().toUpperCase()
  if (upper in DOW_NAME_TO_NUM) return DOW_NAME_TO_NUM[upper]
  const num = Number.parseInt(upper, 10)
  return Number.isFinite(num) ? num : null
}

function expandRange(rangeExpr: string): number[] {
  const [startToken, endToken] = rangeExpr.split('-')
  const start = parseDowValue(startToken)
  const end = parseDowValue(endToken)
  if (start == null || end == null) return []

  const out: number[] = []
  if (start <= end) {
    for (let i = start; i <= end; i += 1) out.push(i)
  } else {
    for (let i = start; i <= 6; i += 1) out.push(i)
    for (let i = 0; i <= end; i += 1) out.push(i)
  }
  return out
}

function parseDowExpr(expr: string): number[] {
  return expr
    .split(',')
    .flatMap((part) => part.includes('-') ? expandRange(part) : [parseDowValue(part)])
    .filter((value): value is number => value != null)
}

function twWallToUtcDate(twWall: Date): Date {
  return new Date(Date.UTC(
    twWall.getUTCFullYear(),
    twWall.getUTCMonth(),
    twWall.getUTCDate(),
    twWall.getUTCHours() - 8,
    twWall.getUTCMinutes(),
    twWall.getUTCSeconds(),
    twWall.getUTCMilliseconds(),
  ))
}

function fieldAllowsValue(expr: string, value: number): boolean {
  if (expr === '*') return true
  return expr
    .split(',')
    .some((part) => {
      const trimmed = part.trim()
      if (trimmed.includes('/')) {
        const [rangeExpr, stepExpr] = trimmed.split('/')
        const step = Number.parseInt(stepExpr, 10)
        if (!Number.isFinite(step) || step <= 0) return false
        const [startExpr, endExpr] = rangeExpr === '*' ? ['0', '59'] : rangeExpr.split('-')
        const start = Number.parseInt(startExpr, 10)
        const end = Number.parseInt(endExpr, 10)
        return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end && (value - start) % step === 0
      }
      if (trimmed.includes('-')) {
        const [startExpr, endExpr] = trimmed.split('-')
        const start = Number.parseInt(startExpr, 10)
        const end = Number.parseInt(endExpr, 10)
        return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end
      }
      const num = Number.parseInt(trimmed, 10)
      return Number.isFinite(num) && num === value
    })
}

function isCronDueOnUtcDate(domExpr: string, monthExpr: string, dowExpr: string, utcDate: Date): boolean {
  const monthOk = fieldAllowsValue(monthExpr, utcDate.getUTCMonth() + 1)
  if (!monthOk) return false
  const domOk = fieldAllowsValue(domExpr, utcDate.getUTCDate())
  if (dowExpr === '*') return domOk
  const dowOk = parseDowExpr(dowExpr).includes(utcDate.getUTCDay())
  if (domExpr === '*') return dowOk
  return domOk || dowOk
}

function parseFirstWeekdayOfMonth(groc: string): { dow: number; hour: number; minute: number; timeZone: 'UTC' | 'Asia/Taipei' } | null {
  const match = groc.trim().toLowerCase().match(
    /^first\s+(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\s+of\s+month\s+(\d{1,2}):(\d{2})(?:\s+(tw|taipei))?$/,
  )
  if (!match) return null
  const dow = NUM_TO_DOW_NAME.indexOf(match[1].slice(0, 3))
  const hour = Number.parseInt(match[2], 10)
  const minute = Number.parseInt(match[3], 10)
  if (dow < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return { dow, hour, minute, timeZone: match[4] ? 'Asia/Taipei' : 'UTC' }
}

function firstWeekdayInMonth(year: number, month: number, dow: number, hour: number, minute: number): Date {
  const candidate = new Date(Date.UTC(year, month, 1, hour, minute, 0, 0))
  while (candidate.getUTCDay() !== dow) candidate.setUTCDate(candidate.getUTCDate() + 1)
  return candidate
}

function formatNextRun(candidate: Date, hourTw: number, minute: number): string {
  return `${candidate.getUTCMonth() + 1}/${candidate.getUTCDate()} ${String(hourTw).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function parseNextRunDisplay(value: string, nowTw: Date): number {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{2}):(\d{2})$/)
  if (!match) return Number.POSITIVE_INFINITY
  const month = Number.parseInt(match[1], 10) - 1
  const day = Number.parseInt(match[2], 10)
  const hour = Number.parseInt(match[3], 10)
  const minute = Number.parseInt(match[4], 10)
  const candidate = new Date(Date.UTC(nowTw.getUTCFullYear(), month, day, hour, minute, 0, 0))
  if (candidate < nowTw) candidate.setUTCFullYear(candidate.getUTCFullYear() + 1)
  return candidate.getTime()
}

export function getSchedulerTaskPolicy(task: string): SchedulerTaskPolicy {
  return TASK_POLICIES[task] ?? DEFAULT_POLICY
}

interface TwseHolidayScheduleCache {
  schemaVersion: 'twse-holiday-schedule-v2'
  dates: string[]
  loadedAt: string
  source: 'twse.openapi.holidaySchedule'
}

export function parseTwseHolidayDates(
  rows: Array<{ Name?: string; Date?: string; Description?: string }>,
  year: number,
): string[] {
  return [...new Set(rows.flatMap((row) => {
    const raw = String(row.Date ?? '').trim()
    const text = `${row.Name ?? ''} ${row.Description ?? ''}`
    if (!/^\d{7}$/.test(raw)) return []
    const gregorianYear = Number(raw.slice(0, 3)) + 1911
    if (gregorianYear !== year) return []
    if (/\u958b\u59cb\u4ea4\u6613|\u6700\u5f8c\u4ea4\u6613\u65e5/.test(text)) return []
    if (!/\u653e\u5047|\u7121\u4ea4\u6613|\u505c\u6b62\u4ea4\u6613/.test(text)) return []
    return [`${gregorianYear}-${raw.slice(3, 5)}-${raw.slice(5, 7)}`]
  }))].sort()
}

async function loadTwseHolidaySchedule(
  kv: KVNamespace,
  year: number,
): Promise<TwseHolidayScheduleCache | null> {
  const cacheKey = `market:twse_holiday_schedule:v2:${year}`
  const cached = await kv.get(cacheKey, 'json') as TwseHolidayScheduleCache | null
  if (
    cached?.schemaVersion === 'twse-holiday-schedule-v2' &&
    Array.isArray(cached.dates)
  ) {
    return cached
  }
  if (typeof kv.put !== 'function') return null
  try {
    const response = await fetch('https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`twse_holiday_http_${response.status}`)
    const rows = await response.json() as Array<{ Name?: string; Date?: string; Description?: string }>
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('twse_holiday_payload_empty')
    const dates = parseTwseHolidayDates(rows, year)
    const schedule: TwseHolidayScheduleCache = {
      schemaVersion: 'twse-holiday-schedule-v2',
      dates: [...new Set(dates)].sort(),
      loadedAt: new Date().toISOString(),
      source: 'twse.openapi.holidaySchedule',
    }
    await kv.put(cacheKey, JSON.stringify(schedule), { expirationTtl: 7 * 86400 })
    return schedule
  } catch (error) {
    console.warn(`[schedulerPolicy] TWSE holiday schedule unavailable for year=${year}:`, error)
    return null
  }
}

export async function isTwHoliday(kv: KVNamespace, twDate: string): Promise<boolean> {
  if (await kv.get(`holiday:${twDate}`)) return true
  const year = Number(twDate.slice(0, 4))
  const schedule = await loadTwseHolidaySchedule(kv, year)
  return Boolean(schedule?.dates.includes(twDate))
}

export async function nextTwTradingDate(
  kv: KVNamespace,
  afterDate: string,
  db?: D1Database,
  options: { requireOfficialFutureCalendar?: boolean; nowMs?: number } = {},
): Promise<string> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(afterDate)) throw new Error(`invalid trading calendar date: ${afterDate}`)
  const today = new Date((options.nowMs ?? Date.now()) + 8 * 3600_000).toISOString().slice(0, 10)
  let candidate = new Date(`${afterDate}T00:00:00.000Z`)
  for (let offset = 1; offset <= 15; offset += 1) {
    candidate = new Date(candidate.getTime() + 86400_000)
    const date = candidate.toISOString().slice(0, 10)
    const weekday = candidate.getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    if (await kv.get(`holiday:${date}`)) continue
    if (date >= today && options.requireOfficialFutureCalendar) {
      const schedule = await loadTwseHolidaySchedule(kv, Number(date.slice(0, 4)))
      if (!schedule) throw new Error(`official TWSE future calendar unavailable for ${date}`)
      if (schedule.dates.includes(date)) continue
    } else if (await isTwHoliday(kv, date)) {
      continue
    }
    if (db && date < today) {
      const actualSession = await db.prepare(`
        SELECT 1 AS present
          FROM canonical_market_daily
         WHERE stock_id = '0050'
           AND source = 'finlab.price'
           AND date(date) = date(?)
         LIMIT 1
      `).bind(date).first<{ present?: number }>()
      if (Number(actualSession?.present ?? 0) !== 1) continue
    }
    return date
  }
  throw new Error(`next TWSE trading session unresolved after ${afterDate}`)
}

export async function shouldRunScheduledTask(input: {
  task: string
  kv: KVNamespace
  nowTw?: Date
}): Promise<SchedulerRunDecision> {
  const policy = getSchedulerTaskPolicy(input.task)
  const nowTw = input.nowTw ?? twNowDate()
  const twDate = twDateString(nowTw)
  const dow = nowTw.getUTCDay()
  const isWeekend = dow === 0 || dow === 6
  const globalPause = await input.kv.get('scheduler:pause:global')
  if (globalPause !== null) {
    return {
      shouldRun: false,
      reason: `global_pause:${String(globalPause || 'paused').slice(0, 120)}`,
      policy,
      twDate,
    }
  }
  const holiday = policy.holidayGated ? await isTwHoliday(input.kv, twDate) : false

  if (policy.holidayGated && (isWeekend || holiday)) {
    return {
      shouldRun: false,
      reason: `${isWeekend ? 'weekend' : 'holiday'}:${twDate}; policy=${policy.kind}`,
      policy,
      twDate,
    }
  }

  return { shouldRun: true, reason: `run; policy=${policy.kind}`, policy, twDate }
}

export async function getNextRunApproxWithPolicy(input: {
  task: string
  cron: string
  kv: KVNamespace
  nowTw?: Date
  skipKvPolicy?: boolean
}): Promise<string> {
  const { cron, task, kv } = input
  if (!cron) return 'N/A'
  const nowTw = input.nowTw ?? twNowDate()

  if (cron.includes('+')) {
    const candidates = await Promise.all(
      cron.split('+').map((part) => getNextRunApproxWithPolicy({
        task,
        cron: part.trim(),
        kv,
        nowTw,
        skipKvPolicy: input.skipKvPolicy,
      })),
    )
    return candidates
      .filter((candidate) => candidate !== 'N/A')
      .sort((a, b) => parseNextRunDisplay(a, nowTw) - parseNextRunDisplay(b, nowTw))[0] ?? 'N/A'
  }

  const groc = parseFirstWeekdayOfMonth(cron)
  if (groc) {
    for (let offset = 0; offset < 14; offset += 1) {
      const monthAnchor = new Date(Date.UTC(nowTw.getUTCFullYear(), nowTw.getUTCMonth() + offset, 1, 0, 0, 0, 0))
      const candidateBase = firstWeekdayInMonth(
        monthAnchor.getUTCFullYear(),
        monthAnchor.getUTCMonth(),
        groc.dow,
        groc.hour,
        groc.minute,
      )
      const candidateTw = groc.timeZone === 'Asia/Taipei'
        ? candidateBase
        : new Date(candidateBase.getTime() + 8 * 3600_000)
      if (candidateTw <= nowTw) continue
      if (input.skipKvPolicy) return formatNextRun(candidateTw, candidateTw.getUTCHours(), candidateTw.getUTCMinutes())
      const gate = await shouldRunScheduledTask({ task, kv, nowTw: candidateTw })
      if (gate.shouldRun) return formatNextRun(candidateTw, candidateTw.getUTCHours(), candidateTw.getUTCMinutes())
    }
    return 'N/A'
  }
  const parts = cron.split(' ')
  if (parts.length < 5) return 'N/A'

  const [min, hour, dom, month, dow] = parts
  const targetHourUtc = Number.parseInt(hour, 10)
  const targetMin = Number.parseInt(min, 10)
  if (!Number.isFinite(targetHourUtc) || !Number.isFinite(targetMin)) return 'N/A'

  const targetHourTw = (targetHourUtc + 8) % 24

  for (let offset = 0; offset < 32; offset += 1) {
    const candidate = new Date(nowTw)
    candidate.setUTCDate(candidate.getUTCDate() + offset)
    candidate.setUTCHours(targetHourTw, targetMin, 0, 0)
    if (candidate <= nowTw) continue

    const candidateUtc = twWallToUtcDate(candidate)
    if (!isCronDueOnUtcDate(dom, month, dow, candidateUtc)) continue

    if (input.skipKvPolicy) return formatNextRun(candidate, targetHourTw, targetMin)
    const gate = await shouldRunScheduledTask({ task, kv, nowTw: candidate })
    if (gate.shouldRun) return formatNextRun(candidate, targetHourTw, targetMin)
  }

  return 'N/A'
}
