# Global Context Readiness Contract

Generated: 2026-05-16

## Purpose

V4-19 evaluates whether FinLab `us_*` and `world_index:*` data can replace or
augment StockVision morning setup global context.

The default remains conservative:

```text
worker/src/lib/usLeading.ts remains primary
FinLab world_index augments morning setup and regime context
FinLab us_* can replace current US leading only after explicit gates pass
```

## Replacement Gate

A source may replace current `us:leading:{date}` only when all gates pass:

```text
coverage >= 0.95
max_delay_days <= 1
license_status in allowed / contract_verified / internal_allowed
required US leading fields present
survivorship_check passed for US security-derived sources
```

Required replacement fields:

```text
sox_return
gspc_return
dxy_return
vix_close
hy_spread_chg
```

## Source Rules

### FinLab world_index

`world_index:*` is a P0 augment source for cross-market context. It can improve
morning briefing, regime evidence, LPPLS/Hawkes context, and dashboard global
panels, but it does not replace US leading because it lacks the full current
US-leading surface.

### FinLab us_*

`us_*` is a P1 replacement candidate. It can replace the current Worker
Yahoo/FRED path only after coverage, delay, license, required-field, and
survivorship checks pass.

### Current Worker US leading

`worker/src/lib/usLeading.ts` remains the primary source until a replacement
candidate is selected by `global_context_readiness`.

## Runtime Surface

Implemented evaluator:

```text
ml-controller/services/global_context_readiness.py
```

Main functions:

```text
build_global_context_readiness_report
select_morning_context_source
validate_global_context_readiness_report
```

The evaluator is read-only. It does not fetch live data, write KV, write D1,
or change morning setup behavior.

## Promotion Policy

- `replacement_candidate`: may be considered for replacing `usLeading.ts`.
- `augment_candidate`: may enrich morning briefing, regime evidence, or
  dashboard context.
- `shadow_only`: may be logged or compared, but cannot drive production.

Unknown or restricted license always forces `shadow_only`.

## Non-Goals

```text
Do not replace usLeading.ts just because FinLab has global data.
Do not treat world_index as a US-leading replacement.
Do not let unverified US data affect pending buys or execution.
Do not bypass coverage, delay, license, and required-field checks.
```
