# Decision Engine Contract

## Purpose

V4-24 defines StockVision Decision Engine as the single decision owner between
research/context layers and downstream trade lifecycle layers.

```text
Screener / ML / Regime / Theme / Risk / FinLab preview / LangGraph debate / Human flags
  -> Decision Engine
  -> no_trade | watchlist | candidate | human_review
  -> later V4-25 paper-trade integration and V4-26 execution preview contracts
```

External tools cannot bypass the Decision Engine.

## Runtime Contract

Implemented in:

```text
ml-controller/services/decision_engine_contract.py
ml-controller/tests/test_decision_engine_contract.py
```

Schema:

```text
schema_version: decision-engine-v1
decision_owner: stockvision_decision_engine
decision_effect: decision_engine_owned
```

Required primary inputs:

```text
screener
ml
regime
risk
```

Context and override inputs:

```text
theme
finlab_preview
langgraph_debate
human_flags
```

## Source Roles

| Source | Role | Authority |
|---|---|---|
| `screener` | `primary_candidate_source` | Candidate discovery and recommendation lane. |
| `ml` | `primary_prediction_source` | Signal, confidence, and model evidence. |
| `regime` | `primary_market_context` | Uses `market_regime_state` contract. |
| `risk` | `primary_guardrail` | Can block or force no trade. |
| `theme` | `feature_context` | Theme score, fact support, and hype risk. |
| `finlab_preview` | `preview_context_only` | Preview/audit evidence only. |
| `langgraph_debate` | `advisory_context_only` | Advisory decision context only. |
| `human_flags` | `override_gate` | Human halt/review override. |

## Decisions

Allowed decisions:

```text
no_trade
watchlist
candidate
human_review
```

Decision semantics:

```text
no_trade:
  fail closed, risk blocked, primary evidence too weak, or missing primary input

watchlist:
  worth tracking, non-tradable lane, or positive but incomplete evidence

candidate:
  primary StockVision evidence passes first-level review

human_review:
  major uncertainty, human flag, high hype/low fact support, bear-regime caution,
  or unsafe external role metadata
```

## Bypass Policy

FinLab preview and LangGraph debate may suggest context, but they cannot create
a candidate when primary StockVision sources are missing.

Fail-closed cases:

```text
missing screener
missing ml
missing regime
missing risk
FinLab preview suggested candidate without primary sources
LangGraph debate suggested candidate without primary sources
FinLab preview not marked preview_only
LangGraph debate not marked decision_context_only/advisory_only
```

## Write Authority

This slice does not write production state.

```text
daily_recommendations: false
market_regime_state: false
pending_buy: false
paper_order: false
real_order: false
```

The Decision Engine may later write a decision record, but:

```text
pending buy requires V4-25 paper trade integration contract
execution requires V4-26 execution adapter contract
real orders still require explicit human/production approval
```

## Integration Path

1. Screener writes candidate seed and lane.
2. ML writes prediction evidence.
3. Regime resolver provides `market_regime_state`.
4. Theme/risk/FinLab/debate provide context.
5. Human flags can halt or require review.
6. Decision Engine returns one owned decision.
7. V4-25 consumes only `candidate` decisions for paper-trade review.
8. V4-26 consumes only reviewed decisions for FinLab execution preview.

## Non-Goals

```text
Do not create pending buys in V4-24.
Do not create paper orders in V4-24.
Do not create real orders in V4-24.
Do not let FinLab preview write decision/rank/alpha.
Do not let LangGraph debate bypass Decision Engine.
Do not let missing primary StockVision evidence be patched by external tools.
```
