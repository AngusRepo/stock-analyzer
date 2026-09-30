# Allocator forecast reader rollout

## Scope

Base: `8cdede9b60fd6bdf49b30252a1ce1c75873e7a5a`. The other session's S12 opening-seed and A/B Paper fixes, including its existing build identity record, are preserved by fast-forward integration. This scope does not change native identity inputs or its record. No resource, scheduler, retention-period, model, or native admission changes are included.

This is the first deployment phase: authenticated bounded artifact APIs, complete forecast hydration, default-inline producers, and reference maintenance. It does **not** activate forecast pointers or compact existing source rows. The Python changes require their own verified Controller image rollout before activation.

- Original forecast strings are stored through the existing checksum/readback artifact owner. A pointer is used only when strictly smaller; small and oversized values remain complete inline.
- Three current Worker SQL lineage keys preserve their exact values, including null/missing distinctions. Full Controller consumers restore and verify every original before publishing a private result.
- A writing-run fence covers staging and canonical publication. Terminal runs cannot be reopened by delayed requests.
- Each operation reuses one HTTP client and reads one bounded original at a time. No new full-window data cap is added.
- Existing artifact reconciliation makes bounded, resumable reference progress and reports errors without cancelling the other owner's independent progress.
- Ops0021 provides the partial active-reference index. Deployment verifies the exact indexed columns and predicate.

## Reader-first activation

Without a valid, explicitly approved record at `allocator:forecast-writer-activation:v1`, the write API returns the complete original inline and creates no R2 object or reference. The producer stops subsequent archive requests after the first explicit off response. Reads remain enabled after write revocation.

An activation record must identify the deployed Worker version, configured Controller URL, complete consumer inventory, immutable compatible images, and actual termination evidence for unreachable older readers. The validator checks the record; it does not independently query Cloud Run. The offline audit candidate is not an activation record. There is no activation-write API.

The captured runtime has 870 Controller revisions and 99 traffic/tag entries. Zero primary traffic does not make a tagged URL unreachable. No tags have been removed and no complete old-reader drain proof has been established. New writers therefore remain off. KV revocation is eventually consistent; neither revocation nor an unrelated deployment makes old readers compatible with stored pointers. Subsequent Controller deployments and rollbacks must preserve the new reader while any pointers exist.

## Schema and release order

1. Verify current production/main ancestry and unchanged runtime, bindings and scheduler configuration.
2. Apply only Ops0021 and read back its exact partial index. Do not apply other pending Cold/Weekly migrations.
3. Deploy this Worker through the provenance wrapper after local checks and exact-commit CI success. Read-only `allocator-forecast/preflight` must be ready; `allocator-forecast/gate` must remain off.
4. Deploy and verify the compatible Controller reader image, then audit reachable tags, background work and relevant job entrypoints before proposing pointer activation.

Ops0021 creates an index only. This phase does not delete Learning rows or any payloads. The future allocator outer-archive prototype is excluded: current retention/export allowlists have no allocator feature outer producer. Adding one later requires an outer-to-inner reference and expiry contract first.

## Verification and limits

Focused clean-release integration: 65 Python cases, 13 Worker cases, both TypeScript configs, and 19 retained NAV execution-window cases pass. The gate fixture represents all 870 revisions within 273,012 bytes. The focused Python suites are included in P9/CI. Local P9 completed all Worker cases and 505 of 506 Python cases; its sole failure was the stale native identity record before the other session's `8cdede9b` arrived. After preserving that commit, all seven storage-equivalence cases passed. The remaining frontend build, diff hygiene and secret scan passed separately. Exact-commit CI must pass before deployment; external receipts record final outcomes. Runtime E2E and Bug Hunter CPD are separate gates, not claimed as run here.

No existing 7,319 source rows have been compacted. The earlier approximately 304.6 MB forecast estimate is logical payload sizing, not physical D1 reclamation. The 120-day hot-window budget, all Learning table lifecycles, durable row-retention throughput, and metadata retirement remain open. This release is not ten-year storage closure.
