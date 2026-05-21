export interface MarketRegimeFactorTile {
  id: string
  label: string
  value: string
  raw_value: number | string | null
  score: number
  weight: number
  contribution: number
  status: 'ok' | 'warn' | 'error' | 'info' | 'missing'
  source: string
  source_date: string | null
  detail: string
  missing_reason?: string
  evidence_title?: string | null
  evidence_url?: string | null
}

export interface MarketRegimeFactorPacket {
  schema_version: 'market-regime-factor-packet-v1'
  date: string
  score: number
  level: 'green' | 'yellow' | 'orange' | 'red' | 'black'
  factors: MarketRegimeFactorTile[]
  contributions: Record<string, number>
  sources: Record<string, string>
  freshness: Record<string, string | null>
  missing_reasons: Record<string, string>
  lineage: Record<string, unknown>
  generated_at: string
}

function finiteNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value))
}

function riskLevel(score: number): MarketRegimeFactorPacket['level'] {
  if (score <= 25) return 'green'
  if (score <= 45) return 'yellow'
  if (score <= 65) return 'orange'
  if (score <= 85) return 'red'
  return 'black'
}

function formatBillion(value: number | null): string {
  if (value == null) return 'n/a'
  return `${value.toFixed(1)}億`
}

function factor(input: Omit<MarketRegimeFactorTile, 'contribution'>): MarketRegimeFactorTile {
  return {
    ...input,
    contribution: Math.round(input.score * input.weight * 10) / 10,
  }
}

async function canonicalInstitutionalNet5d(db: D1Database, date: string): Promise<{ value: number | null; sourceDate: string | null }> {
  try {
    const rows = await db.prepare(`
      WITH dates AS (
        SELECT DISTINCT date
          FROM canonical_chip_daily
         WHERE date <= ?
         ORDER BY date DESC
         LIMIT 5
      )
      SELECT c.date,
             COUNT(m.close) AS priced_rows,
             SUM(
               CASE
                 WHEN m.close IS NOT NULL
                 THEN (COALESCE(c.foreign_net,0) + COALESCE(c.trust_net,0) + COALESCE(c.dealer_net,0)) * m.close
                 ELSE NULL
               END
             ) / 100000000.0 AS net_billion
        FROM canonical_chip_daily c
        LEFT JOIN canonical_market_daily m
          ON m.stock_id = c.stock_id
         AND m.date = c.date
         AND m.source LIKE 'finlab.%'
       WHERE c.date IN (SELECT date FROM dates)
       GROUP BY c.date
       ORDER BY c.date DESC
    `).bind(date).all<{ date: string; priced_rows: number | null; net_billion: number | null }>()
    const list = rows.results ?? []
    if (!list.length) return { value: null, sourceDate: null }
    const priced = list.filter((row) => Number(row.priced_rows ?? 0) > 0 && row.net_billion != null)
    if (!priced.length) return { value: null, sourceDate: list[0]?.date ?? null }
    const total = priced.reduce((sum, row) => sum + Number(row.net_billion ?? 0), 0)
    return {
      value: Math.round(total * 10) / 10,
      sourceDate: priced[0]?.date ?? list[0]?.date ?? null,
    }
  } catch {
    return { value: null, sourceDate: null }
  }
}

async function canonicalLeverageStress(db: D1Database, date: string): Promise<{ value: number | null; sourceDate: string | null; detail: string }> {
  try {
    const rows = await db.prepare(`
      WITH dates AS (
        SELECT DISTINCT date
          FROM canonical_chip_daily
         WHERE date <= ?
         ORDER BY date DESC
         LIMIT 6
      ),
      daily AS (
        SELECT c.date,
               COUNT(m.close) AS priced_rows,
               SUM(CASE WHEN m.close IS NOT NULL THEN COALESCE(c.margin_balance,0) * m.close ELSE NULL END) / 100000000.0 AS margin_billion,
               SUM(CASE WHEN m.close IS NOT NULL THEN COALESCE(c.short_balance,0) * m.close ELSE NULL END) / 100000000.0 AS short_billion
          FROM canonical_chip_daily c
          LEFT JOIN canonical_market_daily m
            ON m.stock_id = c.stock_id
           AND m.date = c.date
           AND m.source LIKE 'finlab.%'
         WHERE c.date IN (SELECT date FROM dates)
         GROUP BY c.date
         ORDER BY c.date ASC
      )
      SELECT * FROM daily
    `).bind(date).all<{ date: string; priced_rows: number | null; margin_billion: number | null; short_billion: number | null }>()
    const list = (rows.results ?? []).filter((row) => Number(row.priced_rows ?? 0) > 0)
    if (list.length < 2) return { value: null, sourceDate: list.length ? list[list.length - 1]?.date ?? null : null, detail: 'not enough canonical leverage rows' }
    const latest = list[list.length - 1]
    const prev = list[0]
    const latestMargin = Number(latest.margin_billion ?? 0)
    const prevMargin = Number(prev.margin_billion ?? 0)
    const change = prevMargin > 0 ? (latestMargin / prevMargin - 1) * 100 : null
    return {
      value: change == null ? null : Math.round(change * 100) / 100,
      sourceDate: latest.date,
      detail: `margin=${formatBillion(latestMargin)} short=${formatBillion(Number(latest.short_billion ?? 0))}`,
    }
  } catch {
    return { value: null, sourceDate: null, detail: 'canonical leverage query failed' }
  }
}

function parseMetrics(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {}
  } catch {
    return {}
  }
}

function scoreBusinessSignal(points: number | null): number {
  if (points == null) return 45
  if (points >= 38) return 12
  if (points >= 32) return 22
  if (points >= 23) return 40
  if (points >= 17) return 62
  return 82
}

function labelBusinessSignal(points: number | null): string {
  if (points == null) return '缺資料'
  if (points >= 38) return `紅燈 ${points.toFixed(0)}`
  if (points >= 32) return `黃紅燈 ${points.toFixed(0)}`
  if (points >= 23) return `綠燈 ${points.toFixed(0)}`
  if (points >= 17) return `黃藍燈 ${points.toFixed(0)}`
  return `藍燈 ${points.toFixed(0)}`
}

async function twBusinessSignalContext(db: D1Database, date: string): Promise<{
  value: number | null
  sourceDate: string | null
  status: MarketRegimeFactorTile['status']
  detail: string
  source: string
  missingReason?: string
}> {
  try {
    const rows = await db.prepare(`
      SELECT dataset, latest_materialization, freshness_status, metrics_json
        FROM source_quality_metrics
       WHERE source = 'finlab'
         AND dataset IN ('tw_business_indicators', 'tw_business_indicators_details')
       ORDER BY as_of_date DESC, latest_materialization DESC
       LIMIT 4
    `).all<{
      dataset: string
      latest_materialization: string | null
      freshness_status: string
      metrics_json: string | null
    }>()
    const list = rows.results ?? []
    if (!list.length) {
      return {
        value: null,
        sourceDate: null,
        status: 'missing',
        detail: 'FinLab tw_business_indicators 尚未 materialize 到 D1',
        source: 'finlab.tw_business_indicators',
        missingReason: 'tw_business_indicators_not_materialized',
      }
    }
    const metrics = list.map((row) => parseMetrics(row.metrics_json))
    const scoreCandidates = metrics
      .flatMap((item) => [
        item.latest_signal_score,
        item.latest_score,
        item['景氣對策信號(分)'],
        item.business_signal_score,
      ])
      .map(finiteNumber)
      .filter((value): value is number => value != null)
    const value = scoreCandidates[0] ?? null
    const stale = list.some((row) => /stale|failed|degraded/i.test(`${row.freshness_status} ${row.metrics_json ?? ''}`))
    return {
      value,
      sourceDate: list[0]?.latest_materialization ? String(list[0].latest_materialization).slice(0, 10) : date,
      status: value == null ? 'missing' : stale ? 'warn' : scoreBusinessSignal(value) >= 60 ? 'warn' : 'ok',
      detail: value == null
        ? `${list.map((row) => `${row.dataset}:${row.freshness_status}`).join(' / ')}；缺 latest_signal_score`
        : `景氣對策信號=${value.toFixed(0)}；${list.map((row) => `${row.dataset}:${row.freshness_status}`).join(' / ')}`,
      source: 'finlab.tw_business_indicators',
      missingReason: value == null ? 'tw_business_signal_score_missing' : undefined,
    }
  } catch {
    return {
      value: null,
      sourceDate: null,
      status: 'missing',
      detail: 'tw_business_indicators query failed',
      source: 'finlab.tw_business_indicators',
      missingReason: 'tw_business_indicators_query_failed',
    }
  }
}

async function sourceQualityContext(
  db: D1Database,
  date: string,
  source: string,
  datasets: string[],
): Promise<{ score: number | null; sourceDate: string | null; status: MarketRegimeFactorTile['status']; detail: string; source: string }> {
  if (!datasets.length) return { score: null, sourceDate: null, status: 'missing', detail: 'no dataset configured', source }
  const placeholders = datasets.map(() => '?').join(',')
  try {
    const rows = await db.prepare(`
      SELECT source, dataset, freshness_status, missing_rate, latest_materialization, metrics_json
        FROM source_quality_metrics
       WHERE as_of_date = ?
         AND source = ?
         AND dataset IN (${placeholders})
       ORDER BY latest_materialization DESC
    `).bind(date, source, ...datasets).all<{
      source: string
      dataset: string
      freshness_status: string
      missing_rate: number | null
      latest_materialization: string | null
      metrics_json: string | null
    }>()
    const list = rows.results ?? []
    if (!list.length) return { score: null, sourceDate: null, status: 'missing', detail: `${source}.${datasets.join('|')} missing`, source }
    const degraded = list.some((row) => /degraded|stale|disabled|failed/i.test(`${row.freshness_status || ''} ${row.metrics_json || ''}`))
    const avgMissing = list.reduce((sum, row) => sum + Number(row.missing_rate ?? 1), 0) / list.length
    const score = degraded ? 55 : clamp(35 + avgMissing * 35, 25, 70)
    return {
      score: Math.round(score * 10) / 10,
      sourceDate: list[0]?.latest_materialization ? String(list[0].latest_materialization).slice(0, 10) : date,
      status: degraded ? 'warn' : 'info',
      detail: list.map((row) => `${row.dataset}:${row.freshness_status}`).join(' / '),
      source: `${source}.${datasets.join('|')}`,
    }
  } catch {
    return { score: null, sourceDate: null, status: 'missing', detail: `${source} source quality query failed`, source }
  }
}

function monitorScore(monitors: Record<string, any>, key: string): number | null {
  const item = monitors?.[key]
  return finiteNumber(item?.score ?? item?.risk_score ?? item?.value ?? item)
}

async function latestExternalEvents(db: D1Database, date: string): Promise<{
  count: number
  sourceDate: string | null
  status: MarketRegimeFactorTile['status']
  title: string | null
  url: string | null
  source: string
  detail: string
  missingReason?: string
}> {
  try {
    const rows = await db.prepare(`
      SELECT source_id, source_kind, title, source_url, published_at, entity_linking_confidence, raw_json
        FROM external_evidence_items
       WHERE accepted = 1
         AND published_at <= ?
         AND source_id IN ('gdelt_events', 'anue', 'avenue', 'tw_news_cnyes', 'cnyes', 'official_rss')
       ORDER BY
         CASE source_id
           WHEN 'gdelt_events' THEN 0
           WHEN 'tw_news_cnyes' THEN 1
           WHEN 'cnyes' THEN 1
           WHEN 'anue' THEN 1
           WHEN 'avenue' THEN 1
           ELSE 2
         END,
         published_at DESC
       LIMIT 8
    `).bind(date).all<{
      source_id: string
      source_kind: string
      title: string
      source_url: string
      published_at: string
      entity_linking_confidence: number | null
      raw_json: string | null
    }>()
    const list = rows.results ?? []
    if (!list.length) {
      return {
        count: 0,
        sourceDate: null,
        status: 'missing',
        title: null,
        url: null,
        source: 'external_evidence_items',
        detail: 'GDELT/鉅亨/官方事件來源皆無 accepted rows',
        missingReason: 'external_event_evidence_missing',
      }
    }
    const top = list[0]
    const hasFetchFailed = /fetch_failed|failed/i.test(`${top.title} ${top.raw_json ?? ''}`)
    const preferred = list.find((row) => !/fetch_failed|failed/i.test(`${row.title} ${row.raw_json ?? ''}`)) ?? top
    const sourceIds = Array.from(new Set(list.map((row) => row.source_id))).join('+')
    return {
      count: list.length,
      sourceDate: preferred.published_at,
      status: hasFetchFailed && preferred === top ? 'warn' : 'info',
      title: preferred.title,
      url: preferred.source_url,
      source: `external_evidence_items.${sourceIds}`,
      detail: `${preferred.source_id}: ${preferred.title}`,
      missingReason: hasFetchFailed && preferred === top ? 'gdelt_fetch_failed_no_news_fallback' : undefined,
    }
  } catch {
    return {
      count: 0,
      sourceDate: null,
      status: 'missing',
      title: null,
      url: null,
      source: 'external_evidence_items',
      detail: 'external evidence query failed',
      missingReason: 'external_event_evidence_query_failed',
    }
  }
}

function evidenceStanceScore(regimeState: any, key: string): number | null {
  const item =
    regimeState?.regime_evidence?.[key] ??
    regimeState?.regime_surface?.evidence?.[key] ??
    regimeState?.evidence?.[key] ??
    regimeState?.regime_surface?.[key]
  if (typeof item === 'number' && Number.isFinite(item)) return clamp(item * 100, 0, 100)
  const stance = String(item?.stance ?? '').toLowerCase()
  if (stance === 'bearish') return 75
  if (stance === 'bullish') return 15
  if (stance === 'neutral') return 40
  return null
}

export async function buildMarketRegimeFactorPacket(
  db: D1Database,
  marketRiskRow: Record<string, any>,
  regimeState: any,
): Promise<MarketRegimeFactorPacket> {
  const date = String(marketRiskRow.date ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10))
  const [canonicalChip, leverage, businessSignal, macroQuality, globalQuality, gdeltQuality, externalEvents] = await Promise.all([
    canonicalInstitutionalNet5d(db, date),
    canonicalLeverageStress(db, date),
    twBusinessSignalContext(db, date),
    sourceQualityContext(db, date, 'finlab', ['tw_business_indicators', 'tw_total_pmi', 'tw_total_nmi', 'tw_monetary_aggregates']),
    sourceQualityContext(db, date, 'finlab', ['global_context']),
    sourceQualityContext(db, date, 'gdelt_events', ['global_event_pressure']),
    latestExternalEvents(db, date),
  ])

  const twiiBias = finiteNumber(marketRiskRow.twii_bias)
  const twiiVol20 = finiteNumber(marketRiskRow.twii_vol20)
  const vix = finiteNumber(marketRiskRow.vix)
  const foreignNet5d = canonicalChip.value ?? finiteNumber(marketRiskRow.foreign_net_5d)
  const marginRatio = finiteNumber(marketRiskRow.margin_ratio)
  const globalEvidenceScore = evidenceStanceScore(regimeState, 'global_risk')
  const macroEvidenceScore = evidenceStanceScore(regimeState, 'macro_liquidity') ?? (businessSignal.value != null ? scoreBusinessSignal(businessSignal.value) : null)
  const lppls = monitorScore(regimeState?.monitors ?? {}, 'lppls_weekly_bubble')
  const hawkes = monitorScore(regimeState?.monitors ?? {}, 'hawkes_contagion')
  const monitorRisk = Math.max(lppls ?? 0, hawkes ?? 0)

  const factors: MarketRegimeFactorTile[] = [
    factor({
      id: 'price_trend',
      label: '價格趨勢',
      raw_value: twiiBias,
      value: twiiBias == null ? 'n/a' : `${twiiBias.toFixed(2)}%`,
      score: twiiBias == null ? 45 : clamp(twiiBias <= -6 ? 85 : twiiBias <= -3 ? 65 : twiiBias >= 3 ? 20 : 40, 0, 100),
      weight: 0.20,
      status: twiiBias == null ? 'missing' : twiiBias <= -3 ? 'warn' : 'ok',
      source: 'market_risk.twii_bias',
      source_date: date,
      detail: `TWII close ${marketRiskRow.twii_close ?? 'n/a'} vs MA20 ${marketRiskRow.twii_ma20 ?? 'n/a'}`,
      missing_reason: twiiBias == null ? 'twii_bias_missing' : undefined,
    }),
    factor({
      id: 'economy_light',
      label: '景氣燈號',
      raw_value: businessSignal.value,
      value: labelBusinessSignal(businessSignal.value),
      score: scoreBusinessSignal(businessSignal.value),
      weight: 0.15,
      status: businessSignal.status,
      source: businessSignal.source,
      source_date: businessSignal.sourceDate,
      detail: businessSignal.detail,
      missing_reason: businessSignal.missingReason,
    }),
    factor({
      id: 'chips',
      label: '籌碼',
      raw_value: foreignNet5d,
      value: formatBillion(foreignNet5d),
      score: foreignNet5d == null ? 45 : clamp(foreignNet5d < -250 ? 85 : foreignNet5d < -80 ? 65 : foreignNet5d > 120 ? 20 : 40, 0, 100),
      weight: 0.15,
      status: foreignNet5d == null ? 'missing' : foreignNet5d < -80 ? 'warn' : 'ok',
      source: canonicalChip.value != null ? 'canonical_chip_daily.finlab_5d_amount' : 'market_risk.foreign_net_5d',
      source_date: canonicalChip.sourceDate ?? date,
      detail: `foreign_consecutive_sell=${marketRiskRow.foreign_consecutive_sell ?? 0}`,
      missing_reason: foreignNet5d == null ? 'institutional_flow_missing' : undefined,
    }),
    factor({
      id: 'leverage',
      label: '槓桿',
      raw_value: marginRatio ?? leverage.value,
      value: marginRatio != null ? `${marginRatio.toFixed(2)}%` : leverage.value != null ? `${leverage.value.toFixed(2)}%` : 'n/a',
      score: marginRatio != null
        ? clamp(marginRatio >= 80 ? 80 : marginRatio >= 65 ? 60 : 35, 0, 100)
        : leverage.value != null
          ? clamp(leverage.value > 8 ? 75 : leverage.value > 3 ? 55 : leverage.value < -5 ? 25 : 40, 0, 100)
          : 45,
      weight: 0.15,
      status: marginRatio == null && leverage.value == null ? 'missing' : (marginRatio ?? leverage.value ?? 0) > 3 ? 'warn' : 'info',
      source: marginRatio != null ? 'market_risk.margin_ratio' : 'canonical_chip_daily.margin_short_proxy',
      source_date: leverage.sourceDate ?? date,
      detail: leverage.detail,
      missing_reason: marginRatio == null && leverage.value == null ? 'leverage_missing' : undefined,
    }),
    factor({
      id: 'volatility',
      label: '波動',
      raw_value: vix ?? twiiVol20,
      value: vix != null ? `VIX ${vix.toFixed(1)}` : twiiVol20 != null ? `${twiiVol20.toFixed(2)}%` : 'n/a',
      score: vix != null
        ? clamp(vix >= 35 ? 85 : vix >= 25 ? 65 : vix <= 16 ? 25 : 40, 0, 100)
        : twiiVol20 != null
          ? clamp(twiiVol20 >= 35 ? 80 : twiiVol20 >= 24 ? 60 : 35, 0, 100)
          : 45,
      weight: 0.10,
      status: vix == null && twiiVol20 == null ? 'missing' : (vix ?? twiiVol20 ?? 0) >= 25 ? 'warn' : 'info',
      source: vix != null ? 'market_risk.vix' : 'market_risk.twii_vol20',
      source_date: date,
      detail: `vix_level=${marketRiskRow.vix_level ?? 'n/a'}`,
      missing_reason: vix == null && twiiVol20 == null ? 'volatility_missing' : undefined,
    }),
    factor({
      id: 'macro',
      label: '總經流動性',
      raw_value: macroEvidenceScore,
      value: businessSignal.value != null ? labelBusinessSignal(businessSignal.value) : '缺 FinLab 總經',
      score: macroEvidenceScore ?? 45,
      weight: 0.10,
      status: macroEvidenceScore == null ? 'missing' : businessSignal.status === 'warn' ? 'warn' : macroQuality.status,
      source: businessSignal.value != null ? businessSignal.source : macroQuality.source,
      source_date: macroQuality.sourceDate ?? regimeState?.run_date ?? null,
      detail: businessSignal.value != null
        ? `${businessSignal.detail}；${macroQuality.detail}`
        : `尚未 materialize FinLab tw_business_indicators / PMI / NMI / M1B：${macroQuality.detail}`,
      missing_reason: macroEvidenceScore == null ? 'macro_finlab_not_materialized' : undefined,
    }),
    factor({
      id: 'global',
      label: '全球風險',
      raw_value: globalEvidenceScore,
      value: globalEvidenceScore == null ? '缺方向分數' : `風險 ${Math.round(globalEvidenceScore)}/100`,
      score: globalEvidenceScore ?? 45,
      weight: 0.10,
      status: globalEvidenceScore == null ? 'missing' : gdeltQuality.status === 'warn' ? 'warn' : globalQuality.status,
      source: `${globalQuality.source}+${gdeltQuality.source}`,
      source_date: globalQuality.sourceDate ?? gdeltQuality.sourceDate ?? regimeState?.run_date ?? null,
      detail: `FinLab world index: ${globalQuality.detail}；GDELT: ${gdeltQuality.detail}`,
      missing_reason: globalEvidenceScore == null ? 'global_direction_score_missing' : undefined,
    }),
    factor({
      id: 'event_monitors',
      label: '事件鏈',
      raw_value: monitorRisk || externalEvents.count || null,
      value: externalEvents.count ? `${externalEvents.count} 則事件` : monitorRisk ? `${Math.round(monitorRisk * 100)}%` : '缺事件',
      score: monitorRisk ? clamp(monitorRisk * 100, 0, 100) : 35,
      weight: 0.05,
      status: monitorRisk >= 0.7 ? 'warn' : externalEvents.status,
      source: `${externalEvents.source}+market_regime_state.monitors`,
      source_date: externalEvents.sourceDate ?? regimeState?.run_date ?? null,
      detail: `${externalEvents.detail}；LPPLS=${lppls ?? 'n/a'} Hawkes=${hawkes ?? 'n/a'}`,
      missing_reason: externalEvents.missingReason ?? (monitorRisk ? undefined : 'lppls_hawkes_missing'),
      evidence_title: externalEvents.title,
      evidence_url: externalEvents.url,
    }),
  ]

  const score = clamp(Math.round(factors.reduce((sum, item) => sum + item.contribution, 0)), 0, 100)
  const missing: Record<string, string> = {}
  const contributions: Record<string, number> = {}
  const sources: Record<string, string> = {}
  const freshness: Record<string, string | null> = {}
  for (const item of factors) {
    contributions[item.id] = item.contribution
    sources[item.id] = item.source
    freshness[item.id] = item.source_date
    if (item.missing_reason) missing[item.id] = item.missing_reason
  }

  return {
    schema_version: 'market-regime-factor-packet-v1',
    date,
    score,
    level: riskLevel(score),
    factors,
    contributions,
    sources,
    freshness,
    missing_reasons: missing,
    lineage: {
      score_policy: 'weighted_finlab_composite_v1',
      finlab_primary: ['canonical_chip_daily', 'canonical_market_daily', 'tw_business_indicators', 'global_context', 'market_regime_state'],
      official_fallback: ['market_risk', 'TWSE/TPEX audit'],
    },
    generated_at: new Date().toISOString(),
  }
}

export async function upsertMarketRegimeFactorPacket(db: D1Database, packet: MarketRegimeFactorPacket): Promise<void> {
  await db.prepare(`
    INSERT INTO market_regime_factor_packets (
      date, schema_version, score, level, factor_json, contribution_json, source_json,
      freshness_json, missing_reason_json, lineage_json, generated_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(date) DO UPDATE SET
      schema_version=excluded.schema_version,
      score=excluded.score,
      level=excluded.level,
      factor_json=excluded.factor_json,
      contribution_json=excluded.contribution_json,
      source_json=excluded.source_json,
      freshness_json=excluded.freshness_json,
      missing_reason_json=excluded.missing_reason_json,
      lineage_json=excluded.lineage_json,
      generated_at=excluded.generated_at,
      updated_at=CURRENT_TIMESTAMP
  `).bind(
    packet.date,
    packet.schema_version,
    packet.score,
    packet.level,
    JSON.stringify(packet.factors),
    JSON.stringify(packet.contributions),
    JSON.stringify(packet.sources),
    JSON.stringify(packet.freshness),
    JSON.stringify(packet.missing_reasons),
    JSON.stringify(packet.lineage),
    packet.generated_at,
  ).run()
}

function parseJsonRecord(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== 'string') return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : {}
  } catch {
    return {}
  }
}

function parseJsonArray(raw: unknown): any[] {
  if (!raw || typeof raw !== 'string') return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function loadMarketRegimeFactorPacket(
  db: D1Database,
  date?: string | null,
): Promise<MarketRegimeFactorPacket | null> {
  const row = date
    ? await db.prepare('SELECT * FROM market_regime_factor_packets WHERE date = ? LIMIT 1').bind(date).first<any>()
    : await db.prepare('SELECT * FROM market_regime_factor_packets ORDER BY date DESC LIMIT 1').first<any>()
  if (!row) return null
  return {
    schema_version: 'market-regime-factor-packet-v1',
    date: String(row.date),
    score: Number(row.score ?? 0),
    level: String(row.level ?? 'yellow') as MarketRegimeFactorPacket['level'],
    factors: parseJsonArray(row.factor_json) as MarketRegimeFactorTile[],
    contributions: parseJsonRecord(row.contribution_json) as Record<string, number>,
    sources: parseJsonRecord(row.source_json) as Record<string, string>,
    freshness: parseJsonRecord(row.freshness_json) as Record<string, string | null>,
    missing_reasons: parseJsonRecord(row.missing_reason_json) as Record<string, string>,
    lineage: parseJsonRecord(row.lineage_json),
    generated_at: String(row.generated_at ?? row.updated_at ?? ''),
  }
}
