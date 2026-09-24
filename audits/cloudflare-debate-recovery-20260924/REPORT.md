# Formal debate recovery — 2026-09-24

## Verified cause
Production 56b26be2 still uses the Gemini-only debate client; pending buys for 2026-09-24 (7792, 3576, 2485) repeatedly failed because GEMINI_API_KEY is absent. The previously authored Cloudflare implementation remained uncommitted in strategy-ab-release-20260921.

Wrangler OAuth can query account-wide AI analytics. The separate production secret stockvision-cf-api-token cannot; its GraphQL response is not authorized for that account. Both user/account token-management endpoints reject that production credential with HTTP 403. No dedicated Workers AI secret exists in GCP. No secret values are recorded here.

## Changes
- Restore Cloudflare-only Mistral/GPT-OSS swapped two-round debate with independent Llama judge.
- Require all five turns; no paid-provider fallback. Cache successful turns by exact policy/input identity, but never cache an unparseable judge.
- Before each attempt, read account usage and atomically reserve a conservative neuron bound in Ops. Warn at 6000, stop at 8000; keep reservations after ambiguous failures. No hard provider billing-cap claim.
- Bind a dedicated stockvision-workers-ai-token on every deploy and check enabled secret existence before container build.
- Native replay records model/role identity and includes quota code in execution identity.
- Add Ops migration 0019; synthetic native entry fixture now includes the existing dated-regime schema and successful source pipeline receipt.

## Verification
46 focused Python tests passed (39 debate/budget/capture, 2 deploy, 5 native entry including full 281-frame session). Worker type check, domain registry contract, bash syntax and diff hygiene passed. Full P9 runs on PR.

## Deployment gate
Create/provision a durable token with Workers AI inference and account analytics access in GCP Secret Manager stockvision-workers-ai-token; grant existing Controller and pipeline runtime service accounts secret access. Apply Ops 0019 with readback. A local personal OAuth token is not a permanent production service credential.

## Sources
PR16 production SHA 56b26be27e372473fb5938a3710b6840e362eb54; ml-controller/services/debate_service.py, llm_debate_client.py; existing Cloudflare draft in worktrees/strategy-ab-release-20260921. Wiki: 02_Products/StockVision/Sessions/2026-09-22-debate-cloudflare-quota-guard-and-learning-nav-storage-gap.draft.md and 2026-09-22-nav-cold-storage-swapped-debate-local-closure.draft.md.

## Evening evidence publication and resource correction
The live finalizer applied the historical Taipei start-of-day publication cutoff to a policy being published in the evening. New S02/S06 versions therefore failed 11/13 despite complete prior-day outcomes published that morning. Add an explicit publication timestamp for the live policy owner, retain outcomes strictly before its business date, cap late recovery at that business day's end, and freeze that timestamp in the evidence/source checksum. Historical readers keep their original start-of-day cutoff; calibration promotion remains unchanged. The policy serving reader still requires both policy date and actual creation time before the consuming signal date. Recovery preview opts in with publication_evidence=true; it cannot choose a future clock.

Production readonly query on 2026-09-24 confirmed all 13 active exact-version profiles have 5 metrics for outcome 2026-09-23 under the publication cutoff (raw local receipt: audits/evening-performance-20260924-runtime/publication-proof-readback.json in original workspace). SQL boundary tests exclude same-day outcomes, later publications, and next-day recovery inputs; frozen-source replay tests carry the new timestamp.

Active8 job memory reduced to 8GiB, CPU4 and timeout3600 unchanged, exact production image preserved. Local parser measured peak2136MiB versus4573MiB before; readonly complete evidence replay peak3779.926MiB; previous successful production execution16m23s max minute-sampled mean1613.4MiB, not instantaneous peak. No extra paid job run or Modal training was started just for downsizing. Deploy default now8GiB for Active8 only; pipeline/mining unchanged. Tonight at8GiB is still to be observed, no guarantee against unrelated future OOM/timeouts.
