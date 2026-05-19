# FinLab Execution Adapter Contract

## Scope

V4-26 defines a preview-first FinLab execution adapter contract.

This is not a live trading adapter. It parses FinLab-side preview output and
turns it into StockVision-visible evidence before any future real-order path.

## Policy

```text
schema_version = finlab-execution-preview-v1
mode = preview_first
allowed_statuses = pass / blocked / warning / error
live_submit_enabled = false
requires_explicit_real_order_approval = true
allowed_use = execution_preview_only
adapter_surfaces = OrderExecutor.preview, PortfolioSyncManager.preview
```

## Status Semantics

| Status | Meaning | StockVision action |
|---|---|---|
| `pass` | FinLab-side preview did not report a blocking condition. | Do not submit automatically; require a separate approved handoff. |
| `blocked` | FinLab preview found a condition such as cash, T+2, broker, or rule failure. | Do not submit; surface `visible_reason`. |
| `warning` | FinLab preview found a non-blocking risk or caution. | Do not submit automatically; surface warning in dashboard / decision context. |
| `error` | Preview response is unknown, malformed, or failed. | Fail closed; do not submit. |

## Implementation

Implemented in:

```text
ml-controller/services/finlab_execution_adapter.py
ml-controller/tests/test_finlab_execution_adapter.py
```

The adapter normalizes raw FinLab preview responses into:

```text
schema_version
allowed_use
symbol
side
status
submit_decision
can_submit_real_order
visible_reason
blocked_reasons
warnings
raw_status
audit_event
```

`can_submit_real_order` is always `false` in V4-26. A `pass` preview returns
`submit_decision = manual_or_separate_confirm_required`, not submit.

## Contract Violations

The adapter rejects/quarantines preview payloads that contain live-order
effects:

```text
submit = true
submitted = true
live_submit = true
order_submitted = true
order_id
broker_order_id
submitted_order_id
live_order_id
```

These become explicit contract errors:

```text
finlab_execution_preview_must_not_submit_live_order
finlab_execution_preview_must_not_return_live_order_id
```

## Relationship to Paper Trade

V4-25 owns paper-trade preview/audit boundaries.

V4-26 is for future real-order feasibility preview only. It does not:

```text
write paper_orders
write paper_positions
write paper_settlements
submit real orders
replace StockVision risk checks
replace Shioaji intraday quote / orderbook ownership
```

## Promotion Gate

Before any real execution path can use this adapter:

```text
1. FinLab preview API surface must be verified with live SDK docs/runtime.
2. Secret/auth flow must use the post-2026-08-01 FinLab login path.
3. Blocked/warning/error reasons must be persisted and visible in dashboard.
4. Decision Engine must explicitly approve handoff.
5. Wei must explicitly approve real-order capability.
6. V4_OPS_SAFETY_CONTRACT.md must pass with kill switch inactive and audit log enabled.
```
