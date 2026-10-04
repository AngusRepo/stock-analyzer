# Research source enrichment follow-up

Approved scope: missing-data recovery following the 2026-10-04 weekly/monthly repair request. This follow-up does not certify complete research coverage or promote a model.

## Confirmed causes and fixes
- The historical compiler copied all previous symbols' blockers into every issuer enrichment and appended them again. Merge fresh findings once; retain all original blockers. A 12-symbol regression proves bounded accumulation.
- Old issuer blockers lacked entitlement identity and could block a buyer with no entitlement from before the research start. Tag precise action IDs; keep current-day and outstanding entitlement blockers, and fail closed when no mapping exists.
- Official original-holder subscription wording was narrower than observed documents. Add exact date/ratio/price/period forms verified from four immutable MOPS fixtures. Conflicting revisions and prices still fail.
- MOPS can return HTTP 200 with Overrun / Too many query requests. Treat it as rate limiting; bounded 30/60-second backoff, never parse it as a valid changed layout.

## Evidence and verification
- 51 research-history, source coverage and subscription tests; 13 MOPS tests passed.
- Local compiler memory after blocker fix approximately 400 MB versus more than 4 GB before fix.
- Raw issuer documents, FinLab catalogs, official ETF registry and capital packets: main audit workspace `audits/weekend-research-20261004`.
- 424 historical sessions compiled. Coverage audit over 106 sessions (2026-04-30 to 2026-10-01), full input universe, retains blockers. Affected symbols reduced from 311 to 158. No missing entitlement, payment date or fractional treatment is invented.
- Research reconstruction retains actual capture clocks, source hashes, and no live/execution parity credit.

## Release sequencing
The monthly retrain currently owns source 092b981f and immutable prep/OOF continuation identities. Commit/push of this follow-up is allowed, but deploy only after that run is terminal to avoid replacing live Modal function identities mid-training. Check current production before release; preserve all unrelated configuration. No model promotion, NAV backfill or true order submission.
