/**
 * postExit.ts - Post-exit discipline and candidate re-rank
 *
 * After a sell is executed, we:
 * 1. set per-symbol cooldown
 * 2. activate stop-day freeze for hard stop / init stop exits
 * 3. optionally enqueue one replacement candidate back into pending buys
 */

import { appendPendingBuy, loadPendingBuySnapshot } from './pendingBuyStore'
import { readScoreV2Snapshot, serializeScoreV2Snapshot } from './scoreV2Taxonomy'

export type ExitReasonCategory =
  | 'HardStop'
  | 'InitStop'
  | 'TrailStop'
  | 'ML_SELL'
  | 'TP1'
  | 'TP2'
  | 'TimeStop'
  | 'Unknown'

export interface PostExitContext {
  kv: KVNamespace
  db: D1Database
  today: string
  soldSymbol: string
  exitReason: string
  exitAction: 'full_sell' | 'partial_sell'
  accountId: number | string
}

export interface PostExitOutcome {
  category: ExitReasonCategory
  cooldown_days: number
  freeze_applied: boolean
  rerank_queued: boolean
  rerank_symbol?: string
  reason?: string
}

export const COOLDOWN_DAYS: Record<ExitReasonCategory, number> = {
  HardStop: 5,
  InitStop: 3,
  TrailStop: 1,
  ML_SELL: 2,
  TP1: 0,
  TP2: 0,
  TimeStop: 1,
  Unknown: 1,
}

const TRADING_DAY_SECONDS = Math.round(1.5 * 86400)
const cooldownKey = (symbol: string) => `paper:cooldown:${symbol}`
const stopDayFreezeKey = (today: string) => `paper:stop_day_freeze:${today}`

export function classifyExitReason(raw: string): ExitReasonCategory {
  const s = (raw ?? '').toString()
  if (/HardStop|硬停損|hard[-_ ]?stop/i.test(s)) return 'HardStop'
  if (/InitStop|ATR 初始停損|initial\s*stop/i.test(s)) return 'InitStop'
  if (/TrailStop|Trailing Stop|移動停損|trailing/i.test(s)) return 'TrailStop'
  if (/ML[_\s-]*SELL|ML 賣出/i.test(s)) return 'ML_SELL'
  if (/TP1|部分停利|partial/i.test(s)) return 'TP1'
  if (/TP2|全部停利|target2/i.test(s)) return 'TP2'
  if (/TimeStop|時間停損|max[_\s-]*hold/i.test(s)) return 'TimeStop'
  return 'Unknown'
}

export async function setCooldown(
  kv: KVNamespace,
  symbol: string,
  category: ExitReasonCategory,
): Promise<number> {
  const days = COOLDOWN_DAYS[category] ?? 1
  if (days <= 0) return 0
  const ttl = days * TRADING_DAY_SECONDS
  const payload = {
    symbol,
    category,
    days,
    set_at: new Date().toISOString(),
  }
  try {
    await kv.put(cooldownKey(symbol), JSON.stringify(payload), { expirationTtl: ttl })
  } catch (error) {
    console.warn(`[PostExit] setCooldown(${symbol}) failed:`, error)
  }
  return days
}

export async function filterOutCooldowns(
  kv: KVNamespace,
  symbols: readonly string[],
): Promise<string[]> {
  const out: string[] = []
  for (const sym of symbols) {
    try {
      const raw = await kv.get(cooldownKey(sym))
      if (raw == null) out.push(sym)
    } catch {
      out.push(sym)
    }
  }
  return out
}

export async function isOnCooldown(kv: KVNamespace, symbol: string): Promise<boolean> {
  try {
    return (await kv.get(cooldownKey(symbol))) != null
  } catch {
    return false
  }
}

export async function markStopDayFreeze(
  kv: KVNamespace,
  today: string,
  triggerSymbol: string,
  category: ExitReasonCategory,
): Promise<void> {
  const payload = {
    date: today,
    trigger_symbol: triggerSymbol,
    category,
    set_at: new Date().toISOString(),
  }
  try {
    await kv.put(stopDayFreezeKey(today), JSON.stringify(payload), { expirationTtl: 86400 })
    console.warn(`[PostExit] Stop-day freeze ACTIVE (${today}) | trigger=${triggerSymbol} reason=${category}`)
  } catch (error) {
    console.warn('[PostExit] markStopDayFreeze failed:', error)
  }
}

export async function isStopDayFrozen(kv: KVNamespace, today: string): Promise<boolean> {
  try {
    return (await kv.get(stopDayFreezeKey(today))) != null
  } catch {
    return false
  }
}

export async function onPostExit(
  ctx: PostExitContext,
  opts: {
    enableRerank?: boolean
    maxPositions: number
  },
): Promise<PostExitOutcome> {
  const category = classifyExitReason(ctx.exitReason)
  const outcome: PostExitOutcome = {
    category,
    cooldown_days: 0,
    freeze_applied: false,
    rerank_queued: false,
  }

  outcome.cooldown_days = await setCooldown(ctx.kv, ctx.soldSymbol, category)

  if (category === 'HardStop' || category === 'InitStop') {
    await markStopDayFreeze(ctx.kv, ctx.today, ctx.soldSymbol, category)
    outcome.freeze_applied = true
    outcome.reason = `stop_day_freeze(${category})`
    return outcome
  }

  if (!opts.enableRerank) {
    outcome.reason = 'rerank_disabled'
    return outcome
  }

  try {
    const holdingsRow = await ctx.db.prepare(
      'SELECT COUNT(*) AS n FROM paper_positions WHERE account_id = ?',
    ).bind(ctx.accountId).first<{ n: number }>()
    const nHoldings = Number(holdingsRow?.n ?? 0)
    if (nHoldings >= opts.maxPositions) {
      outcome.reason = `at_topK(${nHoldings}/${opts.maxPositions})`
      return outcome
    }

    if (await isStopDayFrozen(ctx.kv, ctx.today)) {
      outcome.reason = 'stop_day_frozen_earlier'
      return outcome
    }

    const { results: recs } = await ctx.db.prepare(`
      SELECT dr.symbol, dr.name, dr.signal, dr.confidence, dr.current_price,
             dr.reason, dr.score_components
        FROM daily_recommendations dr
       WHERE dr.date = ?
         AND dr.has_buy_signal = 1
       ORDER BY CASE WHEN json_valid(dr.score_components) THEN
          COALESCE(
            CAST(json_extract(dr.score_components, '$.finalScore') AS REAL),
            CAST(json_extract(dr.score_components, '$.total') AS REAL),
            0
          ) ELSE 0 END DESC,
          dr.confidence DESC
       LIMIT 20
    `).bind(ctx.today).all<any>()
    if (!recs || recs.length === 0) {
      outcome.reason = 'no_candidates'
      return outcome
    }

    const { results: heldRows } = await ctx.db.prepare(
      'SELECT symbol FROM paper_positions WHERE account_id = ?',
    ).bind(ctx.accountId).all<{ symbol: string }>()
    const heldSet = new Set((heldRows ?? []).map((row) => row.symbol))
    heldSet.add(ctx.soldSymbol)

    let punishedSet = new Set<string>()
    try {
      const punished = await ctx.kv.get('market:punished_stocks', 'json') as string[] | null
      if (punished) punishedSet = new Set(punished)
    } catch {
      punishedSet = new Set()
    }

    const candidates = recs.filter((row: any) => !heldSet.has(row.symbol) && !punishedSet.has(row.symbol)) as any[]
    const eligibleSet = new Set(await filterOutCooldowns(ctx.kv, candidates.map((row) => row.symbol)))
    const best = candidates.find((row: any) => eligibleSet.has(row.symbol))
    if (!best) {
      outcome.reason = 'all_candidates_cooldown_or_excluded'
      return outcome
    }
    const scoreV2 = readScoreV2Snapshot(best)
    if (!scoreV2) {
      outcome.reason = 'missing_score_v2_payload'
      return outcome
    }

    const snapshot = await loadPendingBuySnapshot(ctx as any, ctx.today, { allowFallbackRecent: false })
    const alreadyQueued = (snapshot.pendingBuys ?? []).some((item: any) => item.symbol === best.symbol)
    if (alreadyQueued) {
      outcome.reason = 'already_queued'
      return outcome
    }

    const newEntry = {
      symbol: best.symbol,
      name: best.name ?? best.symbol,
      signal: best.signal ?? 'BUY',
      confidence: Number(best.confidence ?? 0.6),
      ml_entry_price: Number(best.current_price ?? 0),
      ml_stop_loss: null,
      ml_target1: null,
      ml_target2: null,
      reason: `post_exit_rerank (replaces ${ctx.soldSymbol}; ${best.reason ?? ''})`,
      debate_verdict: 'skipped',
      risk_pct: 0.01,
      kelly_pct: null,
      score_v2: serializeScoreV2Snapshot(scoreV2),
      source: 'post_exit_rerank',
    }

    await appendPendingBuy(ctx as any, ctx.today, newEntry as any, {
      stage: 'post_exit_rerank',
      sold_symbol: ctx.soldSymbol,
      exit_reason: ctx.exitReason,
    })

    outcome.rerank_queued = true
    outcome.rerank_symbol = best.symbol
    outcome.reason = `queued(${best.symbol})`
    console.log(
      `[PostExit] re-rank queued: ${ctx.soldSymbol} -> ${best.symbol} ` +
      `(score=${scoreV2.finalScore}, reason=${ctx.exitReason})`,
    )
  } catch (error) {
    outcome.reason = `rerank_error(${String(error).slice(0, 80)})`
    console.warn('[PostExit] re-rank failed (non-fatal):', error)
  }

  return outcome
}
