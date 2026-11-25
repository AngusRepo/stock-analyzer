// The hedge composite is built server-side (GET /market/risk hedgeSentiment); the UI never substitutes the
// market risk score or a VIX overlay for a missing hedge score.
export function hedgeSentimentView(risk: any): { score: number | null; label: string } {
  const raw = risk?.hedgeSentiment?.score
  const parsed = raw == null || raw === '' ? null : Number(raw)
  const score = parsed != null && Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : null
  const label = risk?.hedgeSentiment?.label
  return { score, label: score == null || typeof label !== 'string' || !label ? '待接資料' : label }
}
