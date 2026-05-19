# Frontend Lightweight Charts / Readability Audit

## Scope

This audit extends Dashboard V4 beyond the dashboard route. The goal is to
reduce text-heavy pages and turn StockVision into a trading / ML operations
workstation where the operator can scan state, trend, evidence, and blockers
before reading raw details.

This audit now includes the first P0 implementation slice. The frontend uses
`lightweight-charts@5.2.0` for high-density StockVision-owned time-series
workbenches while retaining Recharts for categorical summaries and existing
small charts.

License decision:

```text
lightweight-charts@5.2.0 license: Apache-2.0
decision: accepted for StockVision frontend use
guard: p0WorkstationChartWiring.test.ts verifies version 5.2.0 and Apache-2.0
```

## Source Inputs

Repo pages inspected:

```text
frontend/src/pages/Dashboard.tsx
frontend/src/pages/BotDashboard.tsx
frontend/src/pages/DataQualityPage.tsx
frontend/src/pages/ModelPoolPage.tsx
frontend/src/pages/ObservabilityPage.tsx
frontend/src/pages/PipelinePage.tsx
frontend/src/pages/SchedulerPage.tsx
frontend/src/pages/StockReportPage.tsx
frontend/src/pages/StrategyLabPage.tsx
frontend/src/pages/NotFound.tsx
frontend/src/pages/Unauthorized.tsx
```

Reference patterns:

```text
Edge Impulse model-performance visualization:
  https://www.iotcentral.io/blog-all/a-hrefvisualizing-ml-model-performance-with-edge-impulsea

Studio/ml management system:
  https://www.behance.net/gallery/145482879/Studioml-Management-System-for-ML-Models
  https://fuselabcreative.com/our-projects/studio-ml/

TradingView Lightweight Charts:
  https://tradingview.github.io/lightweight-charts/tutorials/how_to/panes
  https://www.tradingview.com/charting-library-docs/latest/getting_started/product-comparison/
```

## Reference Takeaways

### Edge Impulse Pattern

The useful idea is not the visual style. The useful idea is turning model
quality from summary numbers into operator-readable spatial / temporal evidence.

Adopt:

```text
accuracy/F1/confusion numbers -> misclassification and drift evidence
model-result text -> visual error clusters
model comparison -> compact candidate-vs-baseline panel
training result -> drillable evidence surface
```

StockVision mapping:

```text
ML Pool:
  champion vs challenger IC
  segment IC gaps
  shadow evidence coverage
  model-family diversity
  validation blockers

Strategy Lab:
  dry-run hit-rate
  walk-forward result
  reward ledger
  gate pass/fail
  regime split
```

### Studio/ml Pattern

Studio/ml is relevant for ML Pool and Strategy Lab because it presents ML work as
an operational system, not as prose. The key patterns are project status,
experiment comparison, clickable controls, status blocks, progress meters,
color-coded model artifacts, and real-time train visuals.

Adopt:

```text
one screen for high-level status and results
interactive sidebar / inspector for controls
status blocks with visible completion graphics
color-coded artifacts
train / experiment visuals with precision, accuracy, sensitivity, loss
drill-down only after the visual summary
```

Reject:

```text
marketing-style gradients
decorative hero sections
large card mosaics without a primary work surface
```

### Lightweight Charts Boundary

Lightweight Charts is a good fit for high-density time-series views. It supports
small interactive financial charts, custom data input, candlesticks, histograms,
series markers, range selectors, legends, and panes.

Important boundary:

```text
Lightweight Charts does not provide market data.
StockVision must provide every data point from its own Worker/D1/KV/FinLab
shadow contracts.
TradingView Widgets remain product-reference only because widgets cannot use
StockVision-owned data.
```

Use Lightweight Charts for:

```text
OHLCV / volume
equity curve / benchmark
model signal markers
regime bands
pipeline run timeline
data-quality trend
shadow/live comparison over time
strategy dry-run and reward ledger timelines
```

Keep Recharts or simple SVG for:

```text
categorical bars
RRG scatter
small static gauges
leaderboard tables
non-temporal score summaries
```

## Current Page Density Findings

Measured with simple TSX token counts. These are not exact rendered DOM counts,
but they identify where users are likely feeling visual overload.

| Page | Lines | Paragraph Tokens | Card-like Tokens | Badge Tokens | Chart Tokens | Main Issue |
|---|---:|---:|---:|---:|---:|---|
| `BotDashboard.tsx` | 1452 | 32 | 27 | 55 | 17 | Many badges / panels; already has charts but the trade lifecycle is still text-heavy. |
| `Dashboard.tsx` | 851 | 36 | 30 | 11 | 22 | Existing chart tabs are fragmented Recharts cards; no unified chart workbench yet. |
| `DataQualityPage.tsx` | 175 | 7 | 1 | 0 | 0 | Clean page, but lacks trend / missingness visual context. |
| `ModelPoolPage.tsx` | 1387 | 75 | 7 | 0 | 0 | Highest prose density; ML evidence is hidden inside text matrices. |
| `ObservabilityPage.tsx` | 651 | 54 | 8 | 0 | 0 | Observability is mostly text rows; should be incident/time/event visual first. |
| `PipelinePage.tsx` | 482 | 10 | 13 | 13 | 0 | Good flow concept, but daily process should be a visual run lane. |
| `SchedulerPage.tsx` | 296 | 14 | 6 | 0 | 0 | Has history strips, but no real timeline / duration trend. |
| `StockReportPage.tsx` | 417 | 16 | 2 | 0 | 3 | Report is still prose-led; should share stock chart packet. |
| `StrategyLabPage.tsx` | 710 | 7 | 43 | 25 | 0 | Card-heavy; strategy status needs experiment visuals and fewer nested cards. |
| `NotFound.tsx` | 53 | 1 | 3 | 0 | 0 | No chart needed. |
| `Unauthorized.tsx` | 73 | 1 | 1 | 0 | 0 | No chart needed. |

## Visual Architecture Rule

Use a consistent workstation layout:

```text
top:
  compact health / context strip

center:
  primary visual surface

right:
  inspector / selected item details / actions

bottom:
  raw table / evidence log / drilldown
```

Replace prose by default:

```text
paragraph -> metric tile, marker, tooltip, drawer, or row inspector
badge cluster -> segmented status lane
card mosaic -> one primary chart plus compact side panels
raw JSON/pre -> collapsible evidence drawer
long explanation -> one-line decision reason + "details" affordance
```

## Page-by-Page Recommendations

### Dashboard

Current state:

```text
Uses StockPriceChart, CandlestickChart, ChipChart, MarginChart, TechnicalChart.
These are separate Recharts cards under tabs.
Dashboard V4 already has a Worker chart packet contract:
  /api/dashboard/v4/stocks/:id/chart
```

Recommended chart usage:

```text
P0:
  Replace the fragmented stock chart tab with DashboardV4LightweightChart.
  Use one multi-pane chart:
    pane 0: candlestick + model buy/sell markers + regime bands
    pane 1: volume histogram
    pane 2: chips / margin / sector-flow histogram
    side panel: FinLab shadow diff and preview blocked reasons

P1:
  Let StockReportPage reuse the same chart packet.
  Move AI long-form text into event markers and collapsible note drawer.
```

Expected readability gain:

```text
fewer chart cards
one timeline for price, model, regime, chip, data-quality evidence
less tab hopping
```

### Bot Dashboard

Current state:

```text
Already uses PerformanceChart and CandlestickChart. V4-27A P1F replaces the
paper-trade performance Recharts surface with a Lightweight Charts workbench.
Badge density is high because pending-buy / execution / partial-fill state is
encoded as many small badges.
```

Recommended chart usage:

```text
P1:
  Convert paper-trade equity curve to Lightweight line/area series.
  Overlay benchmark and drawdown pane.
  Add execution markers:
    pending_buy_created
    quote_sanity_passed
    paper_filled
    finlab_preview_blocked
    partial_fill_remaining

P1:
  Replace many execution badges with a horizontal lifecycle lane:
    candidate -> debate -> quote sanity -> preview -> paper fill -> exit

P2:
  Use selected-stock candlestick pane to display order intent, fill, stop, and
  take-profit markers.
```

Expected readability gain:

```text
trade lifecycle becomes visible in time order
FinLab preview warnings can be seen as markers, not buried text
badge noise drops
```

### 2026-05-16 P1F Bot Dashboard Slice

Implemented:

```text
component:
  frontend/src/components/charts/PaperTradePerformanceChart.tsx

test:
  frontend/src/lib/botDashboardChartWiring.test.ts

page:
  BotDashboard.tsx PerformanceChart now renders PaperTradePerformanceChart
  instead of the previous Recharts AreaChart.
```

Data source boundary:

```text
Uses existing paperApi.pnl(), paperApi.orders(200), and paperApi.pendingBuys()
payloads only.
No new API, no real order action, no FinLab order submission.
The visual layer turns PnL snapshots into bot / 0050 / TWII series, drawdown
histogram, and order / pending-buy markers.
```

Expected readability gain:

```text
Bot Dashboard answers the first paper-trading question visually:
  did equity move with or against benchmark, and which execution events happened
  around those moves?

The existing positions, candidate list, and order table remain as drilldown
detail.
```

### Model Pool

Current state:

```text
Most text-heavy page.
0 chart tokens despite being the page where time-series model health matters.
Contains champion pointers, registry, promotion queue, live shadow evidence,
artifact diffs, lifecycle summary, serving diagnostics, and upgrade track panels.
```

Recommended chart usage:

```text
P0:
  Build ModelPoolMissionControl layout inspired by Studio/ml:
    top strip: champion ready, blocked, shadow slots, weak IC, family balance
    center chart: champion vs candidate IC timeline
    right inspector: selected model artifact / action context / blockers
    bottom table: registry rows

P0:
  Add LightweightChartModelHealth:
    line series: champion IC, shadow IC, rolling IC
    histogram pane: sample count / coverage
    markers: artifact registered, offline pass, live shadow start, blocked,
             approval required, promoted

P1:
  Add segment IC heatmap or compact matrix outside Lightweight Charts.
  Add family-balance stacked bar outside Lightweight Charts.

P2:
  Add Edge-Impulse-style error explorer for model disagreement:
    x: prediction confidence
    y: realized return / rank outcome
    color: model family / correct vs wrong
```

Expected readability gain:

```text
promotion state becomes a visual lifecycle
operator can see whether the candidate actually beats champion
paragraph explanations move to selected-model inspector
```

### Strategy Lab

Current state:

```text
Card-heavy rather than paragraph-heavy.
0 chart tokens.
Strategy specs, meta learning, gates, experiments, and raw JSON are all shown
as separate cards.
```

Recommended chart usage:

```text
P0:
  Build StrategyExperimentWorkbench:
    top strip: active specs, dry-run pass rate, approval-required count,
               reward-ledger ready count, shadow policies
    center chart: dry-run match rate / OOS IC / reward ledger over time
    right inspector: selected strategy thresholds and gate blockers
    bottom grid: experiments and evaluation runs

P0:
  Add LightweightStrategyTimeline:
    line series: match rate, OOS IC, reward score
    histogram pane: sample size / trades / turnover
    markers: experiment created, dry-run, evaluation run, gate blocked,
             approval required

P1:
  Replace raw `pre` JSON panels with collapsible evidence drawers.
  Convert threshold badge clusters to compact condition rows.

P2:
  Add regime-split comparison view:
    trend, volatile, bear, liquidity stress, event-risk
```

Expected readability gain:

```text
strategy experiments become comparable
dry-run and reward-ledger drift is visible
raw text no longer dominates the page
```

### Observability

Current state:

```text
Many scheduler/data-quality/adaptive-meta descriptions are row text.
Existing MiniBar and Sparkline are hand-rolled SVG helpers.
```

Recommended chart usage:

```text
P1:
  Add ObservabilityEventTimeline:
    histogram: events by severity
    line: data-quality score
    markers: incidents, failed jobs, schema drift, adaptive threshold changes

P1:
  Use a severity swimlane:
    pipeline, scheduler, data-quality, ML, paper trade, external evidence

P2:
  Keep deep explanations in row inspector.
```

Expected readability gain:

```text
operator sees when failures cluster
text rows become drilldown instead of primary content
```

### Pipeline

Current state:

```text
Good daily-flow concept. V4-27A P1D now adds a DailyPipelineRunLane before
the column lists so the page is chart/evidence-led first.
```

Recommended chart usage:

```text
P1:
  Add DailyPipelineRunLane:
    horizontal timeline: universe -> screener -> ML -> recommendation ->
                         paper-preview
    line: candidate funnel count
    histogram: attrition / blocker count
    markers: fallback / human-review / guardrail attention

P1:
  Add candidate funnel:
    screener count -> ML buy/hold -> recommendation -> pending buy -> filled
```

Expected readability gain:

```text
daily pipeline becomes a process monitor
reason prose moves into selected-step inspector
```

### 2026-05-16 P1D Pipeline Slice

Implemented:

```text
component:
  frontend/src/components/charts/DailyPipelineRunLane.tsx

test:
  frontend/src/lib/pipelineChartWiring.test.ts

page:
  PipelinePage.tsx now renders a Pipeline Visual Workbench after the page
  header and before the old flow indicator / four-column detail lists.
```

Data source boundary:

```text
Uses existing recommendationsApi.daily(), paperApi.pendingBuys(), and
paperApi.quadrantFilter() payloads only.
No new API, no scheduler mutation, no bypass of the existing auth gate.
The visual layer consumes recommendations, ML signals, pending buys, and RRG /
guardrail filter evidence.
```

Expected readability gain:

```text
Pipeline answers the first operator question visually:
  where did the candidate pool shrink, and did anything reach pending buy?

The existing sector, ML, recommendation, and T2 debate lists remain as
drilldown detail rather than being the first read.
```

### Scheduler

Current state:

```text
Has HistoryStrip and PipelineDag. V4-27A P1C now adds a first-screen
SchedulerCadenceChart so duration / cadence risk is not trapped in rows.
```

Recommended chart usage:

```text
P1:
  Add SchedulerCadenceChart:
    line: 7d success/cadence score from history7d
    histogram: failed density plus current suspicious-duration risk
    markers: failed days and low-SLO days
    side panel: failed / suspicious-duration jobs

P1:
  Use a calendar heat strip for last 30 runs.
```

Expected readability gain:

```text
suspicious duration and repeated failures become obvious
dependency DAG stays as structural view
```

### Data Quality

Current state:

```text
Compact, readable, but it only shows current checks.
No trend or missingness chart.
```

Recommended chart usage:

```text
P1:
  Add DataQualityTrendChart:
    line: quality score
    histogram: fail/warn/pass count
    markers: schema drift, backfill, source outage

P1:
  Add missingness heatmap outside Lightweight Charts:
    source x feature-family matrix
```

Expected readability gain:

```text
quality degradation is seen before it becomes a downstream ML warning
```

### Stock Report

Current state:

```text
Report page duplicates AI-report content and remains prose-led. V4-27A P1E
now reuses the Dashboard V4 chart packet before LLM / prose sections.
```

Recommended chart usage:

```text
P1:
  Reuse DashboardV4ChartPacket.
  Show price, model markers, regime bands, chip/margin panes, and data-quality
  markers before any generated text.

P2:
  Convert LLM sections to source-linked event annotations and collapsed notes.
```

Expected readability gain:

```text
the report becomes price/model/regime/data-quality evidence-first
AI prose becomes supporting detail
```

### 2026-05-16 P1E Stock Report Slice

Implemented:

```text
component reuse:
  frontend/src/components/charts/DashboardV4LightweightChart.tsx

test:
  frontend/src/lib/stockReportChartWiring.test.ts

page:
  StockReportPage.tsx now fetches dashboardV4Api.stockChart(stockId, { days: 365 })
  and renders DashboardV4LightweightChart before the signal / model / LLM prose
  sections.
```

Data source boundary:

```text
Uses the existing DashboardV4ChartPacket from StockVision Worker only.
No TradingView Widget, no external widget source, no new report-specific chart
contract.
```

Expected readability gain:

```text
The individual report answers the first operator question visually:
  what did price, model markers, regime, quality, and preview guardrails say?

The generated analyst text remains available, but it no longer owns the first
screen.
```

### Not Found / Unauthorized

Recommended chart usage:

```text
Reject:
  No Lightweight Charts needed.
  Keep pages simple and reduce decorative card wrappers if touched later.
```

## Implementation Slices

### P0 - First UI Slice

```text
1. Add frontend dependency:
   lightweight-charts@5.2.0

   License note:
   package metadata declares Apache-2.0, which Wei explicitly accepts for this
   frontend charting layer.

2. Add shared wrapper:
   frontend/src/components/charts/LightweightChartCore.tsx

3. Add first domain components:
   frontend/src/components/charts/DashboardV4LightweightChart.tsx
   frontend/src/components/charts/ModelPoolHealthChart.tsx
   frontend/src/components/charts/StrategyExperimentTimeline.tsx

4. Apply to:
   Dashboard.tsx
   ModelPoolPage.tsx
   StrategyLabPage.tsx
```

Why this order:

```text
Dashboard already has the V4 data packet.
ModelPoolPage and StrategyLabPage are the most visually underserved pages.
The user explicitly called out ML Pool and Strategy Lab.
```

### P1 - Operations Pages

```text
ObservabilityPage.tsx:
  event timeline and severity histogram

PipelinePage.tsx:
  run lane and funnel

SchedulerPage.tsx:
  cadence / duration chart

DataQualityPage.tsx:
  quality trend and missingness heatmap

BotDashboard.tsx:
  equity curve, drawdown pane, execution markers
```

### 2026-05-16 P1A Data Quality Slice

Implemented:

```text
component:
  frontend/src/components/charts/DataQualityTrendChart.tsx

test:
  frontend/src/lib/dataQualityChartWiring.test.ts

page:
  DataQualityPage.tsx now renders a Data Quality Visual Workbench above the
  textual gap rows.
```

Current boundary:

```text
The current Data Quality API returns one report snapshot, not historical trend.
The chart therefore renders current-check evidence as a score line, severity
histogram, and warn/fail markers anchored to the report generated date.

It explicitly discloses that it is not yet a historical trend. A true multi-day
quality trend should wait for the OperationsTimelinePacket / data-quality
history contract.
```

Expected readability gain:

```text
freshness, schema, train/serve parity, and feature-coverage failures become a
first-screen evidence surface before the operator reads all check rows.
```

### 2026-05-16 P1B Observability Slice

Implemented:

```text
component:
  frontend/src/components/charts/ObservabilityEventTimeline.tsx

test:
  frontend/src/lib/observabilityChartWiring.test.ts

page:
  ObservabilityPage.tsx now renders an Observability Visual Workbench directly
  after the page title and before adaptive/dependency/detail panels.
```

Data source boundary:

```text
Uses existing observabilityApi.events() / ObservabilityEventReport only.
No new API, no external widget, no synthetic operational incident store.
Event timestamps come from event.ts.
```

Expected readability gain:

```text
OBS answers the first operator question visually:
  where are warning/error events clustering?

The page can then keep scheduler rows, data-quality rows, adaptive evidence,
and dependency map as drilldowns instead of making text rows the first read.
```

### 2026-05-16 P1C Scheduler Slice

Implemented:

```text
component:
  frontend/src/components/charts/SchedulerCadenceChart.tsx

test:
  frontend/src/lib/schedulerChartWiring.test.ts

page:
  SchedulerPage.tsx now renders a Scheduler Visual Workbench after the metric
  strip and before the Daily Pipeline Chain.
```

Data source boundary:

```text
Uses existing schedulerApi.status() / SchedulerStatus only.
No new API, no external widget, no production scheduler mutation.
The visual layer consumes jobs[].history7d, stats.successRate7d,
lastStatus, lastDuration, and durationConcern.
```

Expected readability gain:

```text
Scheduler answers the first operator question visually:
  are recent runs stable, or are failures / suspicious durations clustering?

The existing pipeline DAG remains the structural dependency view, while the
chart becomes the health / cadence reading surface.
```

### P2 - Report / Drilldown Polish

```text
StockReportPage.tsx:
  evidence-first chart packet and collapsed AI notes

StockAIReport.tsx:
  short decision summary plus expandable reasoning

RecommendationCardClean.tsx:
  reduce long text blocks by moving provenance to hover / drawer
```

## Data Contracts Needed

Existing:

```text
DashboardV4ChartPacket
```

New recommended contracts:

```text
ModelPoolHealthPacket:
  schemaVersion
  generatedAt
  models[]
  championSeries[]
  challengerSeries[]
  sampleCoverage[]
  lifecycleMarkers[]
  blockers[]
  familyBalance[]

StrategyExperimentPacket:
  schemaVersion
  generatedAt
  strategies[]
  dryRunSeries[]
  rewardLedgerSeries[]
  evaluationMarkers[]
  gateBlockers[]

OperationsTimelinePacket:
  schemaVersion
  generatedAt
  events[]
  severityHistogram[]
  durationSeries[]
  dataQualitySeries[]
```

All packets should follow the Dashboard V4 rule:

```text
StockVision-owned data only.
External widgets cannot be data owner.
FinLab can appear through shadow/audit fields, not direct UI ownership.
```

## UI Acceptance Criteria

For each page migration:

```text
1. Above-the-fold text paragraphs are reduced by at least 40%.
2. Primary page question is answerable from chart/tiles without reading raw prose.
3. Raw JSON is hidden behind a drawer/collapse by default.
4. Mobile view keeps one primary chart and moves inspector below it.
5. Empty state explains missing data in one sentence.
6. No TradingView widget scripts are used.
7. Playwright screenshot verifies chart is nonblank at desktop and mobile widths.
```

## Decision

Adopt Lightweight Charts, but do it as a shared StockVision chart layer rather
than a dashboard-only embellishment.

Priority:

```text
P0:
  Dashboard
  ML Pool
  Strategy Lab

P1:
  Bot Dashboard
  Observability
  Pipeline
  Scheduler
  Data Quality

P2:
  Stock Report / AI report drilldowns

Reject:
  Not Found
  Unauthorized
```

## Implementation Progress

### 2026-05-16 P0 Slice

Implemented:

```text
frontend dependency:
  lightweight-charts@5.2.0

shared mapping:
  frontend/src/lib/dashboardV4ChartViewModel.ts

tests:
  frontend/src/lib/dashboardV4ChartViewModel.test.ts
  frontend/src/lib/dashboardV4ChartWiring.test.ts
  frontend/src/lib/p0WorkstationChartWiring.test.ts

components:
  frontend/src/components/charts/DashboardV4LightweightChart.tsx
  frontend/src/components/charts/ModelPoolHealthChart.tsx
  frontend/src/components/charts/StrategyExperimentTimeline.tsx

pages:
  Dashboard.tsx now fetches dashboardV4Api.stockChart and renders
  DashboardV4LightweightChart in the chart tab.

  ModelPoolPage.tsx now renders ModelPoolHealthChart before the family-balance
  and registry sections.

  StrategyLabPage.tsx now renders StrategyExperimentTimeline after the top
  KPI strip and before the meta-learning decision desk.
```

Verification:

```text
node --experimental-strip-types src/lib/dashboardV4ChartViewModel.test.ts
node --experimental-strip-types src/lib/dashboardV4ChartWiring.test.ts
node --experimental-strip-types src/lib/p0WorkstationChartWiring.test.ts
npx tsc --noEmit -p tsconfig.json
npm run build
```

Local Playwright smoke:

```text
http://127.0.0.1:5173/
http://127.0.0.1:5173/ after quick-launch selecting 2330
http://127.0.0.1:5173/model-pool
http://127.0.0.1:5173/strategy-lab
```

The local smoke had no backend API, so Dashboard selected-stock chart rendering
showed the new chart surface but no live OHLC canvas. Model Pool and Strategy
Lab rendered their new chart slots as empty-state surfaces when admin/API data
returned errors. The next useful verification is a logged-in/backend-connected
pass with real chart packets and canvas pixel checks.

Follow-up adjustment:

```text
2026-05-16:
  npm audit --json now reports total vulnerabilities = 0.

  Strategy Lab empty state was upgraded from a small "No strategy specs
  available" line into a first-screen Strategy Visual Workbench, so the page is
  visibly different even when backend/admin APIs return Internal Server Error.

  License guard was corrected: lightweight-charts@5.2.0 is Apache-2.0, not MIT,
  and Wei explicitly accepts Apache-2.0 for this frontend charting layer.

  Model Pool empty state was also upgraded into an ML Pool Visual Workbench, so
  missing active lineage still shows weekly IC / sample coverage / promotion
  marker placeholders instead of one small fallback line.
```
