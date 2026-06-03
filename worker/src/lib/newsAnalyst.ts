/**
 * newsAnalyst.ts — Daily macro news analyst agent
 *
 * Synthesizes overnight US markets + TAIFEX night session + concept buzz
 * + market risk/breadth into a structured daily macro report consumed by
 * morning-setup. Runs before the 07:15 TW morning pipeline (scheduled
 * ~06:30 TW).
 *
 * TradingAgents-inspired "News Analyst" role. Different from a multi-agent
 * framework we keep it single-LLM — the output is machine-readable JSON,
 * not conversational, which is the best format for downstream consumers
 * (debate mlContext, circuit-breaker threshold adjustment).
 *
 * References:
 *   - Tetlock, P. (2007). "Giving Content to Investor Sentiment: The Role
 *     of Media in the Stock Market." Journal of Finance 62(3), 1139-1168.
 *     Seminal: negative news lexicon predicts short-term returns.
 *   - Loughran, T. & McDonald, B. (2011). "When Is a Liability Not a
 *     Liability?" Journal of Finance 66(1). Finance-specific sentiment.
 *
 * Data sources (all existing, no new scrapers needed per user direction):
 *   - KV `us:leading:<date>` — US overnight (SOX, S&P, VIX, sentiment)
 *   - fetchTaifexNightClose() — TW futures night session
 *   - D1 market_risk — TW risk_level (NORMAL/HIGH/VERY_HIGH)
 *   - D1 market_breadth — bull_alignment_pct, advance_ratio
 *   - D1 concept_buzz — top 5 trending concepts with sentiment_avg
 */

import { callLLM, type LLMEnv } from './debateTrader'

// ── Types ────────────────────────────────────────────────────────────────────

export type NewsBias = 'positive' | 'neutral' | 'negative'

export interface NewsAnalystReport {
  date: string                        // YYYY-MM-DD (TW timezone)
  bias: NewsBias
  confidence: number                  // 0..1
  key_factors: string[]               // e.g. ["Fed 降息 25bp", "SOX +2.1%"]
  sector_bias: Record<string, number> // e.g. { "半導體": 0.5, "金融": -0.2 }
  risk_factors: string[]              // forward-looking risks, e.g. ["明日 CPI 公布"]
  summary: string                     // short paragraph for human review
  source: string                      // LLM layer that answered (tunnel/gemini/haiku)
}

export interface NewsAnalystEnv extends LLMEnv {
  DB: D1Database
  KV: KVNamespace
}

// ── Data gathering ───────────────────────────────────────────────────────────

interface GatheredContext {
  us_signal?: Record<string, any>
  taifex_night?: { lastPrice: number; changePct: number; changePoints: number }
  market_risk?: { risk_level: string; date: string }
  market_breadth?: { bull_alignment_pct: number | null; advance_ratio: number | null; date: string }
  top_concepts?: Array<{ concept: string; mention_count: number; sentiment_avg: number }>
}

async function gatherContext(env: NewsAnalystEnv, today: string): Promise<GatheredContext> {
  const out: GatheredContext = {}

  // US overnight
  try {
    out.us_signal = (await env.KV.get(`us:leading:${today}`, 'json')) as any
  } catch { /* non-fatal */ }

  // TAIFEX night session — lazy import to avoid heavy deps
  try {
    const { fetchTaifexNightClose } = await import('./twseApi')
    const tf = await fetchTaifexNightClose()
    if (tf) out.taifex_night = {
      lastPrice: tf.lastPrice,
      changePct: tf.changePct,
      changePoints: tf.changePoints,
    }
  } catch { /* non-fatal */ }

  // Market risk
  try {
    const r = await env.DB.prepare(
      'SELECT risk_level, date FROM market_risk ORDER BY date DESC LIMIT 1'
    ).first<{ risk_level: string; date: string }>()
    if (r) out.market_risk = r
  } catch { /* non-fatal */ }

  // Market breadth
  try {
    const b = await env.DB.prepare(
      'SELECT bull_alignment_pct, advance_ratio, date FROM market_breadth ORDER BY date DESC LIMIT 1'
    ).first<any>()
    if (b) out.market_breadth = b
  } catch { /* non-fatal */ }

  // Top concept buzz for today
  try {
    const { results } = await env.DB.prepare(`
      SELECT concept, mention_count, sentiment_avg
        FROM concept_buzz
       WHERE date = ?
       ORDER BY mention_count DESC
       LIMIT 5
    `).bind(today).all<any>()
    if (results && results.length > 0) {
      out.top_concepts = results
    }
  } catch { /* non-fatal */ }

  return out
}

// ── Prompt builder ───────────────────────────────────────────────────────────

function buildPrompts(today: string, ctx: GatheredContext): { system: string; user: string } {
  const parts: string[] = []

  if (ctx.us_signal) {
    const u = ctx.us_signal
    const lines: string[] = []
    if (u.sox_return != null) lines.push(`SOX ${(u.sox_return * 100).toFixed(1)}%`)
    if (u.gspc_return != null) lines.push(`S&P ${(u.gspc_return * 100).toFixed(1)}%`)
    if (u.vix_close != null) lines.push(`VIX ${Number(u.vix_close).toFixed(1)}`)
    if (u.sentiment) lines.push(`情緒 ${u.sentiment}`)
    if (lines.length) parts.push(`美股前夜：${lines.join(' | ')}`)
  }

  if (ctx.taifex_night) {
    const t = ctx.taifex_night
    const sign = t.changePct >= 0 ? '+' : ''
    parts.push(`台指期夜盤：收 ${t.lastPrice.toLocaleString()} (${sign}${t.changePct.toFixed(2)}%, ${sign}${Math.round(t.changePoints)} 點)`)
  }

  if (ctx.market_risk) {
    parts.push(`大盤風險級別（D1）：${ctx.market_risk.risk_level}`)
  }

  if (ctx.market_breadth) {
    const b = ctx.market_breadth
    const align = b.bull_alignment_pct != null ? `${Number(b.bull_alignment_pct).toFixed(0)}%` : 'N/A'
    const adv = b.advance_ratio != null ? Number(b.advance_ratio).toFixed(2) : 'N/A'
    parts.push(`市場廣度：多頭排列 ${align}，漲跌比 ${adv}`)
  }

  if (ctx.top_concepts && ctx.top_concepts.length > 0) {
    const bits = ctx.top_concepts.map(c =>
      `${c.concept}(${c.mention_count}次, 情緒${c.sentiment_avg >= 0 ? '+' : ''}${c.sentiment_avg.toFixed(2)})`
    )
    parts.push(`今日熱門題材：${bits.join(' / ')}`)
  }

  if (parts.length === 0) {
    parts.push('(無可用市場資料)')
  }

  const system = `你是資深的台灣股市宏觀分析師。根據以下多個市場訊號，產出當日的 structured 市場判斷。

輸出必須是嚴格的 JSON（無任何額外文字，無 markdown 碼框），schema：
{
  "bias": "positive" | "neutral" | "negative",     // 全市場當日偏向
  "confidence": 0.0-1.0,                           // 判斷把握度
  "key_factors": ["..."],                          // 3-5 個最關鍵訊號
  "sector_bias": { "半導體": 0.5, "金融": -0.2 },  // 產業 bias，[-1, 1]，至少 2 個最多 5 個
  "risk_factors": ["..."],                         // 2-3 個前瞻性風險
  "summary": "..."                                 // 40-80 字摘要
}

規則：
- confidence 低於 0.4 時，bias 必須為 "neutral"
- sector_bias 只列你有明確訊號的產業，別列 0 值
- 嚴守台股視角：不要直接把美股漲跌等同台股（有 SOX 領先、權值股影響）
- 不得捏造數字；只引用提供的訊號`

  const user = `今日 ${today} 的市場訊號：

${parts.join('\n')}

請輸出當日市場判斷 JSON：`

  return { system, user }
}

// ── JSON parser (robust against minor LLM format variance) ───────────────────

function parseReportJson(raw: string): Omit<NewsAnalystReport, 'date' | 'source'> | null {
  // Strip possible markdown fences / surrounding text
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as any
    if (!j.bias || !['positive', 'neutral', 'negative'].includes(j.bias)) return null
    const confidence = Math.max(0, Math.min(1, Number(j.confidence ?? 0.5)))
    const bias: NewsBias = confidence < 0.4 ? 'neutral' : j.bias
    return {
      bias,
      confidence,
      key_factors: Array.isArray(j.key_factors) ? j.key_factors.slice(0, 5).map(String) : [],
      sector_bias: (j.sector_bias && typeof j.sector_bias === 'object')
        ? Object.fromEntries(
            Object.entries(j.sector_bias)
              .filter(([, v]) => typeof v === 'number' && Math.abs(v as number) > 0.05)
              .slice(0, 5)
          ) as Record<string, number>
        : {},
      risk_factors: Array.isArray(j.risk_factors) ? j.risk_factors.slice(0, 3).map(String) : [],
      summary: typeof j.summary === 'string' ? j.summary.slice(0, 300) : '',
    }
  } catch {
    return null
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * Run the daily news analysis. Returns the structured report (and writes
 * it to KV `market:news_analyst:<today>` with 24h TTL).
 *
 * Non-fatal: any gather/LLM error returns a neutral fallback report that
 * morning-setup can still consume (bias=neutral, empty sector_bias).
 */
export async function runDailyNewsAnalysis(env: NewsAnalystEnv): Promise<NewsAnalystReport> {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)

  const ctx = await gatherContext(env, today)
  const prompts = buildPrompts(today, ctx)

  let report: NewsAnalystReport
  try {
    const { text, source } = await callLLM(env, prompts.system, prompts.user, 0.3)
    const parsed = parseReportJson(text)
    if (parsed) {
      report = { ...parsed, date: today, source }
    } else {
      console.warn('[NewsAnalyst] LLM returned unparseable JSON; falling back to neutral')
      report = {
        date: today, bias: 'neutral', confidence: 0.3,
        key_factors: [], sector_bias: {}, risk_factors: [],
        summary: 'LLM 解析失敗，保守中性',
        source: `${source}:parse_failed`,
      }
    }
  } catch (e) {
    console.warn('[NewsAnalyst] LLM call failed:', e)
    report = {
      date: today, bias: 'neutral', confidence: 0.0,
      key_factors: [], sector_bias: {}, risk_factors: [],
      summary: `LLM 不可用：${String(e).slice(0, 80)}`,
      source: 'error',
    }
  }

  try {
    await env.KV.put(
      `market:news_analyst:${today}`,
      JSON.stringify(report),
      { expirationTtl: 86400 },
    )
  } catch (e) {
    console.warn('[NewsAnalyst] KV write failed:', e)
  }

  console.log(
    `[NewsAnalyst] ${today} bias=${report.bias} conf=${report.confidence.toFixed(2)} ` +
    `factors=${report.key_factors.length} sectors=${Object.keys(report.sector_bias).length} ` +
    `(source=${report.source})`
  )

  return report
}

/**
 * Read the current day's news-analyst report from KV.
 * Returns null if not set (e.g. cron hasn't fired yet today).
 */
export async function readCurrentNewsReport(
  kv: KVNamespace,
  today: string,
): Promise<NewsAnalystReport | null> {
  try {
    return (await kv.get(`market:news_analyst:${today}`, 'json')) as NewsAnalystReport | null
  } catch {
    return null
  }
}
