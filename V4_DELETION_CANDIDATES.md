# V4 Deletion Candidates

Generated: 2026-05-17

Rule: delete only after the replacement has live readback. Until then, keep old paths as audit/fallback or compatibility.

| Candidate | Current Role | Replacement | Delete Condition |
| --- | --- | --- | --- |
| Standalone Family Balance panel | Duplicated family distribution UI | Family color strip inside Model Health Matrix and Serving Alpha Strip | Closed locally; no render path remains. |
| Separate Champion Pointer panel | Duplicated pointer readiness UI | Serving Alpha Strip pointer line plus Artifact Lifecycle Summary | Closed locally; keep component code only until next UI cleanup pass. |
| TWSE/TPEX primary structured ingestion | Legacy primary daily source | FinLab primary structured daily data plus TWSE/TPEX audit/fallback | Delete primary routing after FinLab 3Y/5Y backfill and diff readback pass. |
| `buzz_evidence` as sole screener reason | PTT/news/Anue only heat signal | `theme_signals` and `stock_theme_features` multi-source evidence stack | Delete compatibility wording after screener reason payload exposes provenance in production. |
| Read-only Dagster factory wording | Early V4 asset factory naming | FinLab Dagster Asset Runtime formal-shadow definitions | Closed locally; remaining historical wiki session names are not runtime code. |
| Old validation combined MC/PBO badge | Mixed validation verdict | Split PBO alpha credibility, MC tail risk, backtest consistency cards | Closed locally; verify on mobile screenshot after CPD. |
| Contract-only external evidence examples | Local proof payloads | `external_evidence_items` plus `theme_signals` ingestion | Delete examples after Finnhub/official/IR/GDELT scheduler readback. |
| Legacy canonical feature write assumptions | 106-feature production namespace | `baseline_106` plus FinLab diversity namespace and promotion gate | Delete only after paper-active challenger proves feature quality. |

## Keep As Fallback

- TWSE/TPEX official audit/fallback.
- Shioaji proxy for intraday quote and five-level orderbook.
- Original 106 features as baseline namespace.
- FinLab execution preview as audit/shadow until explicit execution handoff is approved.
