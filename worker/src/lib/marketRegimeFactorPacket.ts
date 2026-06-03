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
  if (value == null) return null
  if (typeof value === 'string' && value.trim() === '') return null
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

function formatAmountBillion(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'n/a'
  return `${value.toFixed(1)}億`
}

function dateAgeDays(sourceDate: string | null | undefined, targetDate: string): number | null {
  if (!sourceDate) return null
  const source = Date.parse(String(sourceDate).slice(0, 10))
  const target = Date.parse(String(targetDate).slice(0, 10))
  if (!Number.isFinite(source) || !Number.isFinite(target)) return null
  return Math.floor((target - source) / 86_400_000)
}

function isFreshEnough(sourceDate: string | null | undefined, targetDate: string, maxAgeDays = 3): boolean {
  const age = dateAgeDays(sourceDate, targetDate)
  return age != null && age >= 0 && age <= maxAgeDays
}

function factor(input: Omit<MarketRegimeFactorTile, 'contribution'>): MarketRegimeFactorTile {
  return {
    ...input,
    contribution: Math.round(input.score * input.weight * 10) / 10,
  }
}

async function canonicalInstitutionalDailyAmount(db: D1Database, date: string): Promise<{
  total: number | null
  foreign: number | null
  trust: number | null
  dealer: number | null
  sourceDate: string | null
  source: string
  detail: string
  isFresh: boolean
}> {
  try {
    const rows = await db.prepare(`
      WITH latest AS (
        SELECT MAX(date) AS date
          FROM canonical_institutional_amount_daily
         WHERE date <= ?
           AND source = 'finlab.institutional_investors_trading_all_market_summary'
      )
      SELECT date, market_segment, investor, category, net_amount
        FROM canonical_institutional_amount_daily
       WHERE date = (SELECT date FROM latest)
         AND market_segment = 'LISTED'
         AND source = 'finlab.institutional_investors_trading_all_market_summary'
    `).bind(date).all<{
      date: string
      market_segment: string
      investor: string
      category: string | null
      net_amount: number | null
    }>()
    const list = rows.results ?? []
    if (!list.length) {
      return {
        total: null,
        foreign: null,
        trust: null,
        dealer: null,
        sourceDate: null,
        source: 'canonical_institutional_amount_daily.missing',
        detail: 'FinLab 官方當日三大法人買賣超金額尚未 materialize；股數乘收盤價估算已停用',
        isFresh: false,
      }
    }
    const byInvestor = new Map(list.map((row) => [String(row.investor), finiteNumber(row.net_amount)]))
    const sourceDate = list[0]?.date ?? null
    const foreign = byInvestor.get('foreign') ?? null
    const trust = byInvestor.get('trust') ?? null
    const dealerSelf = byInvestor.get('dealer_self') ?? null
    const dealerHedge = byInvestor.get('dealer_hedge') ?? null
    const dealerTotal = byInvestor.get('dealer_total') ?? null
    const dealer = dealerTotal ?? (
      dealerSelf == null && dealerHedge == null
        ? null
        : (dealerSelf ?? 0) + (dealerHedge ?? 0)
    )
    const rowTotal = byInvestor.get('total') ?? null
    const total = rowTotal ?? (
      foreign == null || trust == null || dealer == null
        ? null
        : foreign + trust + dealer
    )
    if (total == null || foreign == null || trust == null || dealer == null) {
      return {
        total: null,
        foreign: foreign == null ? null : Math.round((foreign / 100000000) * 10) / 10,
        trust: trust == null ? null : Math.round((trust / 100000000) * 10) / 10,
        dealer: dealer == null ? null : Math.round((dealer / 100000000) * 10) / 10,
        sourceDate,
        source: 'canonical_institutional_amount_daily.incomplete',
        detail: 'FinLab 官方當日三大法人買賣超金額欄位不完整；股數乘收盤價估算已停用',
        isFresh: isFreshEnough(sourceDate, date),
      }
    }
    const foreignBillion = foreign / 100000000
    const trustBillion = trust / 100000000
    const dealerBillion = dealer / 100000000
    const totalBillion = total / 100000000
    return {
      total: Math.round(totalBillion * 10) / 10,
      foreign: Math.round(foreignBillion * 10) / 10,
      trust: Math.round(trustBillion * 10) / 10,
      dealer: Math.round(dealerBillion * 10) / 10,
      sourceDate,
      source: 'canonical_institutional_amount_daily.finlab_daily_official_amount',
      detail: [
        `官方當日成交金額（FinLab/TWSE BFI82U，上市）`,
        `外資=${formatAmountBillion(foreignBillion)}`,
        `投信=${formatAmountBillion(trustBillion)}`,
        `自營=${formatAmountBillion(dealerBillion)}`,
        `合計=${formatAmountBillion(totalBillion)}`,
        '非股數乘收盤價估算',
      ].join('；'),
      isFresh: isFreshEnough(sourceDate, date),
    }
  } catch (error: any) {
    return {
      total: null,
      foreign: null,
      trust: null,
      dealer: null,
      sourceDate: null,
      source: 'canonical_institutional_amount_daily.query_failed',
      detail: `FinLab 官方當日三大法人買賣超金額查詢失敗：${String(error?.message ?? error).slice(0, 140)}；股數乘收盤價估算已停用`,
      isFresh: false,
    }
  }
}

async function canonicalLeverageStress(db: D1Database, date: string): Promise<{
  marginBillion: number | null
  shortBillion: number | null
  marginChangePct: number | null
  sourceDate: string | null
  source: string
  detail: string
}> {
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
               COUNT(*) AS canonical_rows,
               COUNT(m.close) AS priced_rows,
               SUM(CASE WHEN m.close IS NOT NULL AND c.margin_balance IS NOT NULL THEN c.margin_balance * m.close ELSE NULL END) / 100000000.0 AS margin_billion,
               SUM(CASE WHEN m.close IS NOT NULL AND c.short_balance IS NOT NULL THEN c.short_balance * m.close ELSE NULL END) / 100000000.0 AS short_billion,
               SUM(CASE WHEN c.margin_balance IS NOT NULL THEN 1 ELSE 0 END) AS margin_rows,
               SUM(CASE WHEN c.short_balance IS NOT NULL THEN 1 ELSE 0 END) AS short_rows
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
    `).bind(date).all<{
      date: string
      canonical_rows: number | null
      priced_rows: number | null
      margin_rows: number | null
      short_rows: number | null
      margin_billion: number | null
      short_billion: number | null
    }>()
    const dailyRows = rows.results ?? []
    const targetCanonical = dailyRows.find((row) => row.date === date)
    if (
      targetCanonical &&
      Number(targetCanonical.canonical_rows ?? 0) > 0 &&
      (Number(targetCanonical.margin_rows ?? 0) <= 0 || Number(targetCanonical.short_rows ?? 0) <= 0)
    ) {
      const legacy = await legacyLeverageStress(
        db,
        date,
        'canonical_chip_daily.target_margin_missing: target canonical_chip_daily rows exist but margin/short are empty',
      )
      if (legacy.marginBillion != null) return legacy
    }
    const list = dailyRows.filter((row) => Number(row.priced_rows ?? 0) > 0 && Number(row.margin_rows ?? 0) > 0 && Number(row.short_rows ?? 0) > 0)
    if (!list.length) return await legacyLeverageStress(db, date, 'canonical margin_balance missing')
    const latest = list[list.length - 1]
    const prev = list.length >= 2 ? list[0] : null
    const latestMargin = Number(latest.margin_billion ?? 0)
    const latestShort = Number(latest.short_billion ?? 0)
    const prevMargin = prev ? Number(prev.margin_billion ?? 0) : 0
    const change = prev && prevMargin > 0 ? (latestMargin / prevMargin - 1) * 100 : null
    const canonical = {
      marginBillion: Math.round(latestMargin * 10) / 10,
      shortBillion: Math.round(latestShort * 10) / 10,
      marginChangePct: change == null ? null : Math.round(change * 100) / 100,
      sourceDate: latest.date,
      source: 'canonical_chip_daily.margin_short_amount',
      detail: `融資=${formatAmountBillion(latestMargin)} 融券=${formatAmountBillion(latestShort)}${change == null ? '；缺少前期比較' : `；近 6 日融資變化 ${change.toFixed(2)}%`}`,
    }
    if (isFreshEnough(canonical.sourceDate, date)) return canonical
    const legacy = await legacyLeverageStress(db, date, `canonical_chip_daily stale at ${canonical.sourceDate ?? 'missing'}`)
    return legacy.marginBillion != null ? legacy : canonical
  } catch {
    return await legacyLeverageStress(db, date, 'canonical leverage query failed')
  }
}

async function legacyLeverageStress(db: D1Database, date: string, reason: string): Promise<{
  marginBillion: number | null
  shortBillion: number | null
  marginChangePct: number | null
  sourceDate: string | null
  source: string
  detail: string
}> {
  try {
    const rows = await db.prepare(`
      WITH dates AS (
        SELECT DISTINCT date
          FROM margin_data
         WHERE date <= ?
         ORDER BY date DESC
         LIMIT 6
      ),
      daily AS (
        SELECT m.date,
               COUNT(sp.close) AS priced_rows,
               SUM(CASE WHEN sp.close IS NOT NULL AND m.margin_balance IS NOT NULL THEN m.margin_balance * sp.close ELSE NULL END) / 100000000.0 AS margin_billion,
               SUM(CASE WHEN sp.close IS NOT NULL AND m.short_balance IS NOT NULL THEN m.short_balance * sp.close ELSE NULL END) / 100000000.0 AS short_billion,
               SUM(CASE WHEN m.margin_balance IS NOT NULL THEN 1 ELSE 0 END) AS margin_rows
          FROM margin_data m
          LEFT JOIN stock_prices sp
            ON sp.stock_id = m.stock_id
           AND sp.date = m.date
         WHERE m.date IN (SELECT date FROM dates)
         GROUP BY m.date
         ORDER BY m.date ASC
      )
      SELECT * FROM daily
    `).bind(date).all<{
      date: string
      priced_rows: number | null
      margin_rows: number | null
      margin_billion: number | null
      short_billion: number | null
    }>()
    const list = (rows.results ?? []).filter((row) => Number(row.priced_rows ?? 0) > 0 && Number(row.margin_rows ?? 0) > 0)
    if (!list.length) return { marginBillion: null, shortBillion: null, marginChangePct: null, sourceDate: null, source: 'margin_data.legacy_margin_short_amount', detail: `${reason}; legacy margin_data missing` }
    const latest = list[list.length - 1]
    const prev = list.length >= 2 ? list[0] : null
    const latestMargin = Number(latest.margin_billion ?? 0)
    const latestShort = Number(latest.short_billion ?? 0)
    const prevMargin = prev ? Number(prev.margin_billion ?? 0) : 0
    const change = prev && prevMargin > 0 ? (latestMargin / prevMargin - 1) * 100 : null
    return {
      marginBillion: Math.round(latestMargin * 10) / 10,
      shortBillion: Math.round(latestShort * 10) / 10,
      marginChangePct: change == null ? null : Math.round(change * 100) / 100,
      sourceDate: latest.date,
      source: 'margin_data.legacy_margin_short_amount',
      detail: `融資=${formatAmountBillion(latestMargin)} 融券=${formatAmountBillion(latestShort)}${change == null ? '；缺少前期比較' : `；近 6 日融資變化 ${change.toFixed(2)}%`}；${reason}`,
    }
  } catch {
    return { marginBillion: null, shortBillion: null, marginChangePct: null, sourceDate: null, source: 'margin_data.legacy_margin_short_amount', detail: `${reason}; legacy leverage query failed` }
  }
}
async function sectorBreadthSignal(db: D1Database, date: string): Promise<{ value: number | null; sourceDate: string | null; detail: string }> {
  try {
    const rows = await db.prepare(`
      SELECT date, classification, quadrant, COUNT(*) AS n
        FROM sector_flow
       WHERE date = (SELECT MAX(date) FROM sector_flow WHERE date <= ?)
         AND classification IN ('industry', 'industry_theme', 'subindustry', 'theme')
         AND quadrant IS NOT NULL
       GROUP BY date, classification, quadrant
    `).bind(date).all<{ date: string; classification: string; quadrant: string; n: number }>()
    const list = rows.results ?? []
    if (!list.length) return { value: null, sourceDate: null, detail: 'sector_flow missing' }
    const positive = list.filter((row) => row.quadrant === 'Leading' || row.quadrant === 'Improving').reduce((sum, row) => sum + Number(row.n ?? 0), 0)
    const total = list.reduce((sum, row) => sum + Number(row.n ?? 0), 0)
    const ratio = total > 0 ? positive / total : null
    return {
      value: ratio == null ? null : Math.round(ratio * 10000) / 100,
      sourceDate: list[0]?.date ?? null,
      detail: `positive_quadrants=${positive}/${total}`,
    }
  } catch {
    return { value: null, sourceDate: null, detail: 'sector breadth query failed' }
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
       WHERE as_of_date <= ?
         AND source = ?
         AND dataset IN (${placeholders})
       ORDER BY as_of_date DESC, latest_materialization DESC
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

type SourceQualityMetricRow = {
  source: string
  dataset: string
  freshness_status: string | null
  missing_rate: number | null
  latest_materialization: string | null
  metrics_json: string | null
  as_of_date?: string | null
}

async function latestSourceQualityRow(
  db: D1Database,
  date: string,
  source: string,
  dataset: string,
): Promise<SourceQualityMetricRow | null> {
  try {
    return await db.prepare(`
      SELECT as_of_date, source, dataset, freshness_status, missing_rate, latest_materialization, metrics_json
        FROM source_quality_metrics
       WHERE as_of_date <= ?
         AND source = ?
         AND dataset = ?
       ORDER BY as_of_date DESC, latest_materialization DESC
       LIMIT 1
    `).bind(date, source, dataset).first<SourceQualityMetricRow>()
  } catch {
    return null
  }
}

function qualitySourceDate(row: SourceQualityMetricRow | null, fallbackDate: string): string | null {
  if (!row) return null
  return row.latest_materialization ? String(row.latest_materialization).slice(0, 10) : String(row.as_of_date ?? fallbackDate)
}

function metricField(row: SourceQualityMetricRow | null, names: string[]): { value: unknown; date: string | null } | null {
  const metrics = parseJsonRecord(row?.metrics_json)
  const fields = metrics.fields && typeof metrics.fields === 'object' && !Array.isArray(metrics.fields)
    ? metrics.fields as Record<string, any>
    : {}
  for (const name of names) {
    const field = fields[name]
    if (field != null) {
      if (typeof field === 'object' && !Array.isArray(field)) {
        return { value: field.value ?? field.latest ?? field.raw ?? null, date: field.date ? String(field.date) : null }
      }
      return { value: field, date: qualitySourceDate(row, '') }
    }
    const topLevel = metrics[name]
    if (topLevel != null) return { value: topLevel, date: qualitySourceDate(row, '') }
  }
  return null
}

function metricFieldHistory(row: SourceQualityMetricRow | null, names: string[]): Array<{ value: unknown; date: string | null }> {
  const metrics = parseJsonRecord(row?.metrics_json)
  const fields = metrics.fields && typeof metrics.fields === 'object' && !Array.isArray(metrics.fields)
    ? metrics.fields as Record<string, any>
    : {}
  for (const name of names) {
    const field = fields[name]
    const history = field && typeof field === 'object' && !Array.isArray(field) ? field.history : null
    if (Array.isArray(history)) {
      return history
        .map((item) => typeof item === 'object' && item !== null
          ? { value: item.value ?? item.raw ?? item.latest ?? null, date: item.date ? String(item.date) : null }
          : { value: item, date: null })
        .filter((item) => item.value != null)
    }
  }
  return []
}

async function finlabBusinessCycleContext(
  db: D1Database,
  date: string,
): Promise<{ value: string; raw: number | string | null; sourceDate: string | null; detail: string; missing: boolean } | null> {
  const row = await latestSourceQualityRow(db, date, 'finlab', 'tw_business_indicators')
  if (!row) return null
  const signalNames = ['景氣對策信號(分)', 'business_cycle_signal', 'latest_signal_score']
  const signal = metricField(row, signalNames)
  const score = finiteNumber(signal?.value)
  if (score == null) return null
  const history = metricFieldHistory(row, signalNames)
  const previous = history.length >= 2 ? history[history.length - 2] : null
  const previousScore = finiteNumber(previous?.value)
  const leading = metricField(row, ['領先指標綜合指數(點)', 'leading_index'])
  const coincident = metricField(row, ['同時指標綜合指數(點)', 'coincident_index'])
  const sourceDate = signal?.date ?? qualitySourceDate(row, date)
  const currentLight = businessCycleLight(score) ?? '景氣燈號'
  const transition = previousScore == null
    ? `${currentLight} ${score.toFixed(0)}`
    : `${businessCycleLight(previousScore) ?? '前月'} ${previousScore.toFixed(0)} → ${currentLight} ${score.toFixed(0)}`
  return {
    value: transition,
    raw: score,
    sourceDate,
    detail: [
      `FinLab source_quality ${row.dataset}:${row.freshness_status ?? 'unknown'}`,
      `景氣對策信號=${score.toFixed(0)}`,
      previousScore == null ? '前月燈號尚未寫入 source_quality_metrics.history' : null,
      leading?.value != null ? `領先指標=${leading.value}` : null,
      coincident?.value != null ? `同時指標=${coincident.value}` : null,
    ].filter(Boolean).join('；'),
    missing: false,
  }
}

async function businessCycleContextWithFallback(
  db: D1Database,
  date: string,
  regimeState: any,
): Promise<{ value: string; raw: number | string | null; sourceDate: string | null; detail: string; missing: boolean }> {
  const current = businessCycleContext(regimeState)
  if (!current.missing) return current
  return await finlabBusinessCycleContext(db, date) ?? current
}

type EvidenceContext = {
  raw: number | string | null
  value: string
  score: number | null
  detail: string
  missing: boolean
  source: string
  sourceDate: string | null
  status: MarketRegimeFactorTile['status']
}

async function macroLiquidityContextWithFallback(db: D1Database, date: string, regimeState: any): Promise<EvidenceContext> {
  const current = evidenceRawContext(regimeState, 'macro_liquidity')
  if (!current.missing) {
    return {
      ...current,
      source: 'market_regime_state.evidence.macro_liquidity',
      sourceDate: regimeState?.run_date ?? null,
      status: 'info',
    }
  }
  const row = await latestSourceQualityRow(db, date, 'finlab', 'tw_monetary_aggregates')
  const m2 = metricField(row, ['年增率(%)', 'M2年增率(%)', 'm2_yoy_pct'])
  const growth = finiteNumber(m2?.value)
  if (!row || growth == null) {
    return {
      ...current,
      source: 'market_regime_state.evidence.macro_liquidity',
      sourceDate: regimeState?.run_date ?? null,
      status: 'missing',
    }
  }
  return {
    raw: growth,
    value: `M2年增率 ${growth.toFixed(2)}%`,
    score: clamp(growth >= 8 ? 35 : growth >= 4 ? 40 : growth >= 0 ? 55 : 70, 0, 100),
    detail: `FinLab source_quality ${row.dataset}:${row.freshness_status ?? 'unknown'}；貨幣供給年增率=${growth.toFixed(2)}%`,
    missing: false,
    source: 'finlab.tw_monetary_aggregates',
    sourceDate: m2?.date ?? qualitySourceDate(row, date),
    status: 'info',
  }
}

async function globalRiskContextWithFallback(db: D1Database, date: string, regimeState: any): Promise<EvidenceContext> {
  const current = evidenceRawContext(regimeState, 'global_risk')
  if (!current.missing) {
    return {
      ...current,
      value: globalRiskDisplayValue(current.raw ?? current.value),
      source: 'market_regime_state.evidence.global_risk',
      sourceDate: regimeState?.run_date ?? null,
      status: 'info',
    }
  }
  const row = await latestSourceQualityRow(db, date, 'finlab', 'global_context')
  const metrics = parseJsonRecord(row?.metrics_json)
  const rows = finiteNumber(metrics.finlab_rows ?? metrics.row_count)
  if (!row) {
    return {
      ...current,
      source: 'market_regime_state.evidence.global_risk',
      sourceDate: regimeState?.run_date ?? null,
      status: 'missing',
    }
  }
  return {
    raw: rows ?? String(row.freshness_status ?? 'ok'),
    value: rows != null ? `world_index ${Math.round(rows).toLocaleString('en-US')} rows` : `FinLab ${row.freshness_status ?? 'ok'}`,
    score: 45,
    detail: `FinLab source_quality ${row.dataset}:${row.freshness_status ?? 'unknown'}${rows != null ? `；rows=${Math.round(rows)}` : ''}`,
    missing: false,
    source: 'finlab.global_context',
    sourceDate: qualitySourceDate(row, date),
    status: /degraded|stale|disabled|failed/i.test(String(row.freshness_status ?? '')) ? 'warn' : 'info',
  }
}

function monitorScore(monitors: Record<string, any>, key: string): number | null {
  const item = monitors?.[key]
  return finiteNumber(item?.score ?? item?.risk_score ?? item?.value ?? item)
}

function regimeEvidenceItem(regimeState: any, key: string): any {
  return regimeState?.regime_evidence?.evidence?.[key] ??
    regimeState?.regime_evidence?.[key] ??
    regimeState?.regime_surface?.evidence?.[key] ??
    regimeState?.evidence?.[key] ??
    regimeState?.regime_surface?.[key]
}

function evidenceStanceScore(regimeState: any, key: string): number | null {
  const item = regimeEvidenceItem(regimeState, key)
  if (typeof item === 'number' && Number.isFinite(item)) return clamp(item * 100, 0, 100)
  const stance = String(item?.stance ?? '').toLowerCase()
  if (stance === 'bearish') return 75
  if (stance === 'bullish') return 15
  if (stance === 'neutral') return 40
  return null
}

function globalRiskDisplayValue(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'bullish' || text === 'risk_on' || text === 'global_risk_on') return '全球風險偏低'
  if (text === 'bearish' || text === 'risk_off' || text === 'global_risk_off') return '全球風險偏高'
  if (text === 'neutral') return '全球風險中性'
  return String(value ?? 'n/a')
}

function evidenceRawContext(regimeState: any, key: string): {
  raw: number | string | null
  value: string
  score: number | null
  detail: string
  missing: boolean
} {
  const item = regimeEvidenceItem(regimeState, key)

  if (item == null || item === '') {
    return {
      raw: null,
      value: 'n/a',
      score: null,
      detail: `${key} 尚未寫入 market_regime_state.regime_evidence.evidence`,
      missing: true,
    }
  }

  if (typeof item === 'number' && Number.isFinite(item)) {
    const normalized = item >= 0 && item <= 1 ? item * 100 : item
    return {
      raw: item,
      value: item >= 0 && item <= 1 ? `${(item * 100).toFixed(1)}%` : String(item),
      score: clamp(normalized, 0, 100),
      detail: `${key} raw=${item}`,
      missing: false,
    }
  }

  if (typeof item === 'string') {
    return {
      raw: item,
      value: item,
      score: evidenceStanceScore(regimeState, key),
      detail: `${key}=${item}`,
      missing: false,
    }
  }

  if (typeof item === 'object') {
    if (String(item.status ?? '').toLowerCase() === 'missing') {
      return {
        raw: null,
        value: 'n/a',
        score: null,
        detail: `${key} missing：${item.reason ?? item.missing_reason ?? 'source evidence not populated'}`,
        missing: true,
      }
    }
    const rawScore = finiteNumber(item.score ?? item.risk_score)
    const score = rawScore == null
      ? evidenceStanceScore(regimeState, key)
      : clamp(rawScore >= 0 && rawScore <= 1 ? rawScore * 100 : rawScore, 0, 100)
    const raw = item.raw ?? item.raw_value ?? item.value ?? item.stance ?? item.label ?? item.summary ?? null
    const value = String(item.label ?? item.display ?? item.value ?? item.stance ?? item.summary ?? raw ?? 'n/a')
    const metrics = item.metrics && typeof item.metrics === 'object' && !Array.isArray(item.metrics)
      ? Object.entries(item.metrics).slice(0, 4).map(([name, metric]) => {
        if (typeof metric === 'object' && metric !== null) {
          const metricValue = (metric as any).value ?? (metric as any).latest ?? (metric as any).raw ?? JSON.stringify(metric)
          return `${name}=${metricValue}`
        }
        return `${name}=${metric}`
      })
      : []
    const detailParts = [
      item.status ? `status=${item.status}` : null,
      item.reason ? `reason=${item.reason}` : null,
      item.summary ? `summary=${item.summary}` : null,
      item.stance ? `stance=${item.stance}` : null,
      item.value != null ? `value=${item.value}` : null,
      rawScore != null ? `score=${rawScore}` : null,
      ...metrics,
    ].filter(Boolean)
    return {
      raw: typeof raw === 'number' || typeof raw === 'string' ? raw : value,
      value,
      score,
      detail: detailParts.length ? detailParts.join('；') : `${key} raw evidence`,
      missing: false,
    }
  }

  return {
    raw: String(item),
    value: String(item),
    score: null,
    detail: `${key} raw=${String(item)}`,
    missing: false,
  }
}
function firstPresent(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== '') return value
  }
  return null
}

function businessCycleLight(score: number | null): string | null {
  if (score == null) return null
  if (score <= 16) return '藍燈'
  if (score <= 22) return '黃藍燈'
  if (score <= 31) return '綠燈'
  if (score <= 37) return '黃紅燈'
  return '紅燈'
}

function businessCycleContext(regimeState: any): { value: string; raw: number | string | null; sourceDate: string | null; detail: string; missing: boolean } {
  const twBusiness = regimeState?.regime_evidence?.evidence?.tw_business_indicators ??
    regimeState?.regime_evidence?.tw_business_indicators ??
    regimeState?.regime_surface?.evidence?.tw_business_indicators ??
    regimeState?.evidence?.tw_business_indicators
  const raw = firstPresent(
    regimeState?.macro?.business_cycle_signal,
    regimeState?.macro?.tw_business_cycle_signal,
    twBusiness?.signal,
    twBusiness?.score,
  )
  const score = finiteNumber(raw)
  const light = businessCycleLight(score)
  const previousScore = finiteNumber(twBusiness?.previous_signal ?? twBusiness?.previous_score)
  const previousLight = businessCycleLight(previousScore)
  const leading = firstPresent(
    regimeState?.macro?.leading_index,
    twBusiness?.leading_index,
  )
  const coincident = firstPresent(
    regimeState?.macro?.coincident_index,
    twBusiness?.coincident_index,
  )
  const date = String(firstPresent(
    regimeState?.macro?.source_date,
    twBusiness?.date,
    regimeState?.run_date,
  ) ?? '')
  if (score == null && !light) {
    return {
      value: 'n/a',
      raw: null,
      sourceDate: date || null,
      detail: 'FinLab tw_business_indicators 尚未 materialize 到 market_regime_state',
      missing: true,
    }
  }
  const current = `${light ?? '景氣燈號'} ${score?.toFixed(0) ?? raw}`
  const value = previousScore == null ? current : `${previousLight ?? '前月'} ${previousScore.toFixed(0)} → ${current}`
  return {
    value,
    raw: score ?? String(raw),
    sourceDate: date || null,
    detail: `景氣對策信號=${score ?? raw}${previousScore == null ? '' : `；前月=${previousScore}`}${leading != null ? `；領先指標=${leading}` : ''}${coincident != null ? `；同時指標=${coincident}` : ''}`,
    missing: false,
  }
}
async function latestCnyesHeadlines(): Promise<{ value: string; sourceDate: string | null; detail: string; url: string | null; missing: boolean }> {
  const url = 'https://news.cnyes.com/api/v3/news/category/headline?page=1&limit=5'
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch(url, {
      headers: { 'User-Agent': 'StockVision/12.3 (market-regime-context)' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`cnyes_http_${res.status}`)
    const body = await res.json() as any
    const items = Array.isArray(body?.items?.data) ? body.items.data : []
    const first = items.find((item: any) => item?.title)
    if (!first) throw new Error('cnyes_empty')
    const ts = Number(first.publishAt ?? first.publishedAt ?? 0)
    const sourceDate = Number.isFinite(ts) && ts > 0
      ? new Date(ts * 1000).toISOString().slice(0, 10)
      : null
    const newsId = first.newsId ?? first.id
    return {
      value: String(first.title).slice(0, 52),
      sourceDate,
      detail: `鉅亨頭條：${String(first.title).slice(0, 90)}${newsId ? `；url=https://news.cnyes.com/news/id/${newsId}` : ''}`,
      url: newsId ? `https://news.cnyes.com/news/id/${newsId}` : 'https://news.cnyes.com/news/cat/headline',
      missing: false,
    }
  } catch (error: any) {
    return {
      value: 'n/a',
      sourceDate: null,
      detail: `鉅亨頭條讀取失敗：${String(error?.message ?? error)}`,
      url,
      missing: true,
    }
  }
}

export async function buildMarketRegimeFactorPacket(
  db: D1Database,
  marketRiskRow: Record<string, any>,
  regimeState: any,
): Promise<MarketRegimeFactorPacket> {
  const date = String(marketRiskRow.date ?? new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10))
  const [canonicalChip, leverage, cnyesEvent, businessCycle, macroEvidence, globalEvidence] = await Promise.all([
    canonicalInstitutionalDailyAmount(db, date),
    canonicalLeverageStress(db, date),
    latestCnyesHeadlines(),
    businessCycleContextWithFallback(db, date, regimeState),
    macroLiquidityContextWithFallback(db, date, regimeState),
    globalRiskContextWithFallback(db, date, regimeState),
  ])

  const twiiBias = finiteNumber(marketRiskRow.twii_bias)
  const twiiVol20 = finiteNumber(marketRiskRow.twii_vol20)
  const vix = finiteNumber(marketRiskRow.vix)
  const institutionalNetDaily = canonicalChip.total
  const lppls = monitorScore(regimeState?.monitors ?? {}, 'lppls_weekly_bubble')
  const hawkes = monitorScore(regimeState?.monitors ?? {}, 'hawkes_contagion')
  const monitorRisk = Math.max(lppls ?? 0, hawkes ?? 0)

  const factors: MarketRegimeFactorTile[] = [
    factor({
      id: 'price_trend',
      label: '趨勢 / 20MA',
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
      id: 'breadth',
      label: '景氣對策燈號',
      raw_value: businessCycle.raw,
      value: businessCycle.value,
      score: finiteNumber(businessCycle.raw) == null
        ? 45
        : clamp(Number(businessCycle.raw) <= 16 ? 85 : Number(businessCycle.raw) <= 22 ? 62 : Number(businessCycle.raw) <= 31 ? 38 : Number(businessCycle.raw) <= 37 ? 55 : 72, 0, 100),
      weight: 0.15,
      status: businessCycle.missing ? 'missing' : 'info',
      source: 'finlab.tw_business_indicators',
      source_date: businessCycle.sourceDate,
      detail: businessCycle.detail,
      missing_reason: businessCycle.missing ? 'tw_business_indicators_missing' : undefined,
    }),
    factor({
      id: 'chips',
      label: '三大法人',
      raw_value: institutionalNetDaily,
      value: formatAmountBillion(institutionalNetDaily),
      score: institutionalNetDaily == null ? 45 : clamp(institutionalNetDaily < -250 ? 85 : institutionalNetDaily < -80 ? 65 : institutionalNetDaily > 120 ? 20 : 40, 0, 100),
      weight: 0.15,
      status: institutionalNetDaily == null ? 'missing' : !canonicalChip.isFresh ? 'warn' : institutionalNetDaily < -80 ? 'warn' : 'ok',
      source: canonicalChip.source,
      source_date: canonicalChip.sourceDate,
      detail: canonicalChip.detail,
      missing_reason: institutionalNetDaily == null ? 'official_daily_institutional_amount_missing' : undefined,
    }),
    factor({
      id: 'leverage',
      label: '融資融券',
      raw_value: leverage.marginBillion,
      value: leverage.marginBillion != null
        ? `融資 ${formatAmountBillion(leverage.marginBillion)} / 融券 ${formatAmountBillion(leverage.shortBillion)}`
        : 'n/a',
      score: leverage.marginChangePct != null
        ? clamp(leverage.marginChangePct > 8 ? 75 : leverage.marginChangePct > 3 ? 55 : leverage.marginChangePct < -5 ? 25 : 40, 0, 100)
        : 45,
      weight: 0.15,
      status: leverage.marginBillion == null ? 'missing' : leverage.marginChangePct != null && leverage.marginChangePct > 3 ? 'warn' : 'info',
      source: leverage.source,
      source_date: leverage.sourceDate ?? date,
      detail: leverage.detail,
      missing_reason: leverage.marginBillion == null ? 'leverage_missing' : undefined,
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
      label: '總經',
      raw_value: macroEvidence.raw,
      value: macroEvidence.value,
      score: macroEvidence.score ?? 45,
      weight: 0.10,
      status: macroEvidence.status,
      source: macroEvidence.source,
      source_date: macroEvidence.sourceDate,
      detail: macroEvidence.detail,
      missing_reason: macroEvidence.missing ? 'macro_liquidity_missing' : undefined,
    }),
    factor({
      id: 'global',
      label: '全球風險',
      raw_value: globalEvidence.raw,
      value: globalEvidence.value,
      score: globalEvidence.score ?? 45,
      weight: 0.10,
      status: globalEvidence.status,
      source: globalEvidence.source,
      source_date: globalEvidence.sourceDate,
      detail: globalEvidence.detail,
      missing_reason: globalEvidence.missing ? 'global_risk_missing' : undefined,
    }),
    factor({
      id: 'event_monitors',
      label: '全球事件',
      raw_value: cnyesEvent.value,
      value: cnyesEvent.value,
      score: monitorRisk ? clamp(monitorRisk * 100, 0, 100) : 45,
      weight: 0.05,
      status: cnyesEvent.missing ? 'missing' : monitorRisk >= 0.7 ? 'warn' : 'info',
      source: cnyesEvent.url ?? 'cnyes.headline',
      source_date: cnyesEvent.sourceDate ?? regimeState?.run_date ?? null,
      detail: `${cnyesEvent.detail}；LPPLS=${lppls ?? 'n/a'} Hawkes=${hawkes ?? 'n/a'}`,
      missing_reason: cnyesEvent.missing ? 'cnyes_headline_missing' : undefined,
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
      finlab_primary: ['canonical_institutional_amount_daily', 'canonical_chip_daily', 'canonical_market_daily', 'sector_flow', 'market_regime_state', 'source_quality_metrics'],
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
