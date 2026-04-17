/**
 * postExit.ts — Post-exit discipline and candidate re-rank
 *
 * Applies three discipline filters after a position is sold:
 *
 *   1. Per-symbol cooldown (prevents revenge trading on the same name)
 *      - HardStop    → 5 trading days
 *      - InitStop    → 3 trading days
 *      - ML_SELL     → 2 trading days
 *      - TrailStop   → 1 trading day
 *      - TP1 / TP2   → 0 (profit-taking exits may re-enter the next bar)
 *
 *   2. Stop-day freeze (when a HardStop or InitStop exit fires today,
 *      freeze all NEW entries for the rest of the day; existing holdings
 *      unaffected). This protects capital from correlated-loss cascades.
 *
 *   3. topK guard: never exceed the configured max positions. Re-rank only
 *      queues a buy when there is an open slot.
 *
 * References (behavioral-finance grounding):
 *   - Odean, T. (1998). "Are Investors Reluctant to Realize Their Losses?"
 *     Journal of Finance 53(5). — disposition effect → frequent re-entry
 *     is an identified cognitive bias.
 *   - Barber, B. & Odean, T. (2000). "Trading is Hazardous to Your Wealth."
 *     Journal of Finance 55(2). — over-trading directly correlates with
 *     underperformance.
 *   - Perold, A. (1988). "The Implementation Shortfall." JPM. — cash drag
 *     has a real cost; same-day re-deploy reduces it.
 *
 * This module does NOT execute trades. It appends to the existing
 * `paper:pending_buys:<today>` KV queue; the existing order-execution
 * cron consumes that queue. Failure here is non-fatal (logged only).
 */

// ── Types ────────────────────────────────────────────────────────────────────

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
  today: string                 // YYYY-MM-DD (Taiwan timezone)
  soldSymbol: string
  exitReason: string            // raw reason string from checkExitConditions
  exitAction: 'full_sell' | 'partial_sell'
  accountId: number | string    // paper_accounts.id (currently = 1)
}

// ── Cooldown policy ──────────────────────────────────────────────────────────

/** Cooldown (in trading days) per exit reason category. */
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

/** TTL translation: 1 trading day ≈ 1.5 calendar days (weekends, holidays). */
const TRADING_DAY_SECONDS = Math.round(1.5 * 86400)

/**
 * Classify a raw exit-reason string (from checkExitConditions.reason) into a
 * coarse category for cooldown policy lookup.  Handles both Chinese and English
 * reason strings that appear throughout paper.ts.
 */
export function classifyExitReason(raw: string): ExitReasonCategory {
  const s = (raw ?? '').toString()
  if (/HardStop|硬上限|hard[-_ ]?stop/i.test(s)) return 'HardStop'
  if (/InitStop|ATR\s*初始|initial\s*stop/i.test(s)) return 'InitStop'
  if (/TrailStop|移動停損|trailing/i.test(s)) return 'TrailStop'
  if (/ML[_\s-]*SELL|ML\s*訊號/i.test(s)) return 'ML_SELL'
  if (/TP1|第一目標|partial/i.test(s)) return 'TP1'
  if (/TP2|第二目標|target2/i.test(s)) return 'TP2'
  if (/TimeStop|時間止損|max[_\s-]*hold/i.test(s)) return 'TimeStop'
  return 'Unknown'
}

// ── Cooldown KV helpers ──────────────────────────────────────────────────────

const cooldownKey = (symbol: string) => `paper:cooldown:${symbol}`
const stopDayFreezeKey = (today: string) => `paper:stop_day_freeze:${today}`

/** Write cooldown flag for a symbol; TTL sized to the configured trading-day count. */
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
  } catch (e) {
    console.warn(`[PostExit] setCooldown(${symbol}) failed:`, e)
  }
  return days
}

/**
 * Filter candidate symbols against current cooldown KV entries.
 * Returns the subset that is NOT on cooldown (safe to consider for buy).
 */
export async function filterOutCooldowns(
  kv: KVNamespace,
  symbols: readonly string[],
): Promise<string[]> {
  const out: string[] = []
  for (const sym of symbols) {
    try {
      const v = await kv.get(cooldownKey(sym))
      if (v == null) out.push(sym)
    } catch {
      // On any error, pass through — cooldown is an optimistic optimization
      out.push(sym)
    }
  }
  return out
}

/** Test-utility: is this specific symbol currently on cooldown? */
export async function isOnCooldown(kv: KVNamespace, symbol: string): Promise<boolean> {
  try {
    return (await kv.get(cooldownKey(symbol))) != null
  } catch {
    return false
  }
}

// ── Stop-day freeze KV helpers ───────────────────────────────────────────────

/**
 * Set the stop-day freeze flag, valid for the rest of today.
 * TTL ≈ 24h (covers cross-midnight edge cases in TW timezone).
 */
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
    console.warn(
      `[PostExit] Stop-day freeze ACTIVE (${today}) — trigger=${triggerSymbol} reason=${category}`
    )
  } catch (e) {
    console.warn(`[PostExit] markStopDayFreeze failed:`, e)
  }
}

/** Is today's stop-day freeze flag active? */
export async function isStopDayFrozen(kv: KVNamespace, today: string): Promise<boolean> {
  try {
    return (await kv.get(stopDayFreezeKey(today))) != null
  } catch {
    return false
  }
}

// ── Main post-exit hook ──────────────────────────────────────────────────────

export interface PostExitOutcome {
  category: ExitReasonCategory
  cooldown_days: number
  freeze_applied: boolean
  rerank_queued: boolean
  rerank_symbol?: string
  reason?: string
}

/**
 * Called immediately after a sell is committed to paper_orders.
 *
 * Responsibilities:
 *   - Classify the exit reason
 *   - Set per-symbol cooldown
 *   - If stop-out category → set stop-day freeze (early return, no new buy)
 *   - Otherwise, if slots are open and freeze is not active, append the
 *     highest-scoring eligible candidate to the existing pending_buys queue
 *
 * This function NEVER throws; all failures are logged and swallowed, because
 * it runs as a best-effort side-effect of sell execution.
 */
export async function onPostExit(
  ctx: PostExitContext,
  opts: {
    enableRerank?: boolean          // false = discipline only, no pending-buy queueing
    maxPositions: number            // cfg.position.maxPositions
  },
): Promise<PostExitOutcome> {
  const category = classifyExitReason(ctx.exitReason)
  const outcome: PostExitOutcome = {
    category,
    cooldown_days: 0,
    freeze_applied: false,
    rerank_queued: false,
  }

  // Discipline 1 + 2: cooldown + freeze (always applied)
  outcome.cooldown_days = await setCooldown(ctx.kv, ctx.soldSymbol, category)

  if (category === 'HardStop' || category === 'InitStop') {
    await markStopDayFreeze(ctx.kv, ctx.today, ctx.soldSymbol, category)
    outcome.freeze_applied = true
    outcome.reason = `stop_day_freeze(${category})`
    return outcome
  }

  // Discipline 3: optional re-rank (opt-in to keep current behavior as default)
  if (!opts.enableRerank) {
    outcome.reason = 'rerank_disabled'
    return outcome
  }

  // Check current holdings vs topK cap
  try {
    const holdingsRow = await ctx.db.prepare(
      `SELECT COUNT(*) AS n FROM paper_positions WHERE account_id = ?`
    ).bind(ctx.accountId).first<{ n: number }>()
    const nHoldings = Number(holdingsRow?.n ?? 0)
    if (nHoldings >= opts.maxPositions) {
      outcome.reason = `at_topK(${nHoldings}/${opts.maxPositions})`
      return outcome
    }

    // Check stop-day freeze (may have been set earlier today by another exit)
    if (await isStopDayFrozen(ctx.kv, ctx.today)) {
      outcome.reason = 'stop_day_frozen_earlier'
      return outcome
    }

    // Fetch today's candidates from daily_recommendations, ordered by score
    const { results: recs } = await ctx.db.prepare(`
      SELECT dr.symbol, dr.name, dr.signal, dr.confidence, dr.current_price,
             dr.reason, dr.score, dr.chip_score, dr.tech_score, dr.ml_score
        FROM daily_recommendations dr
       WHERE dr.date = ?
         AND dr.has_buy_signal = 1
       ORDER BY dr.score DESC, dr.confidence DESC
       LIMIT 20
    `).bind(ctx.today).all<any>()
    if (!recs || recs.length === 0) {
      outcome.reason = 'no_candidates'
      return outcome
    }

    // Exclude currently-held symbols
    const { results: heldRows } = await ctx.db.prepare(
      `SELECT symbol FROM paper_positions WHERE account_id = ?`
    ).bind(ctx.accountId).all<{ symbol: string }>()
    const heldSet = new Set((heldRows ?? []).map(r => r.symbol))
    heldSet.add(ctx.soldSymbol)  // also exclude the just-sold (cooldown=0 case still deferred 1 bar)

    // Exclude punished stocks
    let punishedSet = new Set<string>()
    try {
      const punished = await ctx.kv.get('market:punished_stocks', 'json') as string[] | null
      if (punished) punishedSet = new Set(punished)
    } catch { /* non-fatal */ }

    const candidates = recs.filter(r =>
      !heldSet.has(r.symbol) &&
      !punishedSet.has(r.symbol)
    ) as any[]
    const symbols = candidates.map((c: any) => c.symbol)
    const eligibleSymbols = await filterOutCooldowns(ctx.kv, symbols)
    const eligibleSet = new Set(eligibleSymbols)
    const best = candidates.find((c: any) => eligibleSet.has(c.symbol))

    if (!best) {
      outcome.reason = 'all_candidates_cooldown_or_excluded'
      return outcome
    }

    // Append to existing pending_buys queue (re-use morning-setup format)
    const existingRaw = await ctx.kv.get(`paper:pending_buys:${ctx.today}`, 'json') as any[] | null
    const existing = existingRaw ?? []
    const alreadyQueued = existing.some((b: any) => b.symbol === best.symbol)
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
      risk_pct: 0.01,  // conservative default; morning-setup uses cfg-driven values
      kelly_pct: null,
      chip_score: best.chip_score ?? null,
      tech_score: best.tech_score ?? null,
      ml_score: best.ml_score ?? null,
      score: best.score ?? null,
      source: 'post_exit_rerank',
    }

    await ctx.kv.put(
      `paper:pending_buys:${ctx.today}`,
      JSON.stringify([...existing, newEntry]),
      { expirationTtl: 86400 },
    )
    outcome.rerank_queued = true
    outcome.rerank_symbol = best.symbol
    outcome.reason = `queued(${best.symbol})`
    console.log(
      `[PostExit] re-rank queued: ${ctx.soldSymbol} → ${best.symbol} ` +
      `(score=${best.score}, reason=${ctx.exitReason})`
    )
  } catch (e) {
    outcome.reason = `rerank_error(${String(e).slice(0, 80)})`
    console.warn(`[PostExit] re-rank failed (non-fatal):`, e)
  }

  return outcome
}
