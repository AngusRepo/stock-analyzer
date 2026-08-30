# PIT Residual Shadow and RRG Retirement Closure

Status: accepted for prospective production shadow deployment on 2026-08-30.

## Final decision

StockVision keeps one factor challenger only:

- Candidate: PIT industry-residual momentum.
- Weight: 10% in the counterfactual candidate ranking.
- Primary evaluation horizon: 10 trading sessions.
- Current authority: `decision_effect=none`.
- Candidate-set mutation: forbidden.
- Debate, sizing, risk and order authority: forbidden.
- Breadth and five-session institutional-flow diffusion: diagnostic only and stored in the same artifact.

The existing production score, L4 allocation, debate, pending-buy sizing and execution path remain unchanged until a separate promotion gate is passed.

## Evidence boundary

The exact PIT comparison available at closure had nine mature dates under one taxonomy checksum. At the 10-session horizon:

| Comparison | IC delta | Top-20 return delta | Net return delta | Holm-adjusted p |
| --- | ---: | ---: | ---: | ---: |
| Residual 10% vs production base | +0.01280 | +0.79 pp | +0.79 pp | 0.0048 |
| Residual 10% vs V1 10% | +0.03789 | +1.27 pp | +1.28 pp | 0.0048 |

This is sufficient to justify a prospective shadow, not production promotion. The minimum 60 OOS-session promotion rule remains unchanged. Breadth and flow did not improve the score as additive factors in the fair comparison, so they cannot become score adders without a new adjudication.

The late-risk audit did not establish RRG-specific improvement over a date-matched generic de-risking placebo. RRG therefore has no supported selection, debate or risk authority in the current system.

## Runtime closure

- `ml-controller` writes `pit_factor_shadow_daily_v1` after the legacy sector-flow compatibility job.
- The producer uses a point-in-time FinLab industry snapshot and refuses a requested/available signal-date mismatch.
- The Worker reads only the latest shadow date not later than the screener date.
- The screener stores counterfactual rank deltas in the durable funnel but leaves `scoreBefore === scoreAfter`.
- Missing breadth or flow diagnostics do not suppress an otherwise valid residual row.
- RRG watch points are scrubbed from pending-buy debate and Breeze2 evidence.
- RRG no longer changes pending-buy risk percentage.

## UI closure

Homepage:

- One animated group trajectory map replaces the old capital-flow panel.
- X is the group mean of the actual candidate counterfactual rank delta, normalized by candidate count. It is not the within-industry mean residual percentile, which is structurally near 50.
- Y is breadth/flow confirmation and has no scoring authority.

Simulation room:

- During shadow: active pending buys plus the largest near-cutoff counterfactual movers.
- After a future promotion: active pending buys plus open positions; the backend must set `phase=promoted` and stop adding movers.
- Every node is an actual session. The curve is a display interpolation only; replay runs once and respects reduced-motion preferences.

The old homepage flow panel, Bot RRG panel, MicroRRG widget, Pipeline quadrant display and their unused component source were removed. The legacy `sector_flow` tables and `/paper/quadrant-filter` path remain for historical/runtime compatibility; current UI treats that endpoint as a generic risk-audit log and filters historical RRG rows.

## Discarded implementations

The following experiments are not part of this branch and must not be restored without a new evidence review:

- full RRG challenger;
- regime-aware and regime-optimizer RRG;
- hierarchical/flow-fusion RRG;
- RRG runtime shadow variants;
- breadth or flow as additive score factors;
- additional parallel shadow stacks.

## Promotion gate

Promotion requires all of the following:

1. At least 60 mature prospective OOS sessions.
2. Stable taxonomy coverage across more than one checksum regime.
3. Positive net-of-cost candidate ranking contribution at the actual holding horizon.
4. No regression in MDD, tail loss, turnover or coverage.
5. A separate reviewed commit changing `decision_effect`, UI phase and downstream authority.

No automatic promotion is implemented in this closure.
