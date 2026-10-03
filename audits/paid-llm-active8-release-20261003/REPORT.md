# Paid provider retirement, OBS polling and Active-8 release

## Reviewed scope

Base production / origin/main: 85e791adfad80335dc0a27cc6ab9de340497ea02.
The source worktree contains only this session's changes; the primary checkout's unrelated edits are excluded.

1. Remove Gemini and Anthropic code integrations, SDK dependency and runtime identity references. Retire paid-only legacy endpoints with HTTP 410; preserve deterministic recommendation/risk outputs.
2. Stop ordinary OBS refresh from fetching full model lineage. Explicit live diagnostics retain verification; omitted evidence never produces a false healthy event.
3. Block Active-8 nightly dispatch while the exact-date pipeline is awaiting premarket. Missing activated Paper plans do not start Cloud Run Jobs or dependency continuation loops. Terminal scheduler tickets fence delayed continuations.
4. Send existing source-grounded news evidence through authenticated controller /news/analyze to Cloudflare Mistral, using the shared account budget. Preserve source citations, validation, immutable receipts, caches and bounded repair.
5. Preserve per-stock debate: two bull/bear rounds followed by judge. No multi-stock prompt redesign.

## Validation before release

- Python: 94 tests passed covering closure, job callbacks, news authentication/bounds and Workers AI budget/inference.
- Worker: 43 tests passed covering zero-dispatch phase gate, terminal tickets, actual callback handling, news evidence/repair/cache, OBS polling and retired endpoints.
- Worker application and test TypeScript checks passed.
- Existing broader allocator admission failures reproduced on the unchanged original baseline; not changed by this release (investigation REPORT.md).
- No database migration, retraining, inference probe, scheduler schedule mutation or order execution is part of this release.

## Release controls

User explicitly authorized commit, push and deployment on 2026-10-03.
Require current remote main and live source ancestors; use a fast-forward push, never force push.
Deploy from a clean main checkout; retain immutable commit/tree/scheduler provenance.
Verify actual production traffic and runtime source, not only successful build/deployment commands.
Runtime receipts are recorded separately after deployment to avoid modifying the source identity during release.

## Investigation pointers

Local: C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/audits/gemini-removal-lineage-20261003/ACTIVE8_NEWS.md
Wiki: 02_Products/StockVision/Sessions/2026-10-03-active8-premarket-phase-and-cloudflare-news.draft.md

The 497 / 8.90-hour lineage figure covers Taiwan Oct 2 15:00 to Oct 3 02:00.
Taiwan Oct 2 full day is 981 / 17.72 hours. Request latency totals are not billable instance hours.
