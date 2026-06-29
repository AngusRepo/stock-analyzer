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
  'daily-snapshot': { kind: 'trading_day', holidayGated: true, description: 'post-market account snapshot' },
  'market-close-refresh': { kind: 'trading_day', holidayGated: true, description: '18:10 market-close data refresh before readiness probe' },
  'source-readiness-probe': { kind: 'trading_day', holidayGated: true, description: 'readiness-gated probe that starts full evening chain once FinLab/official sources are current' },
  'evening-chain': { kind: 'trading_day', holidayGated: true, description: 'post-market event-driven chain root' },
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
  'verify-v2': { kind: 'trading_day', holidayGated: true, description: 'daily verify and IC refresh' },
  'us-leading': { kind: 'trading_day', holidayGated: true, description: 'pre-market US leading signal' },
  'news-analyst': { kind: 'trading_day', holidayGated: true, description: 'pre-market news analyst' },
  'morning-setup': { kind: 'trading_day', holidayGated: true, description: 'morning setup and debate' },
  'morning-briefing': { kind: 'trading_day', holidayGated: true, description: 'morning briefing delivery' },
  'pre-market-warmup': { kind: 'trading_day', holidayGated: true, description: 'pre-market control-plane warmup' },
  'paper-trade': { kind: 'trading_day', holidayGated: true, description: 'paper trading execution' },

  'weekly-audit': { kind: 'trading_week', holidayGated: true, description: 'weekly trading audit' },
  'model-ic-tracker': { kind: 'trading_week', holidayGated: true, description: 'weekly model IC tracker' },

  'debate-memory-retention': { kind: 'maintenance', holidayGated: false, description: 'daily debate memory retention' },
  'weekly-cleanup': { kind: 'maintenance', holidayGated: false, description: 'weekly cleanup and lifecycle check; no retrain' },
  'weekly-backtest': { kind: 'research', holidayGated: false, description: 'weekly lightweight backtest, Monte Carlo, PBO validation' },
  'alpha-quality': { kind: 'research', holidayGated: false, description: 'weekly alpha quality research' },
  'weekly-optuna': { kind: 'research', holidayGated: false, description: 'weekly lightweight Optuna/GA calibration' },
  'adaptive-meta-policy-replay': { kind: 'research', holidayGated: false, description: 'weekly evidence-only active-8 adaptive meta-policy replay' },
  'linucb-multiplier-replay': { kind: 'research', holidayGated: false, description: 'weekly evidence-only LinUCB bandit multiplier replay' },
  'weekly-drift-retrain': { kind: 'research', holidayGated: false, description: 'approval-gated weekly drift hotfix candidate; not weekly cleanup' },
  'sector-leaders': { kind: 'research', holidayGated: false, description: 'weekly sector leader refresh' },
  'monthly-optuna': { kind: 'research', holidayGated: false, description: 'monthly Optuna research sweep' },
  'monthly-strategy-mining': { kind: 'research', holidayGated: false, description: 'monthly pymoo NSGA-III + novelty strategy mining preflight/research ledger' },
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

export async function isTwHoliday(kv: KVNamespace, twDate: string): Promise<boolean> {
  return Boolean(await kv.get(`holiday:${twDate}`))
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

    const gate = await shouldRunScheduledTask({ task, kv, nowTw: candidate })
    if (gate.shouldRun) return formatNextRun(candidate, targetHourTw, targetMin)
  }

  return 'N/A'
}
