# Evening-chain performance repair — 2026-09-25

## Root causes and evidence

- Daily NAV spent 1,412.03 / 1,514.95 seconds (93%) in 48 cold reads of 23 unique projections; duplicated reads cost 744.92 seconds. Raw audit: `audits/nav-automation-root-cause-20260925/` and `audits/evening-chain-performance-20260925/`.
- Raw file caching alone thrashes across full inventory (first sweep 540.36s); compact verified definitions/comparisons prevent reloading large parents within the owner. A real 705MB parent definition read fell from 25.688s to 0.234s with identical checksum and 652-byte derived entry. This is a single-read benchmark, not a whole-job SLO.
- Model-pool registry transferred large historical evidence that current UI builders never consume. Complete index + required hydrated evidence retains identical selection and promotion-queue outputs on 200 real rows (86 hydrated), reducing serialized input 13,292,387 -> 8,078,563 bytes. Single query timing did not improve (2.109 -> 2.547s); endpoint verification is required.
- Obsidian outer deadline 25s was shorter than the inner 60s; missing/invalid GitHub credentials could still produce misleading completion. Queries were serial and vault files required two commits. Existing production GitHub token v3 returned 401 for both configured repositories; replacement is pending.

## Changes and safety boundaries

- NAV temporary parsed-object cache: 128MiB total, 64MiB per entry, bounded partial writes; no giant context serialization. Compact definitions/comparisons: 256 entries each, 64KiB each, fresh immutable manifest validation. Atomic/fusion comparisons retain original reads.
- Prior-business-date native L4 retry receipts record complete SQL inputs/results and code identity; fresh read-set equality required, including empty pages and schema/count queries. Changed or uncertain source reruns the owner. No open sessions or successful adoption candidates may reuse a receipt. Existing failed comparisons remain failed; the original durable job still validates current Paper closure and emits its terminal callback.
- Bootstrap integer primary keys use keyset paging with strict order checks; no 100k default truncation. Full source double-check, state checksum and 512MiB byte budget remain. Non-integer/composite keys keep prior paging semantics.
- Obsidian independent reads bounded at 3; one vault commit; required pushes must succeed; outer deadline 65s.
- Runtime phase metrics report duration, process peak RSS and cgroup current/peak memory.
- Exact native source equivalence authorized by Wei on 2026-09-25. New cache/comparison source included in fingerprint. Unknown builds keep their raw identity. Paper approval unchanged: `c3ef38b424890f02620d57c1c1be100548696fa408a9aad7852d0145492066cd`.

## Sizing

Keep pipeline 16Gi: measured 16Gi-container sample reached 9.2134Gi at 2026-09-24T15:58Z. Keep NAV and snapshot at 8Gi; observed Active8 sample was 2.0642Gi. These are monitoring samples, not exact instantaneous peaks. Do not lower pipeline to 8Gi based on a local cold-read benchmark. Reassess only after representative whole-job phase/cgroup peaks demonstrate headroom.

## Verification / release

- 100,007 history rows: old/new complete bootstrap output and private state checksums identical.
- 73 focused tests passed before final fingerprint mutation regression; Worker source/test type checks and post-market observability contract passed.
- Current runtime Paper approval/configuration identity verified unchanged read-only.
- Pending release gate: CI, candidate health/source/tree, 8/8 model readiness, unchanged Paper admission, same image across 11 Cloud Run resources, same source on Worker/Modal.
- Preserve upstream 11,768 predictions and 674 recommendations for Sep24; no retrain, no full-chain replay to benchmark a reader.
- Sep24 achieved recovered closure; first-pass error-free automation is not yet demonstrated. Obsidian external synchronization remains blocked by the GitHub credential until replacement is validated and bound.

## Rollback

Previous release: `9793001a2926b28908372028d70ab0ad2f6a2b67`; preserve prior Cloud Run revision and Worker version. New caches are optional and code-identity scoped. Do not modify frozen evidence, Paper approval, or source data to obtain a green state.
