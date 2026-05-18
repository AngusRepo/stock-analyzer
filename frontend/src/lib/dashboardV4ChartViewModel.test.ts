import {
  buildDashboardV4ChartViewModel,
  summarizeDashboardV4Packet,
  type DashboardV4ChartViewModel,
} from './dashboardV4ChartViewModel.ts'
import type { DashboardV4ChartPacket } from './api'

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const actualJson = JSON.stringify(actual)
  const expectedJson = JSON.stringify(expected)
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`)
  }
}

const packet: DashboardV4ChartPacket = {
  schemaVersion: 'dashboard-v4-chart-contract-v1',
  generatedAt: '2026-05-16T02:00:00.000Z',
  chartLibrary: 'lightweight-charts',
  dataOwner: 'stockvision_owned',
  externalWidgetUrls: [],
  stock: { id: 1, symbol: '2330', name: 'TSMC', market: 'TWSE' },
  panels: ['price', 'model_signals', 'regime', 'sector_flow', 'data_quality', 'finlab_diff', 'preview_blocked_reasons'],
  series: {
    priceCandles: [
      { time: '2026-05-15', open: 100, high: 110, low: 99, close: 108 },
      { time: '2026-05-14', open: 95, high: 101, low: 94, close: 100 },
    ],
    volumeHistogram: [
      { time: '2026-05-15', value: 5000, color: '#ef4444' },
      { time: '2026-05-14', value: 3000, color: '#10b981' },
    ],
    modelMarkers: [
      { time: '2026-05-15', position: 'belowBar', shape: 'arrowUp', color: '#ef4444', text: 'ensemble 72%' },
      { time: '2026-05-14', position: 'aboveBar', shape: 'arrowDown', color: '#10b981', text: 'risk 61%' },
    ],
    sectorFlow: [
      { time: '2026-05-15', value: 1200, sector: 'Semiconductor', classification: 'industry', foreign_net: 900, trust_net: 300 },
      { time: '2026-05-14', value: -100, sector: 'Semiconductor', classification: 'industry', foreign_net: -50, trust_net: -50 },
    ],
  },
  lightweightChartsSpec: {},
  regimeOverlay: {
    source: 'market_regime_state',
    label: 'bull_market',
    family: 'bull',
    run_date: '2026-05-15',
  },
  dataQuality: {
    date: '2026-05-16',
    generated_at: '2026-05-16T02:00:00.000Z',
    overall: 'warn',
    checks: [
      { id: 'price_freshness', label: 'Price freshness', status: 'ok', summary: 'fresh' },
      { id: 'feature_lake', label: 'Feature lake', status: 'warn', summary: '3 missing fields' },
    ],
  },
  finlabDiff: {
    mode: 'shadow_audit_only',
    empty: false,
    rows: [
      { lane: 'parity', status: 'shadow', matchedFields: 88 },
      { lane: 'diversity', status: 'candidate', matchedFields: 14 },
    ],
  },
  previewBlockedReasons: [
    { status: 'blocked', reason: 'insufficient_settlement_cash', source: 'finlab_preview', created_at: '2026-05-15T01:00:00Z' },
    { status: 'warning', reason: 'broker caution', source: 'finlab_execution_preview', created_at: '2026-05-15T02:00:00Z' },
  ],
  sourceOwnership: {
    price: 'stockvision_d1',
    model_signals: 'stockvision_d1',
    regime: 'stockvision_kv_market_regime_state',
    sector_flow: 'stockvision_d1',
    data_quality: 'stockvision_worker_quality_report',
    finlab_diff: 'stockvision_finlab_shadow_diff',
    preview_blocked_reasons: 'stockvision_d1_paper_execution_events',
  },
}

{
  const viewModel: DashboardV4ChartViewModel = buildDashboardV4ChartViewModel(packet)
  assert(viewModel.title === '2330 TSMC', 'view model should expose stock title')
  assert(viewModel.subtitle === 'TWSE · 2026-05-16 02:00', 'view model should expose market and freshness')
  assert(viewModel.candles[0].time === '2026-05-14', 'candles should be sorted ascending')
  assert(viewModel.volume[1].value === 5000, 'volume should stay aligned with sorted candle order')
  assert(viewModel.modelMarkers.length === 2, 'model markers should be carried through')
  assert(viewModel.sectorFlow[0].color === '#10b981', 'negative sector flow should render green')
  assert(viewModel.sectorFlow[1].color === '#ef4444', 'positive sector flow should render red')
  assertDeepEqual(viewModel.lanes.map((lane) => [lane.id, lane.status, lane.value]), [
    ['price', 'ok', '2'],
    ['model_signals', 'ok', '2'],
    ['regime', 'ok', 'bull_market'],
    ['data_quality', 'warn', 'warn'],
    ['finlab_diff', 'warn', '2'],
    ['preview_blocked_reasons', 'error', '2'],
  ], 'summary lanes should make key evidence scan-friendly')
}

{
  const summary = summarizeDashboardV4Packet(packet)
  assert(summary.hasExternalWidget === false, 'summary should reject external widgets by default')
  assert(summary.mainQuestion === 'price_model_regime_quality', 'summary should identify the chart purpose')
  assert(summary.warningCount === 3, 'summary should count warn/error context')
}
