# StockVision UI/UX Current State Review

Date: 2026-05-05
Scope: Compare the current frontend with the Research Workbench demo and propose optimization steps.

## Executive Summary

The current UI is halfway between a consumer stock dashboard and an industrial trading workstation. The newer shell and workstation components already point in the right direction, but the product still feels uneven because the global shell, Dashboard, observability pages, and research layer do not share one clean information architecture.

The Research Workbench demo should not replace the current Dashboard directly. It should become the reference direction for a new research layer, while the existing Dashboard, Bot, OBS, Model Pool, and Strategy Lab are cleaned into a consistent terminal-style operating system.

## Current UI Strengths

- `AppShell` already has a terminal-like layout: fixed left rail, market ticker, command surface, admin-aware nav, compact top bar.
- `WorkstationChrome` introduces reusable workstation primitives: panel, pill, page title, and status tone.
- `ObservabilityPage` already follows the right mental model: incident inbox, scheduler, data quality, model health, resource views.
- The current app has rich domain modules: recommendation, bot, model pool, scheduler, data quality, pipeline, observability, and stock reports.
- The Research Workbench demo proves that topic research, daily focus, stock research, telemetry, and R&D lab concepts can live inside the same visual language.

## Current UI Problems

### 1. Information Architecture Is Still Split By Implementation, Not User Workflow

Current routes are mostly system modules:

- `/`
- `/bot`
- `/pipeline`
- `/scheduler`
- `/model-pool`
- `/data-quality`
- `/strategy-lab`
- `/obs`
- `/report/:symbol`

This is useful for operators, but users do not get a clear path for:

- Market research
- Today's focus
- Stock investigation
- AI decision provenance
- Execution readiness

Recommendation: keep the system routes, but add a product-level grouping:

- Research
- Decision
- Execution
- Operations
- Lab

### 2. Navigation Does Not Match Route Surface

`App.tsx` exposes `/pipeline`, `/scheduler`, and `/data-quality`, but `AppShell` currently does not surface every operational route in the main nav. This creates a mismatch between available pages and discoverable pages.

Recommendation: make the sidebar an explicit registry with section groups and admin gating:

- Research: Dashboard, Research Workbench, Stock Report
- Decision: Bot, Strategy Lab
- Operations: OBS, Pipeline, Scheduler, Data Quality, Model Pool

### 3. Visual Language Is Close, But Not Yet Systematic

Current shell uses amber, sky, rose, emerald, dark grid, and gradient surfaces. The demo introduces a cleaner Industrial Dark baseline with less decorative glow and denser panels.

Recommendation:

- Standardize tokens around `#0a0a0c`, `#16161e`, `#2d2d3a`, `#3b82f6`, `#10b981`, `#ef4444`, `#f59e0b`.
- Keep status colors semantic and sparse.
- Reduce decorative gradients and animated background emphasis.
- Use 4px panel radius and compact table density.

### 4. Dashboard Is Too Large And Too Mixed

`Dashboard.tsx` currently owns many responsibilities:

- watchlist
- hero
- charts
- chip and margin
- financials
- alerts
- factor analysis
- risk
- AI report
- news
- market risk
- recommendations
- admin users

Recommendation: split the Dashboard into route-level sections:

- `MarketOverview`
- `WatchlistRail`
- `StockWorkspace`
- `DecisionSummary`
- `ResearchDigest`

Then move topic and daily focus content into the Research Workbench instead of adding more panels to Dashboard.

### 5. Observability Has The Right Data, But Needs Cleaner Labels And Drilldown Design

`ObservabilityPage` is close to the desired Grafana-style operating center. The issue is presentation consistency and copy cleanliness. It should become the model for Operations pages after label cleanup.

Recommendation:

- Rename tabs with clean bilingual labels or English-only operator labels.
- Normalize incident cards, metric cells, scheduler rows, and drilldown panels.
- Keep raw logs out of first glance; provide one-click drilldown.

### 6. Demo Shows The Missing Research Layer

The Research Workbench demo covers the missing product layer:

- topic-first navigation
- daily focus queue
- stock research container
- source coverage
- local LLM telemetry
- R&D lab topology

Recommendation: do not force these concepts into Dashboard. Promote this into a real route after read-only data contracts are designed.

## Target UI Architecture

### Global Shell

Purpose: app-wide operating shell.

Should own:

- market ticker
- command/search entry
- user/auth state
- grouped navigation
- notification entry

Should not own:

- business-specific panels
- research cards
- route-specific data contracts

### Research Layer

Purpose: market understanding and investigation.

Routes:

- `/research`
- `/research/topic/:topicId`
- `/research/stock/:symbol`

Modules:

- topic workspace
- daily focus
- stock research
- source coverage
- MOPS/event stream
- news/topic mapping

### Decision Layer

Purpose: model output and recommendation provenance.

Routes:

- `/bot`
- `/strategy-lab`

Modules:

- ensemble_v2 signal
- confidence and score provenance
- debate / policy layers
- pending buy readiness

### Operations Layer

Purpose: infrastructure, data, scheduler, model health.

Routes:

- `/obs`
- `/pipeline`
- `/scheduler`
- `/data-quality`
- `/model-pool`

Modules:

- incident center
- data freshness
- pipeline execution
- model artifacts
- retrain status
- D1 / Cloudflare / Modal / GCS health

### Lab Layer

Purpose: experimental visualization and AI agent topology.

Routes:

- `/lab`

Modules:

- R&D Lab Mode
- AI Debate Arena
- agent weight topology
- local LLM telemetry
- adaptive threshold experiments

## Priority Recommendations

### P0: Clean The Current Surface

- Fix remaining mojibake and broken visible copy in Dashboard, AppShell, Observability, and workstation components.
- Align `AppShell` navigation with real routes.
- Remove or hide user-facing text that describes implementation state, such as "API logic unchanged" and "Workstation skin active".
- Keep demo route hidden until its data contract exists.

### P1: Standardize Design Tokens

- Add a small `frontend/src/lib/designTokens.ts` or CSS token section for Industrial Dark.
- Normalize panel border, surface, radius, type size, and status colors.
- Replace one-off gradient-heavy panel styling with shared workstation primitives.

### P1: Extract Dashboard Responsibilities

- Move Dashboard subareas into focused components.
- Keep Dashboard as a composed route, not a large owner file.
- Route research-specific concepts to the Research Workbench.

### P1: Create Research Data Contract

Before wiring live data, define a read-only contract:

- `topicRegistry`
- `dailyFocus`
- `stockResearchSummary`
- `sourceCoverage`
- `eventStream`
- `agentTopologyPreview`

This contract should aggregate existing sources without changing prediction, retrain, or paper trading paths.

### P2: Add Lab Mode Behind A Flag

- Do not add `flexlayout-react`, `Jotai`, or `Zustand` immediately.
- First validate UI needs with static panels.
- Then test whether high-frequency UI state needs atomic stores.

### P2: Upgrade Operations Pages

- OBS should become the canonical operations homepage.
- Pipeline, Scheduler, Data Quality, and Model Pool should become drilldown pages.
- All operation cards should use the same status tone vocabulary.

## Demo-To-Production Path

### Step 1: Review Demo

Use `/demo/research-workbench` to validate:

- density
- visual tone
- topic-first navigation
- daily focus usefulness
- right-rail telemetry / R&D concept

### Step 2: Make Route Official

Rename demo route to `/research` only after the read-only data contract is ready.

### Step 3: Wire Read-Only Data

Use existing sources first:

- TWSE / TPEX / TAIFEX
- Anue
- PTT buzz
- MOPS normalized events
- existing ML/recommendation output
- FinMind as sidecar only

### Step 4: Integrate Navigation

Add `Research` to `AppShell`, grouped under product-level sections.

### Step 5: Evaluate Terminal Dependencies

Only after route usefulness is proven:

- evaluate `Jotai` vs `Zustand`
- evaluate `flexlayout-react`
- build real dockable panels if the workflows justify it

## Immediate Next Implementation Batch

1. Clean visible copy and labels in `AppShell`, `Dashboard`, `ObservabilityPage`, and workstation components.
2. Create grouped navigation registry for `AppShell`.
3. Refactor `Dashboard.tsx` into smaller page sections.
4. Keep `/demo/research-workbench` as the visual target and iterate its layout.
5. Define a read-only `research` API contract before wiring live data.

## Non-Goals

- No deploy.
- No retrain.
- No paper trading behavior changes.
- No prediction path changes.
- No new state/windowing dependencies until dependency review.
- No direct scraping of disallowed third-party data paths.

## 2026-05-05 Wrap-Up Status

The latest implementation pass shifted the product direction away from a cold industrial terminal and toward a warmer personal quant companion. The system still preserves dense operational information, but the visible IA now centers on daily usage: morning overview, research room, paper trading companion, and system care.

Completed:

- `AppShell` now uses grouped navigation for daily work, action, and care surfaces.
- `/` is positioned as `晨間概覽` instead of a generic dashboard.
- `/research` is available as the official research room route while `/demo/research-workbench` remains compatible.
- `/bot`, `/obs`, `/pipeline`, `/scheduler`, `/data-quality`, `/model-pool`, and `/strategy-lab` have warmer visible labels and cleaner product copy.
- The unused legacy `TradingDecisionBoards.tsx` demo component was removed to avoid reintroducing the old terminal direction.
- Browser smoke QA found local lazy routes stuck on Suspense loading. Core pages now use static imports in `App.tsx` so the main entry points open reliably before commit/deploy.
- Full `frontend/src` text scan returned `old_phrase_hits=0` and `encoding_hits=0`.

Still recommended after this commit:

- Browser QA across desktop and mobile widths.
- Wire `/research` to a read-only data contract before adding any production behavior.
- Decide whether to keep short English kickers like `System care` and `Research room`.
- Split `Dashboard.tsx` into smaller modules once visual direction is accepted.
