# External Evidence Contract

## Scope

V4-28 defines how external event/news sources enter StockVision.

These sources are evidence, not alpha owners.

```text
Finnhub
Official RSS
Company IR RSS / Newsroom
GDELT
```

## Policy

```text
schema_version = external-evidence-contract-v1
frontend_api_keys_allowed = false
direct_alpha_allowed = false
direct_trade_signal_allowed = false
decision_effect = context_manual_review_or_shadow_only
```

Required cleaning rules:

```text
dedup_by_canonical_url
source_quality_score
entity_linking_confidence
spam_or_syndication_filter
published_at_freshness_check
```

## Source Registry

Implemented in:

```text
ml-controller/services/external_evidence_contract.py
ml-controller/tests/test_external_evidence_contract.py
```

| Source | Mode | Allowed Use | Boundary |
|---|---|---|---|
| Finnhub | backend-only | `event_context_only` | API key never goes frontend; no direct alpha. |
| TWSE / TPEX / FSC / MOEA RSS | official audit | `official_event_audit` | Official event context and manual review. |
| Company IR RSS / Newsroom | first-party company context | `watchlist_first_party_context` | Watchlist/manual-review; require domain allowlist. |
| GDELT | shadow | `shadow_global_event_context` | Global event/tone/theme context only; high-noise source. |

## Normalized Evidence Item

Every item must carry:

```text
source_id
source_kind
title
published_at
allowed_use
decision_effect
direct_alpha_allowed = false
promotion_gate
trace.source_url
trace.symbols
trace.provider
trace.authority
features.tone
features.themes
cleaning.dedup_key
cleaning.source_quality_score
cleaning.entity_linking_confidence
cleaning.spam_filter_status
cleaning.domain_allowlist_match
```

## Packet Builder

`build_external_evidence_packet` is the first V4-28A quarantine gate.

```text
raw_items
  -> normalize_external_evidence_item
  -> validate_external_evidence_item
  -> accepted items / rejected_items
  -> quality_summary
```

The packet carries:

```text
schema_version
generated_at
decision_effect = context_manual_review_or_shadow_only
direct_alpha_allowed = false
items
rejected_items
quality_summary.total / accepted / rejected / by_source
```

Rejected items stay inspectable, but do not enter downstream context.

## Validation

The packet validator blocks:

```text
unknown source_id
direct_alpha_allowed = true
decision_effect = trade_signal / direct_alpha / auto_order
missing trace.source_url
missing published_at
missing cleaning.dedup_key
missing cleaning.source_quality_score
missing cleaning.entity_linking_confidence
spam / syndicated_spam / blocked
company_ir_rss without domain_allowlist_match = true
```

## StockVision Integration

The intended flow is:

```text
Dagster fetch / clean / score
  -> external_evidence_items
  -> theme_signals / stock_theme_features / risk context
  -> LangGraph Debate / Decision Engine context
  -> watchlist / human_review / no_trade / candidate context
```

External evidence cannot directly:

```text
write recommendations
write regime
write ML labels
write pending buys
write paper orders
submit real orders
```

## Promotion Gate

Before any external evidence feature graduates beyond context:

```text
1. Source license and usage terms are verified.
2. Backend-only secret handling is confirmed.
3. Dedup and syndication filtering pass.
4. Entity linking confidence is measured.
5. Event taxonomy is stable.
6. Backtest/shadow evidence proves incremental value.
7. Decision Engine contract review passes.
```
