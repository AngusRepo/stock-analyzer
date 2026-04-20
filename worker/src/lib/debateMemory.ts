/**
 * debateMemory.ts — 2026-04-20 #18 FinMem 分層歷史記憶
 *
 * Reader + Writer for debate_memory D1 table.
 *   - insertDebateMemory:    runBuyDebate 結束後寫入
 *   - getHistoricalThesis:   runBuyDebate prompt 組裝時讀 7d/30d/90d
 *   - renderHistoricalThesisBlock: 格式化成 LLM-friendly block (空時回空字串)
 *
 * Graceful degradation: DB 缺、table 空、query 失敗 → 回空結果，debate 正常跑（只是無歷史 context）。
 */

declare const D1Database: any
type D1Database = any

export type DebateDirection = 'bullish' | 'bearish' | 'neutral'

export interface DebateMemoryRow {
  symbol: string
  debate_date: string              // YYYY-MM-DD (TW)
  thesis_summary: string           // 會自動 truncate 至 200 字
  direction: DebateDirection
  key_factors?: string[] | null
  verdict: 'APPROVE' | 'DOWNGRADE' | 'REJECT'
  conviction_score: number         // 0-100
  llm_source: string               // tunnel | gemini_api | anthropic_api | unknown
}

export interface ThesisSlice {
  date: string
  direction: string
  verdict: string
  conviction: number
  summary: string
}

export interface HistoricalThesisBundle {
  last_7d: ThesisSlice[]
  last_30d: ThesisSlice[]
  last_90d: ThesisSlice[]
}

// Format YYYY-MM-DD in TW timezone (UTC+8)
function twDate(offsetDays: number = 0): string {
  return new Date(Date.now() + 8 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10)
}

export async function insertDebateMemory(
  db: D1Database | undefined, row: DebateMemoryRow,
): Promise<void> {
  if (!db) return
  try {
    await db.prepare(`
      INSERT INTO debate_memory
        (symbol, debate_date, thesis_summary, direction, key_factors,
         verdict, conviction_score, llm_source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      row.symbol,
      row.debate_date,
      row.thesis_summary.slice(0, 200),
      row.direction,
      row.key_factors && row.key_factors.length ? JSON.stringify(row.key_factors) : null,
      row.verdict,
      Math.max(0, Math.min(100, row.conviction_score)),
      row.llm_source,
      new Date().toISOString(),
    ).run()
  } catch (e) {
    console.warn(`[DebateMemory] insert failed for ${row.symbol}: ${e}`)
  }
}

export async function getHistoricalThesis(
  db: D1Database | undefined, symbol: string,
): Promise<HistoricalThesisBundle> {
  const empty: HistoricalThesisBundle = { last_7d: [], last_30d: [], last_90d: [] }
  if (!db) return empty
  try {
    const today = twDate(0)
    const d7   = twDate(-7)
    const d30  = twDate(-30)
    const d90  = twDate(-90)

    const { results } = await db.prepare(`
      SELECT debate_date, direction, verdict, conviction_score, thesis_summary
      FROM debate_memory
      WHERE symbol = ? AND debate_date >= ? AND debate_date < ?
      ORDER BY debate_date DESC
      LIMIT 30
    `).bind(symbol, d90, today).all()

    const slices: ThesisSlice[] = (results ?? []).map((r: any) => ({
      date: r.debate_date,
      direction: r.direction,
      verdict: r.verdict,
      conviction: r.conviction_score,
      summary: r.thesis_summary,
    }))

    return {
      last_7d:  slices.filter(s => s.date >= d7),
      last_30d: slices.filter(s => s.date >= d30 && s.date < d7),
      last_90d: slices.filter(s => s.date >= d90 && s.date < d30),
    }
  } catch (e) {
    console.warn(`[DebateMemory] getHistoricalThesis failed for ${symbol}: ${e}`)
    return empty
  }
}

/**
 * Render historical thesis bundle into a LLM-friendly prompt block.
 * Returns empty string when bundle is empty (graceful degrade — early FinMem period).
 * Keeps each line compact to control token bloat.
 */
export function renderHistoricalThesisBlock(h: HistoricalThesisBundle): string {
  const total = h.last_7d.length + h.last_30d.length + h.last_90d.length
  if (total === 0) return ''

  const fmt = (s: ThesisSlice) =>
    `  - ${s.date} [${s.verdict}|conv${s.conviction}|${s.direction}]: ${s.summary.slice(0, 120)}`

  const lines: string[] = ['【歷史 thesis 摘要（供比對 drift / 一致性，不等於當前決策）】']
  if (h.last_7d.length)  { lines.push('<last_7d>');   lines.push(...h.last_7d.slice(0, 5).map(fmt));  lines.push('</last_7d>') }
  if (h.last_30d.length) { lines.push('<days_8_30>'); lines.push(...h.last_30d.slice(0, 5).map(fmt)); lines.push('</days_8_30>') }
  if (h.last_90d.length) { lines.push('<days_31_90>'); lines.push(...h.last_90d.slice(0, 3).map(fmt)); lines.push('</days_31_90>') }
  return lines.join('\n')
}

/**
 * Map debate verdict + conviction to direction label for storage.
 * APPROVE+high conv → bullish; REJECT → bearish; others → neutral.
 */
export function verdictToDirection(verdict: string, conviction: number): DebateDirection {
  if (verdict === 'REJECT') return 'bearish'
  if (verdict === 'APPROVE' && conviction >= 60) return 'bullish'
  return 'neutral'
}
