# 2026-09-22 storage, model-pool and strategy evidence follow-up

Status: approved release 3721f6c3 deployed and read back; ten-year closure remains false.
A separate follow-up compaction repair is local-only and is not included in that release.
Release base: 046097ee88e36e6ecaa3cabf08a6b3c98756f046. Approved additive migrations and code deployment completed. No retraining, model promotion, real orders or general retention deletion.

## Model pool
Production lineage returns 502 because Controller raises `active8_nav_current_configuration_changed_or_unverified`. The only changed publication configuration field is native execution owner. The storage deployment changed the compiled Worker and cold transport identity, although model/allocator/risk/trading settings are unchanged. Reconstructed 6f295db5 exactly reproduces the frozen owner 7000a685...; deployed 046097ee exactly reproduces aae2cc6a....

Repair: exact component-vector storage equivalence certificate, preserving raw runtime hashes and unknown-build rejection; ASGI sync reads offloaded to bounded threadpool; original publication evidence read in two complete SQL snapshots, with schema recheck, instead of individual HTTP queries per table; per-request HTTP connection reuse. Worker model-pool GET timeout 60s; mutation endpoints unchanged. No NAV efficacy test or model gate is waived.

Read-only production-data test: 8/8 models eligible. Last measured read 27.44s, before adding the repeated schema query. Earlier profile: 54 to 26 D1 queries, with four schema rechecks now restored for concurrent schema protection. Cold-start latency still requires production measurement after release.

Actual old/current native binaries: settlement/retry/next-day and equity snapshots have identical state, checksums, frame receipts and zero fabricated NAV credit. Unknown native source remains invalid.

## Strategy lab
At 2026-09-22 17:11 TW formal prices ended 9/21. Signal 9/14 enters 9/15 and five-session exit is 9/21. Latest mature signal 9/14 is therefore consistent with the current price frontier.

9/15-18 have original canonical references and matrices but no decision/stat projections. Production recovery reader also incorrectly only accepts `strategy-labeler-v1`; real stored artifacts use the formal v3 labeler. Exact downloaded 9/15 artifact and route packet verify locally after accepting the explicit current/legacy formal producer versions: 802 candidates, 26 strategies, 20,852 cells, 802 route scores, valid checksum and parity. Unknown versions remain rejected. This reader fix alone is NOT proof of complete historical evidence rebuild; normal recovery must still verify PIT, policies, grid and outcome coverage.

## Retention
Add source-local immutable release receipts in the SAME D1 batch as exact row deletion. Lost HTTP/OPS acknowledgement can no longer make a committed archive unreadable. Receipt failure, concurrent row changes or partial deletion roll back. Immutable receipt rejects replace/update/delete.

Add additive migrations: Market0008, Learning0050, Execution0003, Ops0015, Research0005. Schema generation retains immutable migration equality checking and reviewed existing schema content. All five migrations applied remotely; table, index and three immutable triggers verified in each domain. All five source-release tables have zero receipts; no general data release was executed.

Cold market projection preserves natural-key hot precedence, checksum, original schema/date/value semantics and explicit errors. Connected to snapshot export and original backtest price/indicator/chip readers. Cold predictions also reach OOF native PIT input. Consumer closure remains incomplete: Worker historical consumers, reference protection, reconciliation, automatic catch-up, OOF/legacy executors and capacity proof must close before general deletion is enabled. Scheduler remains preflight only.

## A/B
No eligible allocation/execution pair or paired daily journal row exists in the production read. Three 9/21 manifests are allocation contexts only. New prices alone cannot create the first formal A/B NAV observation. Late B slate may be evaluated diagnostically but cannot become retrospective prospective evidence.

Existing review policy: fixed first look at 10 paired portfolio sessions, final checkpoint 30, total family alpha .05 split across the two looks, stationary bootstrap block length 3, 19,999 resamples and family correction. These are checkpoints, not guaranteed significance. Do not count stock rows as independent daily portfolios or repeatedly test daily at 5%.

## Verification
- Python grouped regressions: 70 passed (native, exact publication transaction, OOF materializer, snapshot job contracts); separate 53 passed (retention readers, environment, NAV readiness); market reader integration 8 passed. Groups overlap, not an assertion of 131 unique tests.
- Worker targeted 17 passed; source-release 4 passed again after replace protection test.
- Worker source and test TypeScript checks passed.
- Schema generation repeat build test passed; immutable migration drift check retained.
- Read-only actual production lineage and actual R2 9/15 artifact verification passed locally.
- No closure claim or production result inferred from local tests.

Raw source pointers: `audits/closure-followup-20260922/` (local only, excluded from release): runtime.json, diagnosis.json, lab-gap.json, lab-recovery-preflight.json, lab-artifact-index.json, local-pool-proof.json, release-native-parity.json. Earlier release receipt: `audits/ab-capacity-closure-20260922/storage-after-runtime.json`.


## Production release receipt — 2026-09-22
- Git: 3721f6c3caaa93c57171945c1195adecdec40cfa, atomic non-force push to main and codex/nav-storage-20260922.
- Worker: a26c3640-0d5c-434a-a0e6-8b4190321f72.
- Controller: ml-controller-sv-3721f6c3caaa-20260922101917, exact revision traffic and HTTP provenance checked by release script.
- Image: sha256:f22ad12f264565fc644104fc51a0cf5de0e7284a52bfd10d781dd63dd0435b40. Related Jobs synced and verified; not executed.
- Both Modal apps deployed with the exact source tag; program provenance verified. No training or GPU work launched.
- All five model-pool GET probes returned 200. First lineage under parallel probes: 50.77s; isolated warm lineage: 20.67s. 8/8 models serving eligible. This proves recovery, not a latency SLO or exhaustive load test.
- Serving ensemble pointer, admission evidence and promoted_at equal the pre-release values.
- Production artifact preflight: all four 9/15-18 canonical artifacts and route packets read correctly; original decision grid and outcomes remain incomplete. Read-only rebuild preview lists 9/15, 9/16, 9/17, 9/18, 9/21. No historical rebuild queued in this release.
- Latest formal prices advanced to 9/22. Mature labels still end at signal9/14; only9/14 has successful historical evidence rebuild. Normal five-session maturity alone no longer fully explains why9/15 has no labels: its decision/outcome reconstruction is still pending.
- Paired NAV journal remains0. No new valid A/B portfolio observation from price ingestion alone.

## Additional local repair — NOT deployed
`legacyStrategyEvidenceMigration.ts`: preserve the original PIT reconstruction and consumed diagnostic fields in compact pointers; checksum-verify backup before replacement; use the protected ten-year R2 class; exact original JSON predicates prevent overwriting concurrent corrections; refuse cursor advancement when source rows changed. Six focused tests plus source/test TypeScript checks pass. Tests cover SQL PIT recognition, exact backup readback, normalized model input, corrupted backup rejection, concurrent edit preservation, lost ACK retry, and absent proof remaining absent.

This is one reader/compaction compatibility repair, not complete ten-year consumer closure. Its compiled Worker identity requires the normal exact economic-equivalence review before a future release.

## Capacity and remaining closure
Production Learning size after additive migration:6,393,884,672 bytes. Approximate measured text payloads: strategy decisions1,568,797,754 bytes; allocator feature snapshots626,838,364 bytes; strategy matrix308,874,530 bytes; candidate contexts195,227,869 bytes. These exclude indices and other columns. Most are inside the120-day hot window. Age-based drain alone cannot establish sustainable capacity.

Remaining required work:
1. Bound current hot payload growth, not only old rows; compaction readers and PIT proofs must remain valid. Do not enable old compaction blindly.
2. Complete Worker historical consumers and SQL coverage across each policy; cold market manifests need indexed coverage filtering and deduplication memory bounds.
3. Protect live hard references, execution parent/child records and last-known fundamental anchors at source release.
4. Reconcile source receipts after lost Ops ACK and prove bounded recurring catch-up throughput.
5. Replace legacy OOF retirement behavior before using it for storage: current helper changes training eligibility and is not a pure archive executor.
6. Verify all required archive policies operational, stable post-cutover growth and at least90-day warning runway. Nine of ten policy executors were not operational in the last closure receipt. No relaxed threshold or age-only blanket deletion.

Additional raw evidence: controller-deploy.log, worker-deploy.log, release-readback.json, runtime-after.json, pool-warm-readback.json, lab-recovery-preflight-after.json, postdeploy-data-state.json, cold-backlog.json, learning-text-sizes.json under the local audit directory. One additional full-table grouped compaction-size query failed with D1 internal error; no result was inferred and it was not repeatedly retried.

## Continuation — 2026-09-22 (local work; no new release)

Correction: raw 9/22 quotes do not establish five-session maturity. The canonical
FinLab session catalogue still ends 9/21;9/15 five-session labels must await the
verified 9/22 source. The configured evening root is21:00TW. No synthetic session,
zero-return outcome, or retrospective prospective NAV was inserted.

- Original recovery owner completed 9/15–18:20,852+20,878+20,826+20,956=83,512
  decisions. 9/21already21,008. The label trigger reports pending802for9/15.
- Paper account1 has9/22total_value966,998.13, unchanged from9/21. Paired A/B
  journal0, three allocation_context seals and no allocation/execution pair.
- Local lineage same-source baseline33.78s/30queries/48,399,522bytes versus
  optimized18.50s/20queries/20,878,724bytes; exact8model output equality.
  Request-only memoization rechecks every source; no TTL or inference-grant cache.
- Local storage fixes: PIT-preserving CAS compaction, skip compact matrix rows,
  indexed cold manifest dates, bounded dedup memory, last500market observations,
  180pre-window fundamental rows per source, resolved execution child-first FK
  order, source-proof→Ops reconciliation, and3650day archive policy alignment.
- Dedup100krow microbenchmark: Python peak21.23MB→3.00MB (SQLite cache capped
  separately at2MiB),0.234s→1.703s. Small reads stay in RAM. This is a memory/cost
  tradeoff, not a claim that disk hashing is faster or a whole-pipeline benchmark.
- Python54pass; native equivalence4pass. Worker43focused checks pass after
  tracing the stale244table assertion to the already-deployed orphan archive
  table; its unique Learning owner is now explicitly checked. Source/test TS pass.
- New migrations prepared, not applied: Market0009,Execution0004,Learning0051,
  Research0006,Ops0016/0017. Native economic outputs and compiled identity still
  match the deployed runtime. No model/admission changes.

Still working: remaining historical readers/reference coverage, pure-storage OOF,
recurring catch-up and steady-state capacity. General deletion stays disabled.
Full ten-year closure remains false; this is an ongoing task, not final delivery.

Raw evidence: audits/closure-continuation-20260922/lineage-comparison.json,
historical-recovery-start.json,historical-recovery-next.json,maturity-calendar.json,
current-nav-pipeline.json,evening-readiness.json,cold-dedup-benchmark.json,
release-native-parity.json.
