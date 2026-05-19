import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  buildDashboardV4ChartPacket,
  buildDashboardV4Policy,
  validateDashboardV4Contract,
} from './dashboardV4Contract'

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

{
  const policy = buildDashboardV4Policy()
  assert(policy.schemaVersion === 'dashboard-v4-chart-contract-v1', 'Dashboard V4 should expose a stable contract version')
  assert(policy.chartLibrary === 'lightweight-charts', 'Dashboard V4 should target Lightweight Charts')
  assert(policy.dataOwner === 'stockvision_owned', 'Dashboard V4 should use StockVision-owned data')
  assert(policy.externalWidgetsAllowed === false, 'Dashboard V4 should not depend on external widgets')
  assertDeepEqual(policy.requiredPanels, [
    'price',
    'model_signals',
    'regime',
    'sector_flow',
    'data_quality',
    'finlab_diff',
    'preview_blocked_reasons',
  ], 'Dashboard V4 should expose all required panels')
}

{
  const packet = buildDashboardV4ChartPacket({
    stock: { id: 1, symbol: '2330', name: 'TSMC', market: 'TWSE' },
    generatedAt: '2026-05-16T01:00:00.000Z',
    priceRows: [
      { date: '2026-05-15', open: 100, high: 110, low: 99, close: 108, volume: 5000 },
      { date: '2026-05-14', open: 95, high: 101, low: 94, close: 100, volume: 3000 },
      { date: '2026-05-13', open: null, high: 101, low: 94, close: 99, volume: 1000 },
    ],
    modelSignals: [
      { prediction_date: '2026-05-15', trade_signal: 'buy', model_name: 'ensemble', direction_accuracy: 0.72 },
      { prediction_date: '2026-05-14', trade_signal: 'hold', model_name: 'ensemble', direction_accuracy: 0.55 },
      { prediction_date: '2026-05-13', trade_signal: 'sell', model_name: 'risk_overlay', direction_accuracy: 0.61 },
    ],
    regimeState: {
      schema_version: 'market-regime-state-v1',
      label: 'bull_market',
      family: 'bull',
      run_date: '2026-05-15',
      computed_at: '2026-05-15T08:00:00.000Z',
      regime_surface: { bull: 0.7, sideways: 0.2 },
      transition_guard: { status: 'confirmed' },
      monitors: { hawkes: 'watch' },
    },
    sectorFlowRows: [
      { date: '2026-05-15', sector: 'Semiconductor', classification: 'industry', total_net: 1200, foreign_net: 900, trust_net: 300 },
      { date: '2026-05-14', sector: 'Semiconductor', classification: 'industry', total_net: -100, foreign_net: -50, trust_net: -50 },
    ],
    dataQuality: {
      overall: 'warn',
      checks: [
        { id: 'finlab_price_freshness', status: 'ok', summary: 'fresh' },
        { id: 'feature_lake_missing', status: 'warn', summary: 'sidecar missing 3 fields' },
      ],
    },
    finlabDiffRows: [
      { lane: 'parity', source: 'finlab', status: 'shadow', matchedFields: 88, missingFields: 2 },
    ],
    previewEvents: [
      { event_type: 'finlab_preview', status: 'blocked', reason: 'insufficient_settlement_cash', created_at: '2026-05-15T01:00:00Z' },
      { event_type: 'paper_order', status: 'filled', reason: 'stockvision_fill', created_at: '2026-05-15T02:00:00Z' },
      { event_type: 'finlab_execution_preview', status: 'warning', reason: 'broker preview caution', created_at: '2026-05-15T03:00:00Z' },
    ],
  })

  assert(packet.chartLibrary === 'lightweight-charts', 'packet should stay Lightweight Charts ready')
  assert(packet.externalWidgetUrls.length === 0, 'packet should not include external widget URLs')
  assertDeepEqual(packet.series.priceCandles.map((row) => row.time), ['2026-05-14', '2026-05-15'], 'candles should be valid and sorted')
  assertDeepEqual(packet.series.modelMarkers.map((marker) => [marker.time, marker.position, marker.shape]), [
    ['2026-05-13', 'aboveBar', 'arrowDown'],
    ['2026-05-15', 'belowBar', 'arrowUp'],
  ], 'buy/sell model signals should become chart markers')
  assert(packet.regimeOverlay?.source === 'market_regime_state', 'regime overlay should use market_regime_state')
  assert(packet.dataQuality.overall === 'warn', 'data quality should remain visible')
  assert(packet.finlabDiff.rows[0]?.status === 'shadow', 'FinLab diff should stay a shadow/audit panel')
  assertDeepEqual(packet.previewBlockedReasons.map((row) => row.reason), [
    'broker preview caution',
    'insufficient_settlement_cash',
  ], 'FinLab preview blocked/warning reasons should be visible without duplicating fills')
  assert(validateDashboardV4Contract(packet).length === 0, 'valid Dashboard V4 packet should pass contract validation')
}

{
  const packet = buildDashboardV4ChartPacket({
    stock: { id: 1, symbol: '2330', name: 'TSMC', market: 'TWSE' },
    priceRows: [],
  })
  const invalid = {
    ...packet,
    chartLibrary: 'tradingview-widget',
    externalWidgetUrls: ['https://s3.tradingview.com/tv.js'],
    sourceOwnership: {
      ...packet.sourceOwnership,
      price: 'tradingview_widget',
    },
  }

  assertDeepEqual(validateDashboardV4Contract(invalid as any), [
    'dashboard_v4_must_use_lightweight_charts',
    'dashboard_v4_must_not_include_external_widget_urls',
    'dashboard_v4_must_use_stockvision_owned_sources',
  ], 'Dashboard V4 should reject external widget ownership')
}

{
  const root = fs.existsSync(path.join(process.cwd(), 'worker'))
    ? process.cwd()
    : path.join(process.cwd(), '..')
  const dashboardReadRoutes = fs.readFileSync(path.join(root, 'worker', 'src', 'routes', 'dashboardReadRoutes.ts'), 'utf8')
  const frontendApi = fs.readFileSync(path.join(root, 'frontend', 'src', 'lib', 'api.ts'), 'utf8')
  assert(dashboardReadRoutes.includes('/api/dashboard/v4/stocks/:id/chart'), 'Worker should expose Dashboard V4 chart packet API')
  assert(dashboardReadRoutes.includes('buildDashboardV4ChartPacket'), 'Dashboard V4 route should use the contract builder')
  assert(frontendApi.includes('DashboardV4ChartPacket'), 'Frontend API should expose Dashboard V4 chart packet type')
  assert(frontendApi.includes('dashboardV4Api'), 'Frontend API should expose Dashboard V4 API client')
  assert(frontendApi.includes('/dashboard/v4/stocks/'), 'Frontend Dashboard V4 API should call the Worker chart packet route')
}
