export const DASHBOARD_V4_SCHEMA_VERSION = 'dashboard-v4-chart-contract-v1' as const
export const DASHBOARD_V4_CHART_LIBRARY = 'lightweight-charts' as const

type DashboardV4Panel =
  | 'price'
  | 'model_signals'
  | 'regime'
  | 'sector_flow'
  | 'data_quality'
  | 'finlab_diff'
  | 'preview_blocked_reasons'
  | 'execution_pre_pilot_evidence'

export interface DashboardV4Input {
  stock: Record<string, unknown>
  generatedAt?: string
  priceRows?: Array<Record<string, unknown>>
  modelSignals?: Array<Record<string, unknown>>
  regimeState?: Record<string, unknown> | null
  sectorFlowRows?: Array<Record<string, unknown>>
  dataQuality?: Record<string, unknown> | null
  finlabDiffRows?: Array<Record<string, unknown>>
  previewEvents?: Array<Record<string, unknown>>
}

export interface LightweightCandle {
  time: string
  open: number
  high: number
  low: number
  close: number
}

export interface LightweightPoint {
  time: string
  value: number
  color?: string
}

export interface LightweightMarker {
  time: string
  position: 'aboveBar' | 'belowBar'
  shape: 'arrowUp' | 'arrowDown' | 'circle'
  color: string
  text: string
}

export function buildDashboardV4Policy() {
  return {
    schemaVersion: DASHBOARD_V4_SCHEMA_VERSION,
    chartLibrary: DASHBOARD_V4_CHART_LIBRARY,
    dataOwner: 'stockvision_owned',
    externalWidgetsAllowed: false,
    requiredPanels: [
      'price',
      'model_signals',
      'regime',
      'sector_flow',
      'data_quality',
      'finlab_diff',
      'preview_blocked_reasons',
      'execution_pre_pilot_evidence',
    ] satisfies DashboardV4Panel[],
  } as const
}

function asFiniteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function day(value: unknown): string | null {
  const text = String(value ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) return text.slice(0, 10)
  return null
}

function sortByTime<T extends { time: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.time.localeCompare(b.time))
}

function buildCandles(rows: Array<Record<string, unknown>>): LightweightCandle[] {
  const candles: LightweightCandle[] = []
  for (const row of rows) {
    const time = day(row.date ?? row.time)
    const open = asFiniteNumber(row.open)
    const high = asFiniteNumber(row.high)
    const low = asFiniteNumber(row.low)
    const close = asFiniteNumber(row.close)
    if (!time || open == null || high == null || low == null || close == null) continue
    candles.push({ time, open, high, low, close })
  }
  return sortByTime(candles)
}

function buildVolume(rows: Array<Record<string, unknown>>): LightweightPoint[] {
  const points: LightweightPoint[] = []
  for (const row of rows) {
    const time = day(row.date ?? row.time)
    const value = asFiniteNumber(row.volume)
    const open = asFiniteNumber(row.open)
    const close = asFiniteNumber(row.close)
    if (!time || value == null) continue
    points.push({
      time,
      value,
      color: open != null && close != null && close >= open ? '#ef4444' : '#10b981',
    })
  }
  return sortByTime(points)
}

function buildModelMarkers(rows: Array<Record<string, unknown>>): LightweightMarker[] {
  const markers: LightweightMarker[] = []
  for (const row of rows) {
    const time = day(row.prediction_date ?? row.date ?? row.generated_at)
    const signal = String(row.trade_signal ?? row.signal ?? '').toLowerCase()
    if (!time || !['buy', 'strong_buy', 'sell', 'strong_sell'].includes(signal)) continue
    const isBuy = signal.includes('buy')
    const model = String(row.model_name ?? 'model')
    const accuracy = asFiniteNumber(row.direction_accuracy)
    markers.push({
      time,
      position: isBuy ? 'belowBar' : 'aboveBar',
      shape: isBuy ? 'arrowUp' : 'arrowDown',
      color: isBuy ? '#ef4444' : '#10b981',
      text: accuracy == null ? model : `${model} ${(accuracy * 100).toFixed(0)}%`,
    })
  }
  return sortByTime(markers)
}

function buildSectorFlow(rows: Array<Record<string, unknown>>) {
  return rows
    .map((row) => {
      const time = day(row.date ?? row.time)
      const value = asFiniteNumber(row.total_net)
      if (!time || value == null) return null
      return {
        time,
        value,
        sector: String(row.sector ?? 'unknown'),
        classification: String(row.classification ?? 'industry'),
        foreign_net: asFiniteNumber(row.foreign_net),
        trust_net: asFiniteNumber(row.trust_net),
      }
    })
    .filter((row): row is NonNullable<typeof row> => row != null)
    .sort((a, b) => a.time.localeCompare(b.time))
}

function previewReasonRows(rows: Array<Record<string, unknown>>) {
  const allowedTypes = new Set(['finlab_preview', 'finlab_execution_preview'])
  const visibleStatuses = new Set(['blocked', 'warning', 'error'])
  return rows
    .filter((row) => allowedTypes.has(String(row.event_type ?? row.eventType ?? '')))
    .filter((row) => visibleStatuses.has(String(row.status ?? '').toLowerCase()))
    .map((row) => ({
      status: String(row.status ?? 'unknown').toLowerCase(),
      reason: String(row.reason ?? 'unknown'),
      source: String(row.event_type ?? row.eventType ?? 'finlab_preview'),
      created_at: String(row.created_at ?? row.createdAt ?? ''),
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

function executionPrePilotEvidenceRows(rows: Array<Record<string, unknown>>) {
  const allowedTypes = new Set([
    'finlab_l5_market_data',
    'intraday_technical_decision',
    'paper_broker_reconciliation',
  ])
  return rows
    .filter((row) => allowedTypes.has(String(row.event_type ?? row.eventType ?? '')))
    .map((row) => ({
      event_type: String(row.event_type ?? row.eventType ?? 'unknown'),
      status: String(row.status ?? 'unknown').toLowerCase(),
      reason: String(row.reason ?? 'unknown'),
      created_at: String(row.created_at ?? row.createdAt ?? ''),
    }))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

function stockIdentity(stock: Record<string, unknown>) {
  return {
    id: Number(stock.id ?? 0),
    symbol: String(stock.symbol ?? ''),
    name: String(stock.name ?? ''),
    market: String(stock.market ?? ''),
  }
}

export function buildDashboardV4ChartPacket(input: DashboardV4Input) {
  const policy = buildDashboardV4Policy()
  const priceRows = input.priceRows ?? []
  const regime = input.regimeState ?? null
  const finlabRows = input.finlabDiffRows ?? []
  return {
    schemaVersion: policy.schemaVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    chartLibrary: policy.chartLibrary,
    dataOwner: policy.dataOwner,
    externalWidgetUrls: [] as string[],
    stock: stockIdentity(input.stock),
    panels: policy.requiredPanels,
    series: {
      priceCandles: buildCandles(priceRows),
      volumeHistogram: buildVolume(priceRows),
      modelMarkers: buildModelMarkers(input.modelSignals ?? []),
      sectorFlow: buildSectorFlow(input.sectorFlowRows ?? []),
    },
    lightweightChartsSpec: {
      mainPane: [
        { id: 'price', seriesType: 'CandlestickSeries', dataKey: 'series.priceCandles' },
        { id: 'volume', seriesType: 'HistogramSeries', dataKey: 'series.volumeHistogram' },
      ],
      markers: { id: 'model_signals', method: 'createSeriesMarkers', dataKey: 'series.modelMarkers' },
      lowerPanes: [
        { id: 'sector_flow', seriesType: 'HistogramSeries', dataKey: 'series.sectorFlow' },
      ],
    },
    regimeOverlay: regime
      ? {
          source: 'market_regime_state',
          label: String(regime.label ?? ''),
          family: String(regime.family ?? ''),
          run_date: regime.run_date ?? null,
          computed_at: regime.computed_at ?? null,
          regime_surface: regime.regime_surface ?? {},
          transition_guard: regime.transition_guard ?? {},
          monitors: regime.monitors ?? {},
        }
      : null,
    dataQuality: input.dataQuality ?? { overall: 'unknown', checks: [] },
    finlabDiff: {
      mode: 'shadow_audit_only',
      rows: finlabRows,
      empty: finlabRows.length === 0,
    },
    previewBlockedReasons: previewReasonRows(input.previewEvents ?? []),
    executionPrePilotEvidence: executionPrePilotEvidenceRows(input.previewEvents ?? []),
    sourceOwnership: {
      price: 'stockvision_d1',
      model_signals: 'stockvision_d1',
      regime: 'stockvision_kv_market_regime_state',
      sector_flow: 'stockvision_d1',
      data_quality: 'stockvision_worker_quality_report',
      finlab_diff: 'stockvision_finlab_shadow_diff',
      preview_blocked_reasons: 'stockvision_d1_paper_execution_events',
      execution_pre_pilot_evidence: 'stockvision_d1_paper_execution_events',
    },
  }
}

export function validateDashboardV4Contract(packet: {
  chartLibrary?: unknown
  externalWidgetUrls?: unknown
  sourceOwnership?: Record<string, unknown>
}): string[] {
  const errors: string[] = []
  if (packet.chartLibrary !== DASHBOARD_V4_CHART_LIBRARY) {
    errors.push('dashboard_v4_must_use_lightweight_charts')
  }
  if (Array.isArray(packet.externalWidgetUrls) && packet.externalWidgetUrls.length > 0) {
    errors.push('dashboard_v4_must_not_include_external_widget_urls')
  }
  const sources = Object.values(packet.sourceOwnership ?? {})
  if (!sources.length || sources.some((value) => !String(value).startsWith('stockvision_'))) {
    errors.push('dashboard_v4_must_use_stockvision_owned_sources')
  }
  return errors
}
