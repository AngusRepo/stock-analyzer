# FinLab Paper Trade Integration Contract

## Scope

V4-25 keeps StockVision as the only simulated trade lifecycle owner.

FinLab may provide execution feasibility context, settlement/cash warnings, or
broker-side preview status, but it must not create StockVision paper fills.

```text
Decision Engine
  -> StockVision pending buy lifecycle
  -> optional FinLab preview/audit context
  -> StockVision paper entry/exit tasks
  -> StockVision paper_orders / paper_positions / paper_settlements
```

## Ownership

| Area | Owner | Rule |
|---|---|---|
| Pending buy creation | StockVision | FinLab must not create `pending_buy_runs` or pending buy items. |
| Paper order fill | StockVision Worker | FinLab must not write `paper_orders` or mark `execution_status=filled`. |
| Paper position | StockVision Worker | FinLab must not write `paper_positions`. |
| Paper settlement | StockVision Worker | FinLab must not write `paper_settlements`. |
| Preview / blocked reason | FinLab context | Stored only as `paper_execution_events.event_type = finlab_preview`. |
| Real order submission | Future execution adapter | Out of scope for V4-25; requires explicit approval and separate V4-26 contract. |

## D1 Lifecycle

There is one simulated trade lifecycle:

```text
pending_buy_runs / pending_buy_items
  -> paper_orders
  -> paper_positions
  -> paper_settlements
```

FinLab preview is a side-channel audit event:

```text
paper_execution_events
  event_type = finlab_preview
  source = finlab_preview
  detail.previewOnly = true
```

This prevents the POC from producing two records for the same D1 trade.

## Worker Contract

Implemented in:

```text
worker/src/lib/finlabPaperPreviewContract.ts
worker/src/lib/finlabPaperPreviewContract.test.ts
worker/src/lib/paperActiveAttributionWiring.ts
worker/src/lib/paperActiveAttributionWiring.test.ts
```

The policy is:

```text
schemaVersion = finlab-paper-preview-v1
stockvisionPaperFillWriter = stockvision_worker_paper_trade
finlabRole = preview_audit_only
canWritePaperOrders = false
canWritePaperPositions = false
canWritePaperSettlements = false
canCreatePendingBuys = false
auditSink.table = paper_execution_events
auditSink.eventType = finlab_preview
```

## Validation Rules

Reject or quarantine any FinLab preview payload that contains:

```text
paper_order / paper_order_id
paper_position
paper_settlement
pending_buy / pending_buy_run / pending_buy_item
order_id
fill / filled_shares
execution_status = filled
```

The preview may be linked to an existing StockVision `pendingRunId`, but that
link is for audit only and does not create or mutate the pending buy item.

## POC Flow

```text
1. Screener / ML / Regime / Risk produce primary evidence.
2. Decision Engine emits candidate or human_review.
3. StockVision creates or updates the pending buy lifecycle.
4. Optional FinLab preview runs before simulated execution.
5. FinLab preview returns pass / blocked / warning / error.
6. Worker records one `finlab_preview` audit event.
7. StockVision paper entry task decides whether and how paper fill happens.
```

FinLab `blocked` or `warning` should become visible evidence for later
Decision Engine / dashboard review, but V4-25 does not let it directly write a
paper fill or real order.

## V4.1 Paper-Active Attribution

Paper-active challengers are StockVision-owned decision inputs, not FinLab
execution writers.

Implemented in:

```text
ml-controller/services/paper_challenger_promotion.py
ml-controller/routers/paper_challenger.py
worker/src/lib/paperActiveChallenger.ts
worker/src/lib/paperActiveAttributionWiring.ts
worker/src/lib/controllerDailyWorkflows.ts
worker/src/lib/postMarketChain.ts
worker/migration_paper_active_challenger.sql
```

The attribution layer records:

```text
paper_challenger_candidates
paper_decision_attribution
paper_challenger_daily_metrics
promotion_audit_events
```

Baseline pending buys are also recorded as attribution sidecar rows:

```text
setupMorningPendingBuys
  -> persistPendingBuys
  -> recordPendingBuyPaperAttribution
  -> paper_decision_attribution.paper_lane = paper_active_baseline
```

This is not a second paper trade. It writes no `paper_orders`,
`paper_positions`, `paper_settlements`, pending-buy rows, fills, or execution
state. It only creates the baseline comparison trail needed by
paper-active challengers.

Allowed:

```text
can_influence_paper_decision = true
can_write_paper_attribution = true
```

Forbidden:

```text
can_write_order = true
can_submit_real_order = true
creating a second paper trade lifecycle
```

Automatic promotion can move a candidate to `paper_primary`, but only inside
paper trading. Real trading remains approval-gated.

Runtime flow:

```text
post-market paper metrics
  -> build_paper_challenger_postmarket_report
  -> POST /paper_challenger/postmarket_report
  -> post-verify chain task paper-active-postmarket
  -> promotion_packets / audit_events
  -> recordPaperChallengerCandidate
  -> recordPaperDecisionAttribution
  -> recordPaperChallengerDailyMetrics
  -> recordPaperActivePromotionAudit
  -> recordPaperActivePostmarketReport
```

The persistence helper is migration-tolerant: it does not fail the paper flow
when the new tables do not exist yet.

`paper-active-postmarket` is a non-critical post-verify task. If the Controller
route is unavailable or the promotion report fails, the failure is logged in
scheduler evidence but does not block existing paper trading, verify, adapt,
daily report, or Obsidian sync.

## Production Boundary

V4-25 is a contract and audit-lane implementation only.

It does not:

```text
call FinLab live execution APIs
submit real orders
create duplicate D1 trade rows
replace StockVision paper trade tasks
replace Shioaji intraday quote / orderbook ownership
```
