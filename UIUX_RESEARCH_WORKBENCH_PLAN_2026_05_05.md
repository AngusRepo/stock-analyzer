# StockVision Research Workbench UI/UX Plan

Date: 2026-05-05
Status: Demo-first plan, no production API or deploy changes

## Goal

Create a demo research layer that shows how StockVision can move from a stock-first dashboard into a topic-first research product while preserving the existing ML, recommendation, risk, and execution systems.

The demo should make three views feel connected:

- Topic Workspace
- Daily Focus
- Stock Research Page

## Design Direction

Use a hybrid visual language:

- Research terminal structure for dense scanning, provenance, and analyst workflows.
- Productized readability for topic cards, daily focus, and investor-facing summaries.
- Keep the experience operational, not marketing-led.
- Use static demo data first. Do not touch production APIs, D1 contracts, scheduler behavior, ML prediction paths, retrain paths, or paper trading.

## Refactor Pack 2026-V1 Integration

### Strategic Positioning

StockVision should feel like a professional quantitative operations terminal, not an entry-level stock dashboard. The long-term product identity combines:

- High-frequency trading observation.
- AI agent decision workflows.
- Infrastructure and data-pipeline monitoring.
- Topic-first market research.

Reference systems:

- Bloomberg Terminal for dense, multi-window information layout.
- Grafana for infrastructure and telemetry dashboard logic.
- VisualHFT for low-latency market-state presentation.

### Design Tokens

The demo should align with the Industrial Dark baseline:

```json
{
  "theme": "Industrial Dark",
  "palette": {
    "background": "#0a0a0c",
    "surface": "#16161e",
    "border": "#2d2d3a",
    "accent_primary": "#3b82f6",
    "success": "#10b981",
    "danger": "#ef4444",
    "warning": "#f59e0b"
  },
  "typography": {
    "font_main": "Inter, sans-serif",
    "font_data": "JetBrains Mono, monospace"
  },
  "components": {
    "card_radius": "4px",
    "table_density": "compact"
  }
}
```

Implementation note: the existing frontend already uses Inter, JetBrains Mono, Tailwind, and Radix UI. The demo should reuse those before introducing new UI dependencies.

### State And Windowing Architecture

The requested direction is valid, but it should be staged:

- `Jotai` or `Zustand` is suitable for high-frequency atomic market state.
- `flexlayout-react` is suitable for a future multi-window terminal shell.
- Neither dependency is currently present in `frontend/package.json`, so the demo should not add them yet.
- First prove the IA and visual density with static panels, then evaluate dependency cost before adding a true dockable workspace.

Candidate future state atoms:

```ts
marketTickAtom
aiDebateLogAtom
pipelineHealthAtom
localLlmTelemetryAtom
topicPulseAtom
```

Candidate window modules:

- Topic Workspace
- Daily Focus
- Stock Research
- AI Debate Arena
- Local LLM Telemetry
- Cloudflare / D1 Flow Monitor
- R&D Lab Mode

### Observability Requirements

Future production UI should include:

- Local LLM telemetry: memory pressure for 96GB unified memory, current model occupancy, TPS, and temperature.
- Edge infrastructure flow: Cloudflare Workers, D1, KV, Modal, GCS, and Polars data handoff status.
- Adaptive thresholds: confidence bands on price or signal charts that resize with threshold changes.
- Subtle data-change flash for fresh pipeline or D1 writes, without decorative animation.

### R&D Lab Mode

Add a future experimental mode that hides regular price charts and shows:

- AI agent decision topology.
- Debate weights across Gemini, Claude, internal ML, and policy layers.
- Reasoning-chain provenance.
- Model confidence and veto paths.

This should remain separate from production recommendation display so research experiments do not blur live decision semantics.

## Demo Route

Add a hidden route:

```txt
/demo/research-workbench
```

This route is intentionally not added to the primary sidebar yet. It is for review and iteration before any production IA decision.

## Information Architecture

### Shell

- Left rail: topic groups and market lenses.
- Top bar: market date, update status, and source coverage.
- Main panel: three-tab research workspace.
- Right rail: daily focus queue, data provenance, and next action summary.

### Topic Workspace

Purpose: Make topic research a first-class entry point.

Components:

- Topic summary band with heat, momentum, news pulse, chip pressure, and ML alignment.
- Topic constituent table.
- Topic catalysts.
- Topic relationship strip.
### Daily Focus

Purpose: Turn fragmented news, chip, and market movement into a single morning review.

Components:

- Focus queue: news-driven, capital-flow-driven, strength-driven.
- Large-holder and margin change highlights.
- Source tags for TWSE, TPEX, TAIFEX, Anue, MOPS, FinMind sidecar, and internal ML.

### Stock Research

Purpose: Give each stock a fixed research container rather than scattering charts and panels.

Components:

- Stock identity and topic membership.
- ML score, signal, confidence, and provenance.
- Technical, chip, margin, news, MOPS, and risk summary lanes.
- Related stocks and topic exposure.

## Data Source Strategy

### Core Official Sources

- TWSE OpenAPI
- TPEX OpenAPI
- TAIFEX OpenAPI

### Research Supplements

- Existing Anue ingestion
- Existing PTT buzz
- Existing Yahoo fallback
- FinMind as sidecar, not a replacement for production contracts
- MOPS normalized event layer

### Commercial / Licensed Candidates

- Economic Daily News
- CNA
- Broker reports

## Implementation Phases

### Phase 1: Demo Only

- Add hidden route.
- Add static mock data.
- Build three connected views.
- Run frontend build.

### Phase 2: Read-Only Data Wiring

- Add research aggregation endpoints.
- Keep ML and recommendation contracts unchanged.
- Populate demo with live read-only data.

### Phase 3: Navigation Integration

- Add research entry to sidebar.
- Link recommendations to topic and stock research pages.
- Add topic links from stock reports.

### Phase 4: Production Hardening

- Add source freshness indicators.
- Add empty states and stale-data states.
- Add permission model if broker reports or commercial news are introduced.

### Phase 5: Terminal Shell Evaluation

- Evaluate `Jotai` vs `Zustand` for high-frequency UI state.
- Evaluate `flexlayout-react` for dockable terminal panels.
- Prototype `AI Debate Arena`, `Local LLM Telemetry`, and `Edge Flow Monitor` as separate panels.
- Keep this behind a lab flag until performance and dependency cost are clear.

## Non-Goals

- No deploy in this phase.
- No retrain.
- No D1 schema migration.
- No replacement of `/predict/v2`.
- No rewrite of existing dashboard.
- No direct scraping of disallowed aistockmap data or APIs.
- No new frontend state/windowing dependency until a separate technical review approves it.

## Acceptance Criteria

- Demo route renders three connected views.
- Demo uses no production API calls.
- Demo works on desktop and mobile widths.
- `npm run build` passes.
- The page makes topic research, daily focus, and stock research feel like one product layer.
