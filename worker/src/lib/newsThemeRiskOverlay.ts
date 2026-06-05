export type ExternalEvidenceRiskAction = 'none' | 'penalize' | 'veto'

export interface ExternalEvidenceRiskRow {
  source_id?: string | null
  source_kind?: string | null
  title?: string | null
  published_at?: string | null
  symbols_json?: string | null
  allowed_use?: string | null
  decision_effect?: string | null
  source_quality_score?: number | null
  entity_linking_confidence?: number | null
}

export interface SymbolExternalEvidenceRiskOverlay {
  symbol: string
  action: ExternalEvidenceRiskAction
  penalty: number
  flags: string[]
  evidence: Array<{
    source: string
    title: string
    published_at: string
    decision_effect: string
  }>
}

function lower(value: unknown): string {
  return String(value ?? '').toLowerCase()
}

function cleanSymbol(value: unknown): string {
  const text = String(value ?? '').trim()
  const match = text.match(/\b(\d{4,6})\b/)
  return match?.[1] ?? text
}

function parseSymbols(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(cleanSymbol).filter(Boolean)
  if (typeof raw !== 'string' || !raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(cleanSymbol).filter(Boolean) : []
  } catch {
    return []
  }
}

function quality(row: ExternalEvidenceRiskRow): number {
  const q = Number(row.source_quality_score ?? 0)
  const c = Number(row.entity_linking_confidence ?? 0)
  return Math.min(Number.isFinite(q) ? q : 0, Number.isFinite(c) ? c : 0)
}

export function classifyExternalEvidenceRisk(row: ExternalEvidenceRiskRow): Omit<SymbolExternalEvidenceRiskOverlay, 'symbol' | 'evidence'> | null {
  const source = lower(row.source_id)
  const haystack = `${row.source_kind ?? ''} ${row.allowed_use ?? ''} ${row.decision_effect ?? ''} ${row.title ?? ''}`.toLowerCase()
  const official = source === 'official_rss' || source === 'company_ir_rss'
  const highConfidence = quality(row)
  const severe = /veto|block|major_negative|material_negative|trading_halt|delisting|fraud|default|bankruptcy|restatement|sanction|下市|停牌|違約|倒閉|財報重編|掏空|裁罰/.test(haystack)
  const risk = /risk|negative|downgrade|lawsuit|investigation|warning|風險|負面|調查|訴訟|降評/.test(haystack)
  if (official && severe && highConfidence >= 0.6) {
    return { action: 'veto', penalty: -100, flags: ['major_negative_official_event'] }
  }
  if (official && risk && highConfidence >= 0.55) {
    return { action: 'penalize', penalty: -8, flags: ['official_negative_risk'] }
  }
  if (!official && severe && highConfidence >= 0.8) {
    return { action: 'penalize', penalty: -5, flags: ['high_confidence_negative_event'] }
  }
  return null
}

function mergeOverlay(
  map: Map<string, SymbolExternalEvidenceRiskOverlay>,
  symbol: string,
  row: ExternalEvidenceRiskRow,
  risk: Omit<SymbolExternalEvidenceRiskOverlay, 'symbol' | 'evidence'>,
): void {
  const prev = map.get(symbol)
  const evidence = {
    source: String(row.source_id || 'external_evidence'),
    title: String(row.title || '').slice(0, 160),
    published_at: String(row.published_at || ''),
    decision_effect: String(row.decision_effect || ''),
  }
  if (!prev) {
    map.set(symbol, { symbol, ...risk, evidence: [evidence] })
    return
  }
  const action = prev.action === 'veto' || risk.action === 'veto' ? 'veto' : 'penalize'
  map.set(symbol, {
    symbol,
    action,
    penalty: action === 'veto' ? -100 : Math.min(prev.penalty, risk.penalty),
    flags: [...new Set([...prev.flags, ...risk.flags])],
    evidence: [...prev.evidence, evidence].slice(0, 3),
  })
}

export async function loadExternalEvidenceRiskOverlays(
  db: D1Database,
  date: string,
  symbols: string[],
): Promise<Map<string, SymbolExternalEvidenceRiskOverlay>> {
  const overlays = new Map<string, SymbolExternalEvidenceRiskOverlay>()
  const uniqueSymbols = [...new Set(symbols.map(cleanSymbol).filter(Boolean))]
  if (!uniqueSymbols.length) return overlays

  try {
    for (let i = 0; i < uniqueSymbols.length; i += 40) {
      const chunk = uniqueSymbols.slice(i, i + 40)
      const symbolPredicates = chunk.map(() => 'symbols_json LIKE ?').join(' OR ')
      const params = [
        date,
        date,
        ...chunk.map(symbol => `%"${symbol}"%`),
      ]
      const { results } = await db.prepare(`
        SELECT source_id, source_kind, title, published_at, symbols_json,
               allowed_use, decision_effect, source_quality_score, entity_linking_confidence
          FROM external_evidence_items
         WHERE accepted = 1
           AND date(published_at) >= date(?, '-10 days')
           AND date(published_at) <= date(?)
           AND (${symbolPredicates})
         ORDER BY source_quality_score DESC, entity_linking_confidence DESC, published_at DESC
         LIMIT 240
      `).bind(...params).all<ExternalEvidenceRiskRow>()

      for (const row of results ?? []) {
        const risk = classifyExternalEvidenceRisk(row)
        if (!risk) continue
        for (const symbol of parseSymbols(row.symbols_json)) {
          if (!chunk.includes(symbol)) continue
          mergeOverlay(overlays, symbol, row, risk)
        }
      }
    }
  } catch {
    return overlays
  }

  return overlays
}
