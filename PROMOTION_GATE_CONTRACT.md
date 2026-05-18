# V4 Promotion Gate Contract

## Scope

V4-29 defines how new StockVision inputs move from idea to runtime lane.

Covered candidates:

```text
FinLab parity fields
FinLab diversity fields
external evidence sources
theme / taxonomy features
ML / regime / feature research challengers
strategy or backtest-derived hypotheses
```

This contract does not deploy, retrain, promote, or submit orders. It only
decides which lane a candidate is allowed to enter.

## Runtime Contract

Implemented in:

```text
ml-controller/services/promotion_gate_contract.py
ml-controller/tests/test_promotion_gate_contract.py
```

Schema:

```text
schema_version = promotion-gate-contract-v2
promotion_owner = decision_engine_and_model_registry_review
```

## Lanes

| Lane | Allowed Runtime | Production Authority |
|---|---|---|
| P0 | `clean_asset` after cleaning gates pass | Can write clean data assets only; no 106-feature, ML vote, regime, or order authority. |
| P1 | `feature_lake_shadow` | Feature/evidence lane only; no paper or production effect. |
| P1 paper request | `paper_active_challenger` after paper reality gates pass | Can influence StockVision paper decisions and write attribution only; cannot write paper orders, pending buys, positions, settlements, real orders, 106-feature, ML vote, or regime. |
| P1 paper-primary request | `paper_primary` after paper A/B and non-inferiority gates pass | Can become part of the paper decision path; still cannot write any order lifecycle or real-trading state. |
| P1 production request | `promotion_review` only after all promotion evidence passes | Review-ready, not auto-promoted. |
| P2 | `offline_research` | Research benchmark only. |
| Reject | `blocked` | No runtime authority. |

## Required Gates

Cleaning gates:

```text
source_lineage
schema_freshness
no_lookahead
```

Promotion review gates:

```text
ic
hit_rate
transaction_cost
turnover
drawdown
mae_mfe
regime_split
decision_engine_review
```

Paper-active gates:

```text
backtest_reality
walk_forward
liquidity
transaction_cost
mae_mfe
regime_split
decision_engine_review
paper_attribution
```

Paper-primary gates:

```text
paper-active gates
paper_order_ab
paper_non_inferiority
```

## Forbidden Effects

The validator rejects forged packets that attempt:

```text
production_effect = direct_alpha / trade_signal / auto_order
can_write_106_feature = true
can_write_ml_vote = true
can_write_regime = true
can_write_order = true
```

Paper-active packets may set:

```text
can_write_feature_lake = true
can_write_paper_attribution = true
can_influence_paper_decision = true
production_effect = paper_decision_only / paper_primary_only
```

They still must keep:

```text
can_write_order = false
can_write_106_feature = false
can_write_ml_vote = false
can_write_regime = false
```

## Integration Boundary

```text
Dagster / FinLab / external evidence / research challenger
  -> promotion_gate_contract
  -> clean_asset / feature_lake_shadow / paper_active_challenger / paper_primary / offline_research / promotion_review
  -> Decision Engine + model registry review
```

Even `ALLOW_PROMOTION_REVIEW` is not a production promotion. It means the
candidate has enough evidence to be reviewed by the owner layer.

## V4.1 Paper-Active Auto-Promotion

Implemented in:

```text
ml-controller/services/paper_challenger_promotion.py
ml-controller/routers/paper_challenger.py
ml-controller/tests/test_paper_challenger_promotion.py
ml-controller/tests/test_paper_challenger_router.py
worker/src/lib/paperActiveChallenger.ts
worker/src/lib/paperActiveAttributionWiring.ts
worker/src/lib/paperActiveChallenger.test.ts
worker/src/lib/paperActiveAttributionWiring.test.ts
worker/src/lib/controllerDailyWorkflows.ts
worker/src/lib/postMarketChain.ts
worker/migration_paper_active_challenger.sql
```

The paper-active loop can automatically promote a candidate from
`paper_active_challenger` to `paper_primary` when paper quality is non-inferior
to baseline and at least one incremental-value signal is observed. It can also
demote a candidate back to `clean_asset` when paper quality regresses.

It never grants real-trading authority. Any real-trading use remains
`requires_wei_approval_for_real = true`.

Runtime notes:

```text
build_paper_challenger_postmarket_report
  -> promotion_packets
  -> audit_events
  -> POST /paper_challenger/postmarket_report
  -> post-verify chain task paper-active-postmarket
  -> worker paperActiveChallenger persistence helper
  -> paper_challenger_candidates / paper_decision_attribution /
     paper_challenger_daily_metrics / promotion_audit_events

setupMorningPendingBuys
  -> persistPendingBuys
  -> paperActiveAttributionWiring sidecar
  -> paper_decision_attribution
```

`paperActiveAttributionWiring` records baseline pending-buy attribution as
`paper_active_baseline`; it does not create pending buys, paper orders,
positions, settlements, or fills. This gives future paper-active challengers a
comparable audit trail without producing a second trade lifecycle.

The helper is safe to call before the migration is applied: missing-table
errors are swallowed, while other D1 errors are logged.

`paper-active-postmarket` is non-critical in the post-verify chain. A failed
promotion report must not block verify, adapt, daily report, Obsidian sync, or
paper trading.

## V4.1 High-Spec Compute Efficiency

Implemented in:

```text
ml-controller/services/compute_efficiency_contract.py
ml-controller/tests/test_compute_efficiency_contract.py
worker/src/lib/computeProfileEvents.ts
worker/src/lib/computeProfileEvents.test.ts
worker/src/lib/postMarketChain.ts
worker/migration_compute_profile_events.sql
```

Compute optimization is accepted only when high-spec quality is preserved:

```text
IC / precision@K / hit-rate do not regress beyond policy
max drawdown does not worsen beyond policy
top-K overlap remains stable
regime split stays valid
feature count/spec is not reduced
runtime or estimated cost improves materially
```

`normalize_compute_profile` converts GCP Cloud Run and Modal observations into
one profile shape before `build_compute_efficiency_report` compares baseline
and optimized runs.

`computeProfileEvents` is the Worker-side D1 event adapter for storing raw
compute observations and accepted/blocked efficiency reports after the migration
is explicitly applied. Post-market callback tasks emit `cloudflare_worker`
compute profile events from the shared chained-task logger.
