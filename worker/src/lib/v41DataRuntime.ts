export interface ThemeSignalRow {
  date: string
  concept: string
  source: string
  score: number
  sentiment_avg?: number | null
  evidence_count?: number | null
  symbols_json?: string | null
  top_titles?: string | null
  allowed_use?: string | null
  decision_effect?: string | null
  generated_at: string
}

export interface StockConceptTagRow {
  symbol: string
  tag: string
  weight?: number | null
}

export interface FinLabTaxonomyTagRow extends StockConceptTagRow {
  tag_type?: string | null
  source?: string | null
}

export interface StockThemeFeatureRow {
  date: string
  symbol: string
  concept: string
  score: number
  evidence_count: number
  source_breakdown_json: string
  top_titles: string
  generated_at: string
}

export interface SourceQualityMetricRow {
  source: string
  dataset?: string | null
  freshness_status?: string | null
  missing_rate?: number | null
  duplicate_rate?: number | null
  schema_drift_status?: string | null
  entity_link_confidence?: number | null
  latest_materialization?: string | null
}

export interface SourceCoverageInputRow {
  source: string
  rows?: number | null
  latest_generated_at?: string | null
  latest_published_at?: string | null
  entity_link_confidence?: number | null
}

export interface SourceCoverageRow {
  source: string
  role: string
  rows: number
  freshness_status: string
  missing_rate: number
  duplicate_rate: number
  entity_link_confidence: number | null
  latest_materialization: string | null
  decision_effect: string
  runtime_state: 'production' | 'paper_active' | 'formal_shadow' | 'missing'
}

const V41_SOURCE_COVERAGE_ROLES: Record<string, Omit<SourceCoverageRow, 'rows' | 'freshness_status' | 'missing_rate' | 'duplicate_rate' | 'entity_link_confidence' | 'latest_materialization'>> = {
  ptt: { source: 'ptt', role: 'retail_heat', decision_effect: 'theme_context', runtime_state: 'production' },
  anue: { source: 'anue', role: 'tw_news_heat', decision_effect: 'theme_context', runtime_state: 'production' },
  d1_news: { source: 'd1_news', role: 'stock_news', decision_effect: 'theme_context', runtime_state: 'production' },
  finlab: { source: 'finlab', role: 'structured_primary', decision_effect: 'canonical_data_and_taxonomy', runtime_state: 'production' },
  finnhub_news: { source: 'finnhub_news', role: 'global_company_news', decision_effect: 'context_feature_candidate', runtime_state: 'production' },
  official_rss: { source: 'official_rss', role: 'authoritative_official', decision_effect: 'fact_support_manual_review', runtime_state: 'production' },
  company_ir_rss: { source: 'company_ir_rss', role: 'company_first_party', decision_effect: 'fact_support_manual_review', runtime_state: 'production' },
  gdelt_events: { source: 'gdelt_events', role: 'global_event_pressure', decision_effect: 'risk_context_only', runtime_state: 'formal_shadow' },
}

export const V41_SOURCE_COVERAGE_ORDER = Object.keys(V41_SOURCE_COVERAGE_ROLES)

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

function normalizeSourceId(source: unknown): string {
  const raw = String(source ?? '').trim()
  if (!raw) return 'unknown'
  if (raw === 'finlab_taxonomy' || raw.startsWith('finlab.')) return 'finlab'
  if (raw === 'finnhub') return 'finnhub_news'
  if (raw === 'official') return 'official_rss'
  if (raw === 'company_ir') return 'company_ir_rss'
  if (raw === 'gdelt') return 'gdelt_events'
  return raw
}

function num(value: unknown, fallback = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function buildV41SourceCoverageRows(input: {
  qualityRows?: SourceQualityMetricRow[]
  themeRows?: SourceCoverageInputRow[]
  evidenceRows?: SourceCoverageInputRow[]
}): SourceCoverageRow[] {
  const qualityBySource = new Map<string, SourceQualityMetricRow>()
  for (const row of input.qualityRows ?? []) {
    const source = normalizeSourceId(row.source)
    const existing = qualityBySource.get(source)
    if (!existing || String(row.latest_materialization ?? '') > String(existing.latest_materialization ?? '')) {
      qualityBySource.set(source, row)
    }
  }

  const countBySource = new Map<string, { rows: number; latest: string | null; confidence: number | null }>()
  const absorb = (row: SourceCoverageInputRow) => {
    const source = normalizeSourceId(row.source)
    const existing = countBySource.get(source) ?? { rows: 0, latest: null, confidence: null }
    const latest = row.latest_generated_at ?? row.latest_published_at ?? null
    const confidence = row.entity_link_confidence == null ? existing.confidence : Math.max(num(row.entity_link_confidence), existing.confidence ?? 0)
    countBySource.set(source, {
      rows: existing.rows + Math.max(0, Math.trunc(num(row.rows))),
      latest: latest && (!existing.latest || latest > existing.latest) ? latest : existing.latest,
      confidence,
    })
  }
  for (const row of input.themeRows ?? []) absorb(row)
  for (const row of input.evidenceRows ?? []) absorb(row)

  return V41_SOURCE_COVERAGE_ORDER.map((source) => {
    const role = V41_SOURCE_COVERAGE_ROLES[source]
    const quality = qualityBySource.get(source)
    const counts = countBySource.get(source)
    const rows = counts?.rows ?? 0
    const latest = counts?.latest ?? quality?.latest_materialization ?? null
    const missingRate = rows > 0 ? num(quality?.missing_rate, 0) : 1
    return {
      ...role,
      rows,
      freshness_status: quality?.freshness_status ?? (rows > 0 ? 'present' : 'missing'),
      missing_rate: missingRate,
      duplicate_rate: num(quality?.duplicate_rate, 0),
      entity_link_confidence: counts?.confidence ?? (quality?.entity_link_confidence == null ? null : num(quality.entity_link_confidence)),
      latest_materialization: latest,
      runtime_state: rows > 0 ? role.runtime_state : 'missing',
    }
  })
}

export function buildFinLabTaxonomyThemeSignals(
  tags: FinLabTaxonomyTagRow[],
  date: string,
  generatedAt: string,
): ThemeSignalRow[] {
  const buckets = new Map<string, {
    score: number
    symbols: Set<string>
    tagTypes: Set<string>
  }>()

  for (const tag of tags) {
    const symbol = String(tag.symbol || '').trim()
    const concept = String(tag.tag || '').trim()
    if (!symbol || !concept) continue
    const bucket = buckets.get(concept) ?? { score: 0, symbols: new Set<string>(), tagTypes: new Set<string>() }
    bucket.score += Number(tag.weight ?? 1) || 1
    bucket.symbols.add(symbol)
    if (tag.tag_type) bucket.tagTypes.add(String(tag.tag_type))
    buckets.set(concept, bucket)
  }

  return [...buckets.entries()].map(([concept, bucket]) => {
    const symbols = [...bucket.symbols].sort()
    const tagTypes = [...bucket.tagTypes].sort()
    return {
      date,
      concept,
      source: 'finlab_taxonomy',
      score: Number(Math.min(5, bucket.score / Math.max(1, symbols.length)).toFixed(6)),
      sentiment_avg: 0,
      evidence_count: symbols.length,
      symbols_json: JSON.stringify(symbols),
      top_titles: JSON.stringify([`finlab_taxonomy:${tagTypes.join('+') || 'tag'}:${symbols.length} symbols`]),
      allowed_use: 'taxonomy_context',
      decision_effect: 'context_only',
      generated_at: generatedAt,
    }
  })
}

export function buildStockThemeFeatureRows(
  signals: ThemeSignalRow[],
  stockTags: StockConceptTagRow[],
): StockThemeFeatureRow[] {
  const signalsByConcept = new Map<string, ThemeSignalRow[]>()
  for (const signal of signals) {
    const concept = String(signal.concept || '').trim()
    if (!concept) continue
    const bucket = signalsByConcept.get(concept) ?? []
    bucket.push(signal)
    signalsByConcept.set(concept, bucket)
  }

  const features = new Map<string, StockThemeFeatureRow>()
  for (const tag of stockTags) {
    const symbol = String(tag.symbol || '').trim()
    const concept = String(tag.tag || '').trim()
    if (!symbol || !concept) continue
    const matchingSignals = signalsByConcept.get(concept) ?? []
    for (const signal of matchingSignals) {
      const key = `${signal.date}|${symbol}|${concept}`
      const weight = Number(tag.weight ?? 1)
      const source = String(signal.source || 'unknown')
      const existing = features.get(key)
      const contribution = Number(signal.score || 0) * (Number.isFinite(weight) ? weight : 1)
      const evidenceCount = Math.max(1, Number(signal.evidence_count ?? 1))
      const titles = parseJsonArray(signal.top_titles)
      if (existing) {
        const breakdown = JSON.parse(existing.source_breakdown_json || '{}') as Record<string, number>
        breakdown[source] = Number((breakdown[source] ?? 0) + contribution)
        const mergedTitles = [...parseJsonArray(existing.top_titles), ...titles].slice(0, 5)
        features.set(key, {
          ...existing,
          score: Number((existing.score + contribution).toFixed(6)),
          evidence_count: existing.evidence_count + evidenceCount,
          source_breakdown_json: JSON.stringify(breakdown),
          top_titles: JSON.stringify(mergedTitles),
        })
      } else {
        features.set(key, {
          date: signal.date,
          symbol,
          concept,
          score: Number(contribution.toFixed(6)),
          evidence_count: evidenceCount,
          source_breakdown_json: JSON.stringify({ [source]: contribution }),
          top_titles: JSON.stringify(titles.slice(0, 5)),
          generated_at: signal.generated_at,
        })
      }
    }
  }
  return [...features.values()].sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
}

export async function upsertThemeSignals(db: D1Database, rows: ThemeSignalRow[]): Promise<number> {
  if (!rows.length) return 0
  const statements = rows.map(row => db.prepare(`
    INSERT INTO theme_signals (
      date, concept, source, score, sentiment_avg, evidence_count, symbols_json,
      top_titles, allowed_use, decision_effect, generated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, concept, source) DO UPDATE SET
      score=excluded.score,
      sentiment_avg=excluded.sentiment_avg,
      evidence_count=excluded.evidence_count,
      symbols_json=excluded.symbols_json,
      top_titles=excluded.top_titles,
      allowed_use=excluded.allowed_use,
      decision_effect=excluded.decision_effect,
      generated_at=excluded.generated_at
  `).bind(
    row.date,
    row.concept,
    row.source,
    row.score,
    row.sentiment_avg ?? 0,
    row.evidence_count ?? 1,
    row.symbols_json ?? '[]',
    row.top_titles ?? '[]',
    row.allowed_use ?? null,
    row.decision_effect ?? null,
    row.generated_at,
  ))
  await db.batch(statements)
  return rows.length
}

export async function upsertStockThemeFeatures(db: D1Database, rows: StockThemeFeatureRow[]): Promise<number> {
  if (!rows.length) return 0
  const statements = rows.map(row => db.prepare(`
    INSERT INTO stock_theme_features (
      date, symbol, concept, score, evidence_count, source_breakdown_json,
      top_titles, generated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, symbol, concept) DO UPDATE SET
      score=excluded.score,
      evidence_count=excluded.evidence_count,
      source_breakdown_json=excluded.source_breakdown_json,
      top_titles=excluded.top_titles,
      generated_at=excluded.generated_at
  `).bind(
    row.date,
    row.symbol,
    row.concept,
    row.score,
    row.evidence_count,
    row.source_breakdown_json,
    row.top_titles,
    row.generated_at,
  ))
  await db.batch(statements)
  return rows.length
}

export async function refreshStockThemeFeaturesFromSignals(db: D1Database, date: string): Promise<{ signals: number; tags: number; features: number }> {
  const signalsResult = await db.prepare(`
      SELECT date, concept, source, score, sentiment_avg, evidence_count, symbols_json,
             top_titles, allowed_use, decision_effect, generated_at
      FROM theme_signals
      WHERE date = ?
    `).bind(date).all<ThemeSignalRow>()
  const signals = signalsResult.results ?? []
  let tags: StockConceptTagRow[] = []
  try {
    const tagsResult = await db.prepare(`
      SELECT symbol, tag, weight
        FROM stock_tags
       WHERE tag_type = 'concept'
      UNION ALL
      SELECT symbol, tag, weight
        FROM finlab_taxonomy_tags
       WHERE tag_type IN ('industry', 'industry_theme', 'subindustry', 'concept')
    `).all<StockConceptTagRow>()
    tags = tagsResult.results ?? []
  } catch {
    const tagsResult = await db.prepare(`
      SELECT symbol, tag, weight
      FROM stock_tags
      WHERE tag_type = 'concept'
    `).all<StockConceptTagRow>()
    tags = tagsResult.results ?? []
  }
  const features = buildStockThemeFeatureRows(signals, tags)
  await upsertStockThemeFeatures(db, features)
  return { signals: signals.length, tags: tags.length, features: features.length }
}

export async function readV41DataRuntimeStatus(db: D1Database, date: string) {
  const [theme, stockTheme, evidence, backfill, diff, quality, themeSources, evidenceSources, gapFill, canonical] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT source) AS sources, MAX(generated_at) AS latest_generated_at
      FROM theme_signals
      WHERE date = ?
    `).bind(date).first<any>().catch(() => ({})),
    db.prepare(`
      SELECT COUNT(*) AS total, COUNT(DISTINCT symbol) AS symbols, MAX(generated_at) AS latest_generated_at
      FROM stock_theme_features
      WHERE date = ?
    `).bind(date).first<any>().catch(() => ({})),
    db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted,
             SUM(CASE WHEN accepted = 0 THEN 1 ELSE 0 END) AS rejected,
             MAX(published_at) AS latest_published_at
      FROM external_evidence_items
    `).first<any>().catch(() => ({})),
    db.prepare(`
      SELECT run_id, generated_at, lookback_years, dataset_count, finlab_rows,
             gap_fill_rows, value_conflicts, status
      FROM finlab_backfill_runs
      ORDER BY generated_at DESC
      LIMIT 1
    `).first<any>().catch(() => null),
    db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(missing_in_stockvision) AS missing_in_stockvision,
             SUM(value_conflicts) AS value_conflicts,
             MAX(generated_at) AS latest_generated_at
      FROM source_diff_report
    `).first<any>().catch(() => ({})),
    db.prepare(`
      SELECT source, dataset, freshness_status, missing_rate, duplicate_rate,
             schema_drift_status, entity_link_confidence, latest_materialization
      FROM source_quality_metrics
      ORDER BY as_of_date DESC, source, dataset
      LIMIT 50
    `).all<any>().catch(() => ({ results: [] })),
    db.prepare(`
      SELECT source,
             COUNT(*) AS rows,
             MAX(generated_at) AS latest_generated_at
      FROM theme_signals
      WHERE date = ?
      GROUP BY source
    `).bind(date).all<any>().catch(() => ({ results: [] })),
    db.prepare(`
      SELECT source_id AS source,
             COUNT(*) AS rows,
             MAX(published_at) AS latest_published_at,
             AVG(entity_linking_confidence) AS entity_link_confidence
      FROM external_evidence_items
      WHERE accepted = 1
      GROUP BY source_id
    `).all<any>().catch(() => ({ results: [] })),
    db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN decision = 'candidate' THEN 1 ELSE 0 END) AS candidates,
             SUM(CASE WHEN decision = 'quarantine' THEN 1 ELSE 0 END) AS quarantined,
             MAX(generated_at) AS latest_generated_at
      FROM gap_fill_candidates
    `).first<any>().catch(() => ({})),
    db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM canonical_market_daily) AS market_daily_rows,
        (SELECT COUNT(*) FROM canonical_chip_daily) AS chip_daily_rows,
        (SELECT COUNT(*) FROM canonical_revenue_monthly) AS revenue_monthly_rows
    `).first<any>().catch(() => ({})),
  ])

  return {
    date,
    schema_version: 'v4-1-data-runtime-status-v1',
    theme_signals: {
      total: Number(theme?.total ?? 0),
      sources: Number(theme?.sources ?? 0),
      latest_generated_at: theme?.latest_generated_at ?? null,
    },
    stock_theme_features: {
      total: Number(stockTheme?.total ?? 0),
      symbols: Number(stockTheme?.symbols ?? 0),
      latest_generated_at: stockTheme?.latest_generated_at ?? null,
    },
    external_evidence: {
      total: Number(evidence?.total ?? 0),
      accepted: Number(evidence?.accepted ?? 0),
      rejected: Number(evidence?.rejected ?? 0),
      latest_published_at: evidence?.latest_published_at ?? null,
    },
    finlab_backfill: backfill ?? null,
    source_diff: {
      total: Number(diff?.total ?? 0),
      missing_in_stockvision: Number(diff?.missing_in_stockvision ?? 0),
      value_conflicts: Number(diff?.value_conflicts ?? 0),
      latest_generated_at: diff?.latest_generated_at ?? null,
    },
    gap_fill_candidates: {
      total: Number(gapFill?.total ?? 0),
      candidates: Number(gapFill?.candidates ?? 0),
      quarantined: Number(gapFill?.quarantined ?? 0),
      latest_generated_at: gapFill?.latest_generated_at ?? null,
    },
    canonical_rows: {
      market_daily: Number(canonical?.market_daily_rows ?? 0),
      chip_daily: Number(canonical?.chip_daily_rows ?? 0),
      revenue_monthly: Number(canonical?.revenue_monthly_rows ?? 0),
    },
    source_quality_metrics: (quality?.results ?? []).map((row: any) => ({
      source: row.source,
      dataset: row.dataset,
      freshness_status: row.freshness_status,
      missing_rate: Number(row.missing_rate ?? 0),
      duplicate_rate: Number(row.duplicate_rate ?? 0),
      schema_drift_status: row.schema_drift_status,
      entity_link_confidence: row.entity_link_confidence == null ? null : Number(row.entity_link_confidence),
      latest_materialization: row.latest_materialization ?? null,
    })),
    source_coverage: buildV41SourceCoverageRows({
      qualityRows: quality?.results ?? [],
      themeRows: themeSources?.results ?? [],
      evidenceRows: evidenceSources?.results ?? [],
    }),
  }
}
