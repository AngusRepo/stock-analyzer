# V4 ML Research Challenger Contract

## Purpose

V4-22 turns NEAT, Transformer, RL, GP, Qlib, and OpenFE into explicit research
challenger candidates without giving them production authority.

This answers the routing rule:

```text
If the objective is single-stock return prediction or cross-sectional ranking:
  route to ML-pool challenger review.

If the objective is market, macro, or risk-on/risk-off regime detection:
  route to regime challenger review.

If the objective is feature or factor discovery:
  route to ML feature challenger review.

If RL is proposed as execution/order policy:
  keep as research benchmark; it is not an execution owner.
```

## Runtime Contract

Implemented in:

```text
ml-controller/services/model_upgrade_research_track.py
ml-controller/tests/test_v4_research_challenger_registry.py
```

Manifest schema:

```text
track_version: v4-research-challenger-registry-v1
status: offline_shadow
runtime_mode: offline_shadow
production_effect: none
direct_prediction: false
direct_regime_effect: false
direct_recommendation_effect: false
allowed_to_write_orders: false
vote_weight: 0.0
promotion_state: research_benchmark
approval_gate: v4_research_promotion_packet_required
```

## Algorithm Routing

| Algorithm | Default track | Allowed tracks | Production authority |
|---|---|---|---|
| NEAT | `ml_pool_challenger` | `ml_pool_challenger`, `regime_challenger` | none |
| Transformer | `ml_pool_challenger` | `ml_pool_challenger`, `regime_challenger` | none |
| ReinforcementLearning | `research_benchmark` | `regime_challenger`, `research_benchmark` | none |
| GeneticProgramming | `ml_feature_challenger` | `ml_feature_challenger`, `ml_pool_challenger`, `regime_challenger` | none |
| Qlib | `ml_pool_challenger` | `ml_pool_challenger` | none |
| OpenFE | `ml_feature_challenger` | `ml_feature_challenger` | none |

## Promotion Gates

Before any candidate can leave research benchmark status, it needs a separate
promotion packet with:

```text
dataset_lineage
schema_freshness
no_lookahead
walk_forward
regime_split
transaction_cost
turnover
shadow_ic
paper_order_ab
human_review
```

Passing this packet still does not mean live deployment. It only allows the
candidate to enter the appropriate reviewed challenger lifecycle.

## Boundaries

```text
Do not let research challengers vote in ensemble scoring.
Do not let research challengers write `challenger_rank_scores`.
Do not let research challengers update `market_regime_state`.
Do not let research challengers modify recommendation rank or alpha.
Do not let research challengers create paper fills, pending buys, or real orders.
Do not route RL execution policies to FinLab execution or StockVision order paths.
```

## Practical Use

The registry is for planning and governance:

```python
from services.model_upgrade_research_track import (
    build_v4_research_challenger_manifest,
    route_v4_research_challenger,
)

manifest = build_v4_research_challenger_manifest("2026-05-16")
route = route_v4_research_challenger(
    manifest,
    "Transformer",
    objective="single_stock_return_prediction",
)
```

The returned route tells orchestration code where the research result would be
reviewed later, while explicitly keeping runtime mode `offline_shadow`.
