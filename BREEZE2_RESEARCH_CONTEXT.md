# Breeze2 Research Context Contract

## Purpose

Breeze2 is the semantic fact-check and hype-risk sidecar for V4-23 LangGraph
debate and screener enrichment.

It is intentionally not a primary candidate source. It cannot write
recommendations, regime, pending buys, paper orders, or real orders.

## Runtime

Implemented in:

```text
ml-controller/services/breeze2_research_context.py
ml-controller/routers/breeze2.py
ml-service/app/breeze2_context.py
ml-service/modal_app.py
worker/src/lib/breeze2Runtime.ts
worker/src/lib/marketScreener.ts
worker/src/lib/pendingBuyOrchestrator.ts
```

Controller route:

```text
POST /breeze2/fact_check
```

Modal function:

```text
breeze2_research_context
```

The route supports two modes:

```text
execute_modal=false
  Build a local non-mutating contract packet.

execute_modal=true
  Call Modal `breeze2_research_context` and validate that the returned packet
  is still research_context_only / advisory_only.
```

## Allowed Use

```text
allowed_use: research_context_only
decision_effect: advisory_only
source_role: semantic_context_sidecar
primary_candidate_source_allowed: false
```

Write authority:

```text
daily_recommendations: false
market_regime_state: false
pending_buy: false
paper_order: false
real_order: false
```

## Consumers

Morning debate:

```text
theme_score high + fact_support low
  -> Breeze2 semantic fact check
  -> pending-buy `breeze2_context`
  -> Controller /debate/buy_batch prompt context
  -> debate verdict remains owned by StockVision Bull/Bear/Fulcrum runtime
```

Screener:

```text
top shortlist / theme spike / low fact support / high hype risk
  -> worker `enrichScreenerCandidatesWithBreeze2` bounded planner
  -> Breeze2 screener_enrichment
  -> theme_fact_support / hype_risk / source_quality / contradiction flags
  -> `screener_funnel_items.stage = breeze2_semantic_context`
  -> compact `breeze2:*` watch point in daily_recommendations
```

Screener should not call Breeze2 across the full market. Use it only on a
bounded shortlist or abnormal semantic-risk candidates. The planner currently
selects candidates with high screener score plus low fact support, high hype
risk, or a major-event marker.

## Worker Closure

Runtime closure now includes the Worker caller path:

```text
marketScreener final shortlist
  -> select max 5 semantic-risk candidates
  -> POST /breeze2/fact_check execute_modal=true
  -> persist sidecar evidence in screener_funnel_items
  -> append compact watch point to daily_recommendations.watch_points

pendingBuyOrchestrator pending debate
  -> enrich each pending candidate before /debate/buy_batch
  -> include `breeze2_context` in Controller payload
  -> append compact watch point to pending_buy watch_points after debate
```

The sidecar is fail-open for availability: if Controller/Modal is unavailable,
the screener and pending-buy debate continue with existing StockVision evidence.
It is fail-closed for authority: invalid Breeze2 packets are discarded unless
they keep `research_context_only`, `advisory_only`, and
`primary_candidate_source_allowed=false`.

## Output

The packet includes:

```text
quality:
  evidence_count
  traceable_source_count
  official_source_count
  social_source_count
  source_quality

scores:
  fact_support
  hype_risk
  source_quality
  contradiction_risk

risk_flags:
  fact_support_low
  hype_risk_high
  contradiction_risk_high
  traceable_source_missing
  evidence_missing

recommended_decision_context:
  insufficient_evidence
  human_review
  watchlist_context
  candidate_context
```

These are advisory context labels only. They do not create a candidate by
themselves and cannot bypass primary StockVision evidence.
