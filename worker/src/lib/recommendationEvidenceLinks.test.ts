import {
  isFallbackNewsRelevant,
  isRecommendationEvidenceRowSpecific,
} from './recommendationEvidenceLinks'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

assert(
  !isFallbackNewsRelevant(
    {
      symbol: '6525',
      name: 'TW Stock',
      source: 'TheStreet',
      title: 'Tips for choosing the right hybrid mattress come Memorial Day',
      url: 'https://finance.yahoo.com/m/b33f9ac8/tips-for-choosing-the-right.html',
      published_at: '2026-05-19T00:30:00.000Z',
      summary: '',
    },
    { symbol: '6525', name: 'TW Stock' },
  ),
  'generic Yahoo/global news must not be attached to TW recommendation cards',
)

assert(
  isFallbackNewsRelevant(
    {
      symbol: '2330',
      name: 'TSMC',
      source: 'Cnyes',
      title: 'TSMC revenue growth and AI demand update 2330',
      url: 'https://news.cnyes.com/news/id/stock-2330',
      published_at: '2026-05-18T08:00:00.000Z',
      summary: '',
    },
    { symbol: '2330', name: 'TSMC' },
  ),
  'stock-specific Cnyes/Anue evidence should remain eligible for card links',
)

assert(
  !isRecommendationEvidenceRowSpecific(
    {
      source_id: 'gdelt_events',
      source_kind: 'global_event_graph_status',
      title: 'GDELT formal shadow status: fetch_failed',
      source_url: 'https://api.gdeltproject.org/api/v2/doc/doc',
      published_at: '2026-05-18',
      symbols_json: '["2330"]',
      decision_effect: 'risk_context_only',
      source_quality_score: 0.05,
      entity_linking_confidence: 0.05,
    },
    '2330',
  ),
  'GDELT status/risk-context rows must stay off individual recommendation cards',
)

assert(
  isRecommendationEvidenceRowSpecific(
    {
      source_id: 'official_rss',
      source_kind: 'twse_disposition',
      title: 'TWSE official twse_disposition: 6449',
      source_url: 'https://www.twse.com.tw/rwd/zh/announcement/punish?response=json#stockNo=6449',
      published_at: '2026-05-18',
      symbols_json: '["6449"]',
      decision_effect: 'authoritative_evidence',
      source_quality_score: 0.95,
      entity_linking_confidence: 0.96,
    },
    '6449',
  ),
  'exact official evidence should stay attached to the matching symbol',
)
