# 2026-09-24 nightly NAV performance repair

Production source before repair: e4b215440ae23387b4bccf0f2a0428fa789ce5e0.

## Confirmed causes
- Cold allocation contexts are 614–841 MB uncompressed. ijson root construction retained Decimal values and duplicate object keys until a second traversal converted floats.
- Population and policy inventory decoded complete replay histories for a selection census.
- Pinned population censuses retained every decoded context; successive allocation parents also overlapped in memory.
- Nightly accounting, family review and candidate review repeated the same immutable evidence scan.

## Changes
- Convert decimals during parsing and share dictionary keys; preserve Python float and arbitrary-size integer semantics.
- Check full archived byte count/SHA-256, then project only selection/route inventory fields. Execution/comparison readers retain the full payload.
- Pin snapshot IDs, not full objects; release each comparison parent before reading the next.
- Reuse detached verified evidence within one nightly closure with identical query/date/clock/census. No cache across jobs or observer calls.
- Log per-object bytes/read mode/time and overall daily NAV time.

## Measurements (local process, real immutable production data)
Object checksum 23a050b0b5d869a70b27d03ee8f7a48d38a1e78c310c3b5651963be03a91d5e2; 840882553 raw bytes.
- Original full reader: 22.844 s, 4573 MiB process peak RSS.
- Streaming full reader: 34.406 s, 2136 MiB peak RSS. Lower memory, not a single-file CPU speedup.
- Inventory projection: 18.156 s, 242 MiB final RSS (not a sampled peak measurement).
- Actual 2026-09-23 read_verified_nav_evidence, read-only Learning D1/GCS: 378.719 s, 3779.926 MiB peak RSS; completed all prospective contexts and both allocation comparisons, journal checksum 6e9c8dbf76a649580b11933e5665ca9de686a432098583f5eb3a5cb3fe303e95. This measurement preceded releasing the previous comparison parent and nightly evidence reuse.
- No Modal call, retraining, canonical write, promotion, or order in these measurements.

## Verification
51 focused cold/population/evidence/daily-review/policy tests passed; 22 OOF job contracts passed; additional cache mutation/isolation regression and evidence tests 10 passed.
Cold/hot population equality, pinned census parity, full-object corruption in omitted fields, large integers, exact float encoding, and detached cache state verified.
One synthetic fixture needed an explicit canonical-window stub: it runs historical fake inputs and must never query production.

## Boundaries
Cloud Run execution after deployment still must be measured. Historical missing execution windows and strategy evidence 11/13 are not waived by this performance change.
Raw local data/profiling scripts remain untracked; no credentials or large production payloads are committed.
