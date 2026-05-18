# LangGraph Debate Contract

## Purpose

V4-23 defines a LangGraph-ready debate layer for StockVision reasoning.

It is broader than the current paper-trade Bull/Bear debate:

```text
Current paper-trade debate:
  Bull/Bear/Fulcrum verdict for pending-buy execution gating.

V4 LangGraph debate:
  Bull, Bear, Risk, Quant, Theme, and Final Judge context for Decision Engine.
```

The V4 debate layer does not own recommendation writes, market-regime writes,
pending buys, paper orders, or real orders. It produces decision context that a
future Decision Engine can consume.

## Runtime Contract

Implemented in:

```text
ml-controller/services/langgraph_debate_contract.py
ml-controller/tests/test_langgraph_debate_contract.py
```

Schema:

```text
schema_version: langgraph-debate-v1
allowed_use: decision_context_only
decision_effect: advisory_only
decision_authority: advisory_to_decision_engine
```

Write authority must stay false:

```text
daily_recommendations: false
market_regime_state: false
pending_buy: false
paper_order: false
real_order: false
```

## Agents

| Agent | Role | Output |
|---|---|---|
| `bull_agent` | Argue for upside using ML, quant, theme, and regime evidence. | `bull_case` |
| `bear_agent` | Argue downside, failure modes, hype, and event risk. | `bear_case` |
| `risk_agent` | Evaluate chase risk, liquidity, hype, and major-event risk. | `risk_flags` |
| `quant_agent` | Summarize model, factor, and price evidence. | `quant_case` |
| `theme_agent` | Evaluate theme strength, fact support, and hype risk. | `theme_case` |
| `final_judge` | Synthesize debate into Decision Engine context. | `proposed_decision_context` |

## Conditional Routing

```text
if ML disagreement is high:
  add risk_agent_extra_round

if theme score is high but fact support is low:
  request Breeze2 semantic fact check as research_context_only

if hype risk is high:
  strengthen Bear Agent rebuttal

if major news/event exists:
  mark human_in_the_loop_major_news
```

The Breeze2 request now maps to Controller `POST /breeze2/fact_check` and Modal
function `breeze2_research_context`. Debate may request this tool as
`research_context_only`; the returned packet is advisory context for the
Decision Engine and must not mutate state.

The current runtime bridge also accepts this sidecar in the existing paper
debate endpoints:

```text
POST /debate/buy
POST /debate/buy_batch
  candidates[].breeze2_context
```

`breeze2_context` is formatted into the debate prompt only when
`allowed_use=research_context_only`. It is labelled `decision authority: none`
and does not change the Controller verdict parser, cache schema, pending-buy
writer, or execution ownership.

## Proposed Decisions

Allowed proposed decisions:

```text
watchlist
candidate
human_review
reject
```

These are advisory labels for Decision Engine review. They are not direct
recommendation ranks and do not create pending buys.

## Integration Path

1. Screener and ML produce candidate evidence.
2. Regime V4, theme features, risk overlays, FinLab feature lake, and event
   context are normalized into a debate context payload.
3. If a conditional semantic-risk trigger fires, Breeze2 can produce a
   `breeze2-research-context-v1` sidecar packet.
4. Existing morning pending-buy debate can include this sidecar before
   `/debate/buy_batch`; future `langgraph-debate-v1` can consume the same
   packet shape.
5. Decision Engine consumes the context and remains the owner of final action.
6. Paper-trade and execution layers continue to apply their own gates.

## Non-Goals

```text
Do not replace current paper-trade debate runtime in this slice.
Do not call LLMs or tools from the contract builder.
Do not let Breeze2 become a primary candidate source.
Do not write `daily_recommendations`.
Do not write `market_regime_state`.
Do not create pending buys.
Do not create paper orders or real orders.
Do not let Final Judge bypass Decision Engine.
```
