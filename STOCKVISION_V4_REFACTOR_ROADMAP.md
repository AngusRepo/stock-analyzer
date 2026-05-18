# StockVision V4 Refactor Roadmap

## North Star

V4 moves StockVision to a FinLab-first structured data architecture while keeping StockVision's decision, risk, ML, backtest, paper-trade, and intraday ownership intact.

```text
FinLab SDK/API:
  primary structured daily data source and FinLab-native feature diversity lake

FinLab Skill:
  dataset discovery / factor research / strategy hypothesis assistant

FinLab articles:
  research backlog / feature ideas / cleaning rules / backtest design

TWSE / TPEX / FSC / MOEA:
  official audit / regulatory event / fallback

Shioaji proxy:
  intraday quote / five-level orderbook / pre-entry analysis

StockVision:
  feature schema / ML / regime / screener / backtest / decision / paper trade / risk
```

## V4 Data Diversity Rule

FinLab adoption is not a one-to-one TWSE/TPEX field replacement project.

The migration must run two lanes in parallel:

```text
Parity lane:
  verify FinLab can replace current TWSE/TPEX structured fields
  examples: security master, daily OHLCV, revenue, standard institutional flow

Diversity lane:
  ingest useful FinLab-native datasets even when StockVision has no old field
  examples: security_industry_themes, broker concentration, rotc_broker_transactions,
            rotc_price liquidity/spread, rotc_monthly_revenue, US/global context,
            derivatives positioning, richer fundamentals
```

The current 106-feature contract stays as the stable real-production interface,
but V4.1 adds a FinLab feature lake sidecar and a paper-active promotion loop.
New FinLab fields first receive data-quality gates, then may graduate into
`paper_active_challenger` and `paper_primary` without gaining real-order,
106-feature, ML-vote, or regime-write authority.

## V4.1 Local Runtime Closure Rule

Contract-only or read-only slices are no longer counted as closed.
Local DoD requires an executable runtime path plus tests:

```text
FinLab SDK/API
  -> local materialize raw/clean rows
  -> diff against StockVision D1/R2/GCS snapshots
  -> produce lineage-safe gap-fill rows
  -> block value conflicts from automatic fill

External evidence
  -> normalize Finnhub / official / IR / GDELT items
  -> validate trace, source quality, entity confidence, spam filters
  -> write theme_signals-compatible rows
  -> derive stock_theme_features through source-tagged concept mappings
  -> screener consumes multi-source evidence
  -> dashboard/data-quality can inspect runtime freshness and coverage

Dagster
  -> owns asset materialization entrypoint and rerun/check semantics
  -> production schedules stay disabled until Wei explicitly enables them
```

Local runtime files:

```text
ml-controller/services/finlab_backfill_runtime.py
ml-controller/services/finlab_dagster_runtime.py
ml-controller/services/external_evidence_runtime.py
tools/finlab_v4_local_materialize.py
tools/external_evidence_v4_local_packet.py
worker/src/lib/multiSourceThemeEvidence.ts
worker/src/lib/v41DataRuntime.ts
worker/src/lib/dataQualityMonitor.ts
worker/src/routes/dashboardReadRoutes.ts
worker/migration_v4_1_data_runtime.sql
```

Local runtime closure currently includes D1 row adapters for FinLab backfill,
source diff, external evidence, `theme_signals`, and `stock_theme_features`.
`/api/dashboard/v4/data-runtime/status` exposes read-only runtime status, and
Data Quality includes `theme_signal_runtime` so missing multi-source evidence is
visible instead of silently falling back to PTT/news/Anue-only heat.

## V4.1 Paper-Active Challenger Loop

```text
candidate
  -> clean_asset
  -> paper_active_challenger
  -> paper_primary
  -> real_review_ready
```

`paper_active_challenger` is allowed to influence StockVision paper decisions
through Decision Engine attribution, but it cannot write `paper_orders`,
`paper_positions`, `paper_settlements`, pending buys, real orders, 106-feature
schema, ML votes, or regime state. Automatic promotion stops at `paper_primary`;
real trading still requires explicit Wei approval.

Implemented contracts:

```text
ml-controller/services/promotion_gate_contract.py
ml-controller/services/paper_challenger_promotion.py
ml-controller/routers/paper_challenger.py
worker/src/lib/paperActiveChallenger.ts
worker/src/lib/paperActiveAttributionWiring.ts
worker/src/lib/controllerDailyWorkflows.ts
worker/src/lib/postMarketChain.ts
worker/migration_paper_active_challenger.sql
```

## V4.1 High-Spec Efficiency Rule

Performance work must preserve model/data quality first. A compute
optimization is accepted only when IC, precision@K, hit-rate, drawdown, top-K
overlap, regime split, and feature-count/spec gates remain non-inferior while
runtime or estimated cost improves.

Implemented contract:

```text
ml-controller/services/compute_efficiency_contract.py
worker/src/lib/computeProfileEvents.ts
worker/src/lib/postMarketChain.ts
worker/migration_compute_profile_events.sql
```

## Roadmap

| Phase | Topic | Tasks | Definition of Done |
|---|---|---|---|
| V4-0 | Roadmap freeze | Keep this file as the V4 implementation contract. | FinLab-first and official-audit-only boundaries are explicit. |
| V4-1 | FinLab SDK/API adapter | Add read-only `finlab_adapter`; wrap `data.get/search`; classify fields; normalize FinLab raw markets. | Adapter imports without FinLab installed and can run with `FINLAB_API_KEY` when available. |
| V4-2 | FinLab auth migration | Keep `python -m finlab login` migration on the adapter checklist; do not rely on deprecated token login long term. | Production adapter is not promoted until auth flow is refreshed. |
| V4-3 | API field catalog | Maintain `FINLAB_DATA_CATALOG.md` and `data/finlab_research/api_fields.json`. | All 2150 discovered fields have market, namespace, priority, adoption mode, dataset lane, quality gate, and StockVision use. |
| V4-4 | Adoption plan / factor map | Maintain `FINLAB_ADOPTION_PLAN.md` and `FINLAB_FACTOR_STRATEGY_MAP.md`. | API fields, Skill output, and article-derived hypotheses map to parity/diversity/research/reject and P0/P1/P2/Reject. |
| V4-5 | FinLab Skill layer | Use Skill output only for dataset discovery and research hypotheses. | Skill output never writes production features or triggers orders. |
| V4-6 | Source migration + diversity plan | Use FinLab-first structured daily data and keep TWSE/TPEX as official audit/fallback; separate parity and diversity lanes remain source-tagged. | Replacement fields pass data-quality checks; FinLab-native fields can enter paper-active challenger after reality gates. |
| V4-7 | TWSE/TPEX downgrade | Move old crawlers to audit/fallback. | Production structured daily features no longer depend on TWSE/TPEX crawler output. |
| V4-8 | Security master | Use `security_categories` as primary security master. | `sii -> LISTED`, `otc -> OTC`, `rotc -> EMERGING`; 7820 and 6682 are correctly routed. |
| V4-9 | Industry / theme taxonomy | Use `security_categories` for formal industry and `security_industry_themes` for industry-theme/subindustry; keep local concepts as market-topic overlays. | `industry/industry_theme/subindustry/concept` tags exist, are source-tagged, and sector-flow layer isolation is documented in `FINLAB_SECTOR_FLOW_SHADOW.md`. |
| V4-10 | Dagster asset graph / factory | Maintain `FINLAB_DAGSTER_ASSETS.md`, `FINLAB_DAGSTER_FACTORY.md`, `data/finlab_research/dagster_asset_graph.json`, and `data/finlab_research/dagster_definitions_payload.json`; add raw, clean, normalized, and feature-store assets. | Freshness, schema, missing, duplicate, lineage, and backfill checks exist for parity/diversity/research assets; Dagster runtime is pinned and exposed via a read-only code location with metadata-only `multi_asset_check`, but schedules stay disabled until explicitly enabled. |
| V4-11 | Canonical feature frame + feature lake | Maintain `FINLAB_FEATURE_LAKE_MANIFEST.md` and `data/finlab_research/feature_lake_manifest.json`; preserve the current 106-feature real-production contract and add a FinLab feature lake sidecar for useful non-equivalent fields. | Existing features can diff against FinLab; new FinLab fields enter clean-asset / paper-active lanes with provenance, row-level checks, join keys, and explicit non-real-production state. |
| V4-12 | Emerging-stock watchlist data | Maintain `FINLAB_EMERGING_WATCHLIST.md` and `data/finlab_research/emerging_watchlist_manifest.json`; bind `rotc_price`, `rotc_monthly_revenue`, and `rotc_broker_transactions` into watchlist and paper-active challenger lanes. | ROTC sources can influence paper candidates after liquidity/reality gates, but pending-buy/real execution/production ML training/direct real alpha remain disabled. |
| V4-12R | Research backlog | Convert FinLab article notes into research hypotheses. | Each item has dataset, feature, cleaning rule, backtest design, production risk, and promotion gate. |
| V4-13 | Screener V4 | Use FinLab market lane, industry, subindustry, themes, source quality, and hype risk. | Screener output explains classification and data provenance. |
| V4-14 | Sector flow V4 | Maintain `FINLAB_SECTOR_FLOW_SHADOW.md` and `data/finlab_research/sector_flow_shadow_manifest.json`; aggregate institutional flow across industry, industry_theme, subindustry, and concept. | No double-counting across multi-tag rows or cross-layer rollups; all four layers are visible with source-tagged taxonomy. |
| V4-15 | Chip features | Shadow foreign/trust/dealer, margin, lending, broker branch, `rotc_broker_transactions`, buyback, and government-fund concepts. | Chip features are gated by price location, liquidity, and chase risk; emerging-stock chip data stays watchlist-only. |
| V4-16 | Regime V4 contract | Maintain `MARKET_REGIME_STATE_CONTRACT.md`; write `market_regime_state` from regime-compute and keep `ml:regime` / `ml:regime:meta` only as migration mirrors. | Worker SL/TP, paper entry/exit, adaptive params, Controller ML payloads, and recommendation alpha allocation read `market_regime_state` first and fail closed when no regime contract is available. |
| V4-17 | Regime feature expansion | Add `regime-evidence-v1` with price trend, breadth, ATR/V-turn volatility, leverage/margin, valuation, macro liquidity, global risk, and pending LPPLS/Hawkes monitors. | Raw HMM `bear_market` is downgraded to downstream `volatile` unless cross-evidence confirms the transition, so regime does not flip bear solely from two weak sessions. |
| V4-18 | Bubble / contagion monitors | Add `regime_monitors.py` with LPPLS weekly proxy and Hawkes exponential-decay contagion proxy. | Monitors emit warnings/context only and never directly change alpha, SL/TP, recommendation ranking, or risk. |
| V4-19 | US / global context | Maintain `GLOBAL_CONTEXT_READINESS.md` and `global_context_readiness.py`; evaluate `us_*` and `world_index:*` with coverage, delay, license, required-field, survivorship, and holiday-alignment gates. | `world_index:*` can augment morning setup/regime context, but only a gated `us_leading` replacement candidate can replace Worker `usLeading.ts`. |
| V4-20 | Backtest reality layer | Maintain `BACKTEST_REALITY_CONTRACT.md` and `backtest_reality_layer.py`; evaluate liquidity, capacity, slippage/cost, limit-lock, disposition, full-delivery, MAE/MFE, turnover, and walk-forward gates. | Backtest promotion can reach paper-active only after reality gates prove the strategy is paper-tradable; real trading remains out of scope. |
| V4-21 | FinLab backtest benchmark | Maintain `FINLAB_BACKTEST_BENCHMARK.md` and `finlab_backtest_benchmark.py`; compare shared metrics only as external sanity evidence. | Report is always `allowed_use=sanity_check_only` and `decision_effect=benchmark_only`; FinLab strategy results never directly enter recommendations, paper trades, pending buys, or promotion. |
| V4-22 | ML / research challengers | Maintain `ML_RESEARCH_CHALLENGERS.md` and V4 registry functions in `model_upgrade_research_track.py`; route NEAT, Transformer, RL, GP, Qlib, and OpenFE by objective into ML-pool, ML-feature, regime, or research benchmark review. | They remain `offline_shadow`, `production_effect=none`, `vote_weight=0`, and cannot write predictions, regime, recommendations, paper fills, pending buys, or orders until a separate promotion packet passes. |
| V4-23 | LangGraph debate | Maintain `LANGGRAPH_DEBATE_CONTRACT.md`, `BREEZE2_RESEARCH_CONTEXT.md`, `langgraph_debate_contract.py`, `breeze2_research_context.py`, Controller `POST /breeze2/fact_check`, Modal `breeze2_research_context`, Worker `breeze2Runtime.ts`, screener enrichment, and pending-buy debate payload wiring; define Bull, Bear, Risk, Quant, Theme, and Final Judge reasoning plus conditional routing for ML disagreement, low fact support, hype risk, Breeze2 research checks, and major-news human review. | Debate output is `decision_context_only` and `advisory_only`; Breeze2 is `research_context_only` / semantic sidecar for morning debate and bounded screener enrichment, persists only sidecar/funnel/watch-point context, and cannot write recommendations, regime, pending buys, paper orders, or real orders. |
| V4-24 | Decision Engine contract | Maintain `DECISION_ENGINE_CONTRACT.md` and `decision_engine_contract.py`; define screener, ML, regime, risk as required primary inputs and theme, FinLab preview, LangGraph debate, and human flags as context/override inputs. | Decision Engine is the sole owner of `no_trade`, `watchlist`, `candidate`, and `human_review`; external tools cannot bypass it, and V4-24 does not create pending buys, paper orders, or real orders. |
| V4-25 | Paper trade integration | Maintain `FINLAB_PAPER_TRADE_INTEGRATION.md` and Worker preview contract helpers; keep StockVision as the only paper-fill writer while FinLab is preview/audit-only; record baseline pending-buy attribution via `paperActiveAttributionWiring` as a sidecar. | D1 has one simulated trade lifecycle plus optional `paper_execution_events.event_type=finlab_preview` and `paper_decision_attribution.paper_lane=paper_active_baseline` audit records; FinLab payloads that try to create paper orders, positions, settlements, pending buys, fills, or `execution_status=filled` are rejected/quarantined. |
| V4-26 | FinLab execution adapter | Maintain `FINLAB_EXECUTION_ADAPTER.md` and `finlab_execution_adapter.py`; normalize OrderExecutor / PortfolioSyncManager preview output into pass/blocked/warning/error. | `can_submit_real_order=false` for every V4-26 result; blocked/error do not submit and visible reasons are exposed; any live submit or order-id payload is rejected/quarantined. |
| V4-27 | Dashboard V4 | Maintain `DASHBOARD_V4_CONTRACT.md`, `dashboardV4Contract.ts`, and `/api/dashboard/v4/stocks/:id/chart`; produce a Lightweight Charts-ready packet for price, model signals, regime, sector flow, data quality, FinLab diff, and preview blocked reasons. | Dashboard packet uses StockVision-owned D1/KV/Worker data only, rejects external widget ownership, and exposes frontend `dashboardV4Api.stockChart`; actual `lightweight-charts` renderer dependency remains a separate UI slice. |
| V4-27A | Frontend chart readability | Maintain `FRONTEND_LIGHTWEIGHT_CHARTS_AUDIT.md`; apply Lightweight Charts as a shared StockVision visual layer across Dashboard, ML Pool, Strategy Lab, Bot Dashboard, Observability, Pipeline, Scheduler, Data Quality, and Stock Report where temporal evidence exists. | Each migrated page answers its primary operator question with chart/tiles first, reduces above-the-fold prose, hides raw JSON behind drilldowns, and never uses TradingView Widgets or external widget data as source of truth. |
| V4-28 | External evidence | Maintain `EXTERNAL_EVIDENCE_CONTRACT.md` and `external_evidence_contract.py`; register Finnhub backend-only, official RSS audit, company IR RSS watchlist/manual-review, and GDELT shadow global context. | Every item carries URL/source/entity trace, cleaning metadata, allowed use, and `direct_alpha_allowed=false`; packet builder quarantines unknown sources, untraceable events, missing quality/entity-linking fields, spam, non-allowlisted IR domains, direct alpha, trade signals, and auto-orders. |
| V4-29 | Promotion gates | Maintain `PROMOTION_GATE_CONTRACT.md`, `promotion_gate_contract.py`, `paper_challenger_promotion.py`, `paper_challenger` Controller route, Worker `paperActiveChallenger` persistence helpers, `paperActiveAttributionWiring`, and non-critical post-verify `paper-active-postmarket` task; route P0/P1/P2/Reject candidates into clean-asset, feature-lake shadow, paper-active challenger, paper-primary, offline research, or promotion-review lanes. | P1 can influence paper decisions after paper gates pass, can auto-promote to paper-primary via non-inferior paper evidence, writes attribution/audit rows, and still cannot write orders, real risk state, 106 features, ML votes, or regime. |
| V4-30 | Ops / safety | Maintain `V4_OPS_SAFETY_CONTRACT.md` and `v4_ops_safety_contract.py`; evaluate external API fetch, deploy, retrain, commit, push, real-order, and live-submit guardrails. | FinLab/API secrets stay backend-only; external fetch requires cache, rate limit, and audit logs; kill switch blocks real orders; deploy/retrain/commit/push/real-order/live-submit require explicit Wei approval with scope. |
| V4-31 | High-spec compute efficiency | Maintain `compute_efficiency_contract.py`, Worker `computeProfileEvents`, post-market callback compute telemetry, and `migration_compute_profile_events.sql`; normalize Cloud Run + Modal compute profiles and accept optimization only when quality/spec non-inferiority gates pass. | Monthly retrain, weekly validation, Optuna/GA, backtest/MC/PBO, feature selection, and Modal GPU functions reduce wasted runtime without reducing model/feature/validation quality; raw Worker/GCP/Modal profiles and accept/block reports can be persisted after migration approval. |

## P0 Implementation Slice

1. FinLab SDK/API adapter.
2. FinLab auth migration checklist.
3. API field catalog.
4. Factor / strategy map.
5. Parity lane plus diversity lane field planner and adoption plan manifest.
6. `security_categories` primary security master.
7. `security_industry_themes` industry-theme/subindustry tags.
8. Dagster-ready raw/clean/feature_lake FinLab asset graph, quality checks, read-only Definitions factory, pinned Dagster runtime dependency, `dagster_defs.finlab_v4` code location, and metadata-only `multi_asset_check`.
9. TWSE/TPEX audit/fallback downgrade.
10. Canonical feature frame, 106-feature fusion, and FinLab feature lake sidecar.
11. Four-layer sector flow shadow: industry, industry_theme, subindustry, and concept.
12. Emerging-stock watchlist data: `FINLAB_EMERGING_WATCHLIST.md` and `data/finlab_research/emerging_watchlist_manifest.json` bind `rotc_price`, `rotc_monthly_revenue`, and `rotc_broker_transactions` as watchlist/manual-review/context-only sources.
13. `market_regime_state` contract: `MARKET_REGIME_STATE_CONTRACT.md`, Worker `marketRegimeState` resolver, admin regime push, Controller payload/recommendation resolver, and legacy-key fallback only for migration.
14. Backtest reality and FinLab benchmark boundary: StockVision backtest remains production truth; FinLab backtest is external sanity evidence only.
15. V4 research challenger registry: NEAT, Transformer, RL, GP, Qlib, and OpenFE are routed to ML-pool, ML-feature, regime, or research benchmark review while remaining offline/shadow.
16. LangGraph debate contract: six-agent debate produces advisory Decision Engine context without write authority; Breeze2 semantic checks are available via Controller/Modal for high-theme/low-fact-support morning debate and bounded screener enrichment, with Worker runtime wiring into `/debate/buy_batch`, `screener_funnel_items`, and compact watch points only.
17. Decision Engine contract: merge StockVision primary evidence with FinLab/debate/human context into one owned decision before paper-trade or execution layers.
18. FinLab paper-trade preview contract: StockVision remains the only paper-fill writer and FinLab preview is stored only as `paper_execution_events.event_type=finlab_preview`.
19. FinLab execution preview POC: parse pass/blocked/warning/error into preview evidence, keep `can_submit_real_order=false`, and reject live-submit/order-id payloads.
20. Dashboard V4 chart packet: expose `/api/dashboard/v4/stocks/:id/chart` as a StockVision-owned Lightweight Charts-ready data contract before installing/rendering the chart library.
21. Frontend chart readability: add shared Lightweight Charts renderer slices for Dashboard, ML Pool, and Strategy Lab first, then operations pages; use chart/tiles as the primary reading surface and move long text / raw JSON into drilldowns. Current progress: P0 Dashboard / ML Pool / Strategy Lab; P1A Data Quality snapshot workbench; P1B Observability event timeline; P1C Scheduler cadence/duration-risk workbench; P1D Pipeline candidate funnel / run lane; P1E Stock Report Dashboard V4 chart reuse; P1F Bot Dashboard paper-trade performance / execution markers.
22. External evidence contract: route Finnhub, official RSS, company IR RSS, and GDELT into traceable context/watchlist/manual-review/shadow lanes, never direct alpha. Current progress: V4-28A packet builder / quarantine gate accepts only traceable, cleaned, allowlisted evidence and stores rejected items separately for audit.
23. Promotion gate contract v2: route P0/P1/P2/Reject candidates through `PROMOTION_GATE_CONTRACT.md`; P1 can become `paper_active_challenger` / `paper_primary` with attribution and non-inferiority gates, but no packet may grant direct 106-feature, ML-vote, regime, order, or real-trading authority.
24. Paper-active auto-promotion: `paper_challenger_promotion.py` evaluates paper decision count, precision@K, hit-rate, average return, drawdown, turnover, top-K overlap, regime split, runtime efficiency, and blind-spot coverage; `paper_challenger` exposes `POST /paper_challenger/postmarket_report`; Worker `paperActiveChallenger.ts` persists candidate, attribution, daily metrics, and promotion audit rows once the migration is applied; `paperActiveAttributionWiring.ts` records existing pending-buy decisions into `paper_decision_attribution` as the baseline comparison lane; `paper-active-postmarket` runs non-critical after daily report and before Obsidian sync.
25. Compute efficiency contract: `compute_efficiency_contract.py` normalizes GCP/Modal compute profiles and blocks faster runtimes if IC, precision@K, hit-rate, drawdown, top-K overlap, regime split, or feature-count/spec regress; Worker `computeProfileEvents.ts` is the D1 adapter for raw profile events and accept/block efficiency reports, and post-market chained tasks emit `cloudflare_worker` runtime profiles.
26. Ops safety contract: route external API fetch and sensitive ops through `V4_OPS_SAFETY_CONTRACT.md`; backend-only secrets, cache/rate-limit/audit logging, kill switch, and explicit Wei approval are all validated before any runtime owner may act.

## Non-Goals

```text
Do not let FinLab Skill write production features.
Do not let FinLab strategy results enter recommendations directly.
Do not store VIP article bodies internally.
Do not let FinLab own intraday quote, orderbook, risk, decision, or paper fills.
Do not delete TWSE/TPEX; downgrade them to official audit/fallback.
Do not restrict FinLab ingestion to only the fields StockVision already has.
Do not let GDELT/Finnhub headlines become direct alpha.
Do not promote NEAT/Transformer/RL/GP directly to production.
Do not create two trade lifecycles during paper trade + FinLab preview.
```
