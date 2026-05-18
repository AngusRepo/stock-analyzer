# V4.1 Closure Audit

Generated: 2026-05-17

Status vocabulary:

- `runtime_closed`: repo-local runtime path and tests are wired.
- `formal_shadow`: executable shadow path exists and does not mutate production features.
- `paper_active`: paper-trading validation path can consume the output.
- `prod_primary`: production primary path after CPD/deploy/backfill readback.
- `cpd_required`: needs Cloud Run/Cloudflare/GCS production execution or migration.
- `blocked_by_policy`: requires explicit Wei approval for deploy/retrain/order-related action.

## Closure Matrix

| Item | Status | Evidence | Remaining Gate |
| --- | --- | --- | --- |
| P0-0 Truth Audit | `runtime_closed` | This file records runtime vs contract status and prevents placeholder work from being counted as done. | Keep updated after CPD. |
| P0-1 Data Store Inventory | `runtime_closed` | `data/data_source_inventory.json` defines source roles and canonical key. | Remote D1/R2/GCS inventory readback after credentials are valid. |
| P0-2 FinLab 3Y/5Y Backfill | `formal_shadow` | `finlab_backfill_runtime.py`, `finlab_backfill_runs`, `source_diff_report`, local materialization runtime. | Real 3Y/5Y FinLab pull to GCS/R2/D1 is `cpd_required`. |
| P0-3 Canonical Diff + Gap Fill | `formal_shadow` | `source_diff_report`, `gap_fill_candidates`, `canonical_market_daily`, `canonical_chip_daily`, `canonical_revenue_monthly` tables exist in migration. | Production gap-fill write needs CPD readback; value conflicts stay quarantine. |
| P0-4 Dagster Asset Runtime | `runtime_closed` | `dagster_defs.finlab_v4` imports with real Dagster `Definitions`; asset graph includes owner/source/schema/freshness/join key/output location; 45 assets and 190 checks load locally. | Enable schedule/materialization in CPD only. |
| P0-5 Screener Diversity | `paper_active` | `multiSourceThemeEvidence.ts` consumes runtime `theme_signals`; `marketScreener.ts` merges PTT/news/Anue with runtime evidence. | Need live source coverage readback. |
| P0-6 Finnhub | `formal_shadow` | `external_evidence_runtime.py` fetches/normalizes Finnhub and maps to theme signals. | Secret/cache/rate-limit/scheduler production verification is `cpd_required`. |
| P0-7 Official RSS / IR | `formal_shadow` | `external_evidence_contract.py` defines `official_rss` and `company_ir_rss` quality gates. | Real fetchers/schedulers and allowlist readback remain CPD. |
| P1 GDELT | `formal_shadow` | `fetch_gdelt_doc_events` maps to low-weight global risk context and theme signals. | Ranking effect remains disabled until promoted. |
| P0-8 FinLab Taxonomy + Sector Flow | `formal_shadow` | FinLab taxonomy/sector-flow services and manifests exist. | Production sector-flow switch requires live validation. |
| P0-9 Regime / US Leading | `formal_shadow` | Global/regime context services exist and FinLab/Finnhub/GDELT roles are documented. | Morning setup replacement requires CPD scheduler readback. |
| P0-10 ML Feature Rebuild | `blocked_by_policy` | Feature-lake manifest exists; original 106 features remain baseline namespace. | Full 3Y/5Y retrain requires explicit approval. |
| P0-11 Backtest / Paper Validation | `paper_active` | Paper-active promotion contracts exist; MC low-sample status now emits `LOW_SAMPLE_TAIL_RISK`. | Backtest rerun on full canonical data is CPD/retrain-adjacent. |
| P0-12 Dashboard / Observability | `runtime_closed` | Model Pool serving strip, data-runtime status, weekly validation split, and coverage fields are wired locally; live GCS lineage readback showed 8/8 serving alpha slots and desktop/mobile screenshots were captured. | Production screenshot after CPD should be repeated against deployed Pages. |
| P0-13 Code Slimming | `runtime_closed` | Standalone FamilyBalance render removed; deletion candidates are listed in `V4_DELETION_CANDIDATES.md`; placeholder semantics removed from runtime Dagster path. | Delete candidates only after CPD confirms replacements. |

## 2026-05-18 Local Repair Update

| Repair Item | Status | Evidence | CPD Gate |
| --- | --- | --- | --- |
| FinLab row-level canonical materializer | `runtime_closed` | `ml-controller/services/finlab_canonical_materializer.py` materializes `canonical_market_daily`, `canonical_chip_daily`, `canonical_revenue_monthly`, `canonical_broker_flow_daily`, `finlab_taxonomy_tags`, inventory, quality metrics, and manifest from the 5Y artifact. | Run `tools/finlab_canonical_apply_d1.py --apply` only after deploy/write approval. |
| FinLab D1 apply path | `runtime_closed` | `build_d1_upsert_statements()` plus `tools/finlab_canonical_apply_d1.py` produce a dry-run/apply plan; smoke run for 2026-05-15 produced 75 D1 statements from limited rows. | Remote D1 readback after CPD. |
| Emerging broker-flow chip lane | `runtime_closed` | `screenerMarketData.ts` loads `canonical_broker_flow_daily`; `marketScreener.ts` scores `broker_proxy` and writes `chip_source/source_date/broker_count` into watch points. | Requires D1 canonical broker rows to be applied. |
| FinLab taxonomy in screener | `runtime_closed` | `getIndustryMapping()` now prefers `finlab_taxonomy_tags` over legacy `stock_tags`; `v41DataRuntime.ts` can emit `finlab_taxonomy` theme signals and refresh stock theme features from FinLab tags. | Requires taxonomy rows applied and cache invalidation. |
| Market risk V4 context | `runtime_closed` | `/api/market/risk` now returns `contextFactors` and `regimeState`; `MarketRiskPanel` shows price, volatility, breadth, chips, leverage, regime, global risk, LPPLS, and Hawkes tiles. | Production Pages screenshot after CPD. |

ROTC broker-flow caveat: the already-created 5Y artifact stores all-broker daily totals, so `buy_shares == sell_shares` and `buy_sell_net == 0` for every symbol by market mechanics. `tools/finlab_v4_remote_backfill.py` now preserves `dominant_net_shares` and `gross_imbalance_shares` for the next CPD backfill; rerunning the FinLab backfill is required before emerging chip score can become directional instead of activity-only.

## Not Counted As Closed Without CPD

- Production FinLab 3Y/5Y backfill completed.
- Remote D1/R2/GCS diff readback completed.
- Dagster production schedule enabled.
- ML retrain on rebuilt 3Y/5Y matrix.
- Any real order submit, FinLab execution handoff, or production risk-control transfer.

## Current DOD Boundary

Local DOD can close repo/runtime contracts. Prod DOD remains gated by CPD, remote credentials, deploy approval, and retrain approval.

## 2026-05-18 Exact P0-0 to P2-2 Closure Matrix

This section uses the 2026-05-18 repair roadmap as the only checklist. `runtime_closed_local` means repo-local code/tests are wired. It does not imply CPD, deploy, retrain, remote D1/R2/GCS write, or production scheduler enablement.

| Item | Current Status | Local Evidence | Blocking Gate / Not Closed Yet |
| --- | --- | --- | --- |
| P0-0 Runtime Truth Audit | `runtime_closed_local` | This matrix re-labels the roadmap with `prod_primary` / `paper_active` / `formal_shadow` / `contract_only` / `dead_code` semantics and does not count placeholder-only work as completed. | Must be refreshed after CPD readbacks. |
| P0-0.1 Compute Regression Guard | `runtime_closed_local` | `ml-controller/services/compute_efficiency_contract.py` now records required monthly retrain stage timings and flags 8103s-style runtime regression without reducing model/feature quality gates. | Needs live monthly run profile ingestion after the next approved retrain. |
| P0-0.2 GCP/Modal Resource Approval Gate | `runtime_closed_local` | `ml-controller/services/v4_ops_safety_contract.py` now treats `resource_change` as approval-required with reason, estimated monthly cost, and audit log gates. | Production resource changes still require Wei approval before mutation. |
| P0-1 FinLab Row-Level Canonical Materialization | `runtime_closed_local` / `cpd_required` | `finlab_canonical_materializer.py` produces `canonical_market_daily`, `canonical_chip_daily`, `canonical_revenue_monthly`, `canonical_broker_flow_daily`, `finlab_taxonomy_tags`, inventory, quality metrics, and manifest from local artifacts. | Remote D1 apply/readback not run in this local pass. |
| P0-2 Emerging Broker Flow | `partial_runtime_closed_local` / `backfill_rerun_required` | Worker now reads `canonical_broker_flow_daily`; materializer preserves broker lineage fields. | Existing 5Y artifact was produced before directional broker aggregation fix, so 6682 remains activity-only until FinLab backfill reruns. |
| P0-3 Screener Chip Canonical-First | `runtime_closed_local` / `cpd_required` | `screenerMarketData.ts` prefers canonical chip/broker flow; `marketScreener.ts` scores `broker_proxy` and emits `chip_source/source_date/broker_count`. | Needs canonical broker rows in remote D1 and a fresh screener run. |
| P0-4 FinLab Four-Layer Taxonomy Production | `runtime_closed_local` / `cpd_required` | `finlab_taxonomy_tags` materialization exists; screener industry mapping prefers FinLab tags; theme feature refresh reads FinLab tags plus legacy concept overlay. | Needs remote D1 taxonomy rows and UI readback to prove 「其他」下降. |
| P0-5 Sector Flow Freshness | `runtime_closed_local` / `remote_readback_required` | `daily_pipeline_v2.py` calls `run_sector_flow_pipeline(as_of_date)` before recommendations; sector-flow API exposes `requested_date/stale_reason`. | Need 2026-05-18 remote `sector_flow` rows after CPD. |
| P0-6 Theme Evidence Runtime | `runtime_closed_local` / `cpd_required` | `v41DataRuntime.ts` upserts/refreshes `theme_signals` and `stock_theme_features`; source coverage now includes PTT, Anue, D1 news, FinLab, Finnhub, Official, IR, GDELT. | Live rows must be generated/applied; GDELT remains formal shadow by design. |
| P0-7 MarketRegimePanelV4 | `runtime_closed_local` / `prod_screenshot_required` | `/api/market/risk` returns `market_regime_state`, `market_risk`, and context factor tiles; `MarketRiskPanel` is fail-visible if V4 state is missing. | Needs deployed Pages screenshot and KV readback. |
| P0-8 Regime Producer | `runtime_closed_local` / `remote_kv_required` | Pipeline blocks/fails visible when `market_regime_state` is missing before recommendation; legacy `ml:regime` is migration fallback only. | Need CPD run to verify 2026-05-15 and 2026-05-18 KV state. |
| P0-9 Monthly Retrain Artifact Semantics | `runtime_closed_local` / `live_artifact_readback_required` | Registry/UI supports `monthly_release` vs `weekly_drift`; followup registry now honors explicit `candidate_type`; audit states FinLab diversity is not in champion matrix yet. | The already-run monthly artifact must be read back from registry to confirm it did not replace champion. |
| P0-10 Performance Hotfix Without Downgrading Spec | `contract_guard_closed_local` / `implementation_partial` | Quality non-inferiority contract and stage timing guard exist; no cheap feature/sample/model cuts are accepted as optimization. | Real caches/warm-start/vectorized hotfixes still need implementation and benchmark proof. |
| P1-1 Weekly Drift Retrain | `runtime_closed_local` / `approval_gated_not_executed` | `runWeeklyDriftRetrain()` reads model pool, selects degraded/weak targets, maps only affected model groups, sends `candidate_type=weekly_drift`, `force_monthly=false`, and is exposed as manual `weekly-drift-retrain` with `confirm=weekly_drift`; weekly-cleanup still does not retrain. | Not executed locally or in production; true candidate output requires Wei-approved trigger/retrain. |
| P1-2 FinLab Diversity Feature Namespace | `paper_active_contract` / `not_training_closed` | Feature-lake/manifest paths exist and baseline 106 remains protected. | Needs matrix build, IC delta, missing-rate report, and approved retrain/paper-active run. |
| P1-3 Backfill Incrementalization | `implementation_partial` | Canonical materializer and fixed ROTC broker aggregation are in repo. | Historical one-shot + daily incremental scheduler and chunked CPD runtime not fully proved. |
| P1-4 Dagster Materialization | `formal_shadow_runtime_local` | `dagster_defs.finlab_v4` and runtime/check modules load local asset definitions/checks. | Production schedule enablement requires Wei approval; clean asset materialization must be read back after CPD. |
| P1-5 Freshness UX | `runtime_closed_local` / `prod_readback_required` | Market risk and sector-flow routes expose requested/source/generated/stale fields; source coverage exposes freshness and materialization. | Need deployed UI screenshots across the three surfaces after CPD. |
| P1-6 Source Coverage Dashboard | `runtime_closed_local` | Data Quality page uses `source_coverage` for PTT, Anue, D1 news, FinLab, Finnhub, Official, IR, GDELT with rows/freshness/entity-link/decision-effect. | Needs live rows to prove non-zero coverage. |
| P2-1 Runtime Path Cleanup | `partial` | FamilyBalance standalone panel removed; deletion candidates file exists; placeholder-only terms are not counted as complete here. | Old fallback/buzz-only paths still exist and need staged removal after CPD. |
| P2-2 TWSE/TPEX Audit/Fallback | `partial` / `not_prod_primary_closed` | FinLab canonical path is wired for screener/canonical materialization. | `worker/src/lib/twseApi.ts` and update paths still contain primary ingestion behavior; must be demoted carefully after FinLab readbacks. |

### Exact Prod DOD Status

- FinLab canonical rows > 0 locally: `passed_local`; remote D1 production rows: `pending_cpd`.
- 6682 emerging broker proxy non-zero: `pending_backfill_rerun`; old artifact root cause is all-broker daily netting.
- FinLab taxonomy into screener/sector flow: `passed_local`; production readback: `pending_cpd`.
- Finnhub/official/IR evidence rows: `runtime_closed_local`; live row generation/readback: `pending_cpd`.
- GDELT formal shadow visible: `runtime_closed_local`; live row readback: `pending_cpd`.
- `market_regime_state` production value: `local_contract_closed`; remote KV 2026-05-15/2026-05-18 readback pending.
- Monthly retrain semantics: `local_contract_closed`; live artifact registry readback pending.
- Compute profile speed improvement: `guard_closed`; optimization implementation and benchmark proof pending.
- Dashboard freshness/root-cause visibility: `passed_local`; production screenshot/readback pending.
