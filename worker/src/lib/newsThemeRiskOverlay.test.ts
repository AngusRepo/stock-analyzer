import { classifyExternalEvidenceRisk, loadExternalEvidenceRiskOverlays } from './newsThemeRiskOverlay'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

{
  const risk = classifyExternalEvidenceRisk({
    source_id: 'official_rss',
    source_kind: 'material_event',
    title: '重大負面事件導致停牌調查',
    decision_effect: 'major_negative_veto',
    source_quality_score: 0.95,
    entity_linking_confidence: 0.9,
  })
  assert(risk?.action === 'veto', 'high-confidence official major negative evidence should veto')
  assert(risk?.flags.includes('major_negative_official_event'), 'official veto should expose risk flag')
}

{
  const risk = classifyExternalEvidenceRisk({
    source_id: 'anue',
    source_kind: 'rumor',
    title: '市場傳聞',
    decision_effect: 'risk_context_only',
    source_quality_score: 0.4,
    entity_linking_confidence: 0.4,
  })
  assert(risk == null, 'low-confidence non-official evidence must not penalize')
}

async function main(): Promise<void> {
  const calls: { sql?: string; params?: unknown[] } = {}
  const db = {
    prepare(sql: string) {
      calls.sql = sql
      return {
        bind(...params: unknown[]) {
          calls.params = params
          return {
            async all<T>() {
              return {
                results: [{
                  source_id: 'company_ir_rss',
                  source_kind: 'material_event',
                  title: '財報重編重大訊息',
                  published_at: '2026-05-23',
                  symbols_json: JSON.stringify(['2330']),
                  allowed_use: 'risk_overlay',
                  decision_effect: 'major_negative_veto',
                  source_quality_score: 0.95,
                  entity_linking_confidence: 0.9,
                }] as T[],
              }
            },
          }
        },
      }
    },
  } as unknown as D1Database

  const overlays = await loadExternalEvidenceRiskOverlays(db, '2026-05-24', ['2330'])

  assert(calls.sql?.includes("date(published_at) >= date(?, '-10 days')"), 'external evidence risk overlay must use a freshness window')
  assert(JSON.stringify(calls.params) === JSON.stringify(['2026-05-24', '2026-05-24', '%"2330"%']), 'risk overlay query should bind date window and symbol predicate')
  assert(overlays.get('2330')?.action === 'veto', 'symbol overlay should keep official veto')
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
