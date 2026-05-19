# Dashboard V4 Contract

## Scope

V4-27 defines the StockVision-owned dashboard data contract for a future
Lightweight Charts renderer.

This slice does not install or render `lightweight-charts` directly. It creates
the Worker/API packet that the renderer should consume.

## Policy

```text
schemaVersion = dashboard-v4-chart-contract-v1
chartLibrary = lightweight-charts
dataOwner = stockvision_owned
externalWidgetsAllowed = false
```

TradingView Widgets may be referenced as product inspiration only. Dashboard V4
must not use external widget scripts or external widget data as the source of
truth.

## API

```text
GET /api/dashboard/v4/stocks/:id/chart
```

The route is implemented in:

```text
worker/src/routes/dashboardReadRoutes.ts
worker/src/lib/dashboardV4Contract.ts
frontend/src/lib/api.ts
```

The frontend client is:

```text
dashboardV4Api.stockChart(stockId, { days, date })
```

## Panels

Dashboard V4 must expose these panels from one packet:

| Panel | Source | Ownership |
|---|---|---|
| `price` | `stock_prices` | StockVision D1 |
| `model_signals` | `predictions` | StockVision D1 |
| `regime` | `market_regime_state` | StockVision KV |
| `sector_flow` | `sector_flow` | StockVision D1 |
| `data_quality` | `buildDataQualityReport` | StockVision Worker |
| `finlab_diff` | `finlab:v4:latest_diff` shadow payload | StockVision FinLab shadow/audit |
| `preview_blocked_reasons` | `paper_execution_events` | StockVision D1 |

## Lightweight Charts Packet

The packet is already shaped for a renderer:

```text
series.priceCandles -> CandlestickSeries
series.volumeHistogram -> HistogramSeries
series.modelMarkers -> createSeriesMarkers
series.sectorFlow -> HistogramSeries lower pane
regimeOverlay -> StockVision overlay metadata
dataQuality -> status badges
finlabDiff -> shadow/audit panel
previewBlockedReasons -> blocked/warning/error preview reasons
```

Invalid OHLC rows are dropped before they reach the chart packet. This prevents
null values from being coerced into zero-price candles.

## FinLab Boundary

FinLab may appear in Dashboard V4 through:

```text
finlabDiff.mode = shadow_audit_only
previewBlockedReasons.source = finlab_preview / finlab_execution_preview
```

FinLab does not own:

```text
price candles
model signals
regime labels
sector flow
data quality status
paper fills
real-order submission
```

## Validation

Implemented tests:

```text
worker/src/lib/dashboardV4Contract.test.ts
```

The contract rejects:

```text
non-lightweight chart library
external widget URLs
non-StockVision source ownership
```

## Next UI Step

The next UI slice can add a dedicated renderer component after dependency
selection is explicit:

```text
frontend dependency: lightweight-charts
component: DashboardV4LightweightChart
input: DashboardV4ChartPacket
```
