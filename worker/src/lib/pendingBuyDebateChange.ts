import type { PendingBuy } from './pendingBuyStore'

/** Intraday read enrichments are events, not new debate or selection revisions. */
export function hasPendingBuyDebateChanges(before: PendingBuy[], after: PendingBuy[]): boolean {
  const content = (items: PendingBuy[]) => JSON.stringify([...items]
    .sort((a, b) => a.symbol.localeCompare(b.symbol)).map(item => ({
      symbol: item.symbol, verdict: item.debate_verdict ?? 'PENDING',
      status: item.debate_status ?? 'pending', risk: item.risk_pct,
      turns: (item.debate_turns ?? []).map(turn => ({ agent: turn.agent, round: turn.round ?? null,
        stance: turn.stance ?? null, summary: turn.summary, source: turn.source ?? null })),
      retries: [...new Set((item.watch_points ?? []).filter(point => point.includes(':debate_retry:')))].sort(),
    })))
  return content(before) !== content(after)
}
