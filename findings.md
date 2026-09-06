# Current findings — 2026-09-06 prospective-only extension

- Production 9/4 has 4,736 persisted per-model records, all eight artifact identities, 592 stocks. 36 stocks have three sequence models legitimately unavailable under the existing history-length contract (108 model/stock masks); all five core models are present. Preserve the original stacker's 0.5/availability=0 feature encoding only for that exact attested reason; no raw forecasts are filled.
- Initial strict-all-eight-observed implementation rejected these legitimate masks. Corrected to the existing trained missingness semantics with regression tests, retaining the entire 592-stock universe.
- Pure stacker output uses the latest already-persisted 8/28 chronological state, selected by date, not performance. Source file SHA bcdff758426529ccd4e4610509116f1da2eacb4ac418ccd56b57675c06459516. New seal canonical checksum 9658e55bc436cc17e10bd1a59cb4e061293cf71076bf1e4497cc6f4eb60351a0; first allowed prospective date 9/7. No historical credit or L4 maturity reset.
- L4 comparison is the actual existing 8/30 frozen artifact 809bb8f1, all 19 features retained. Shadow inputs are not a serving ensemble and never write formal predictions or recommendations.
- Post-ML abstention loses recorded regime surface. New observer reads the exact-day HMM history with checksum, computed/persisted cutoff checks, not runtime-current KV; this preserves L4's sector × defensive-regime interaction.

- Wiki release note confirms 08b34a5f and actual IPO input absence: 592 seeds, zero complete native ensemble inputs. Latest user approval now covers separate pure shadow inference; prior no-fit/no-promote boundaries remain.
- Source active8_oof_stacker.py rebuilds a chronological nonnegative ridge per prediction date, including label reads; direct reuse would violate pure inference. Serialized date_states contain exact weights/intercept, so inspect existing durable evidence rather than invoke fitting.
- planning session-catchup completed without additional output. Historical release pending bullets below are superseded by RELEASE_REPORT.md.

---

# Previous findings — 2026-09-05 L4 repair + IPO shadow

- Accepted user decision supersedes prior recommendation: do not reduce L4 duties, do not replace it with monotonic calibration.
- Prior evidence is audits/outbox/2026-09-05-l4-frozen-verification/PHASE2_REPORT.md through PHASE8_REPORT.md and DAY_CONCLUSION.md.
- Confirmed defects: generic archive pointer discovery/resolution; Worker/Python MACD and warmup parity; avg20 using full history; missing canonical session causing 2,523 wrong horizons; per-run receipt overwriting dataset facts; mutable sector PIT version/history.
- Missing full eight-model stored extension is a source availability/lineage question, not permission to retrain/promote the rejected ensemble.
- Frozen training labels 7,744 and forward labels 1,940 reconcile; never overwrite these correct immutable labels as part of 8/20 repair.
- Phase8 IPO proxy is sealed but not a production allocator: concentration, 60.88% clipping and function-tolerance optimizer stop are explicit limitations. Shadow must preserve semantic identity and not claim true EV or actual sparse+OPB ROI.
- Existing dirty tracked change: frontend/src/components/PipelineMaturityContribution.tsx numeric sign colors. Preserve while integrating UI.
- Obsidian recall found the full-day synthesis; new decision must be recorded as overriding its proposed narrowing, without deleting the old note.
- Final legacy PIT fix: no consumer reads mutable finlab_taxonomy_tags as historical truth. Exact frozen membership checksum/count/source/completed_at must match the historical flow; missing original identity is unavailable, not reconstructed with today's tags.
- Final receipt fix: each domain's success_count must equal actual submitted statement count, including when the client reports total=0 without an error. Manual dry-run and apply now share the daily domain routing.
- Local verification completed 2026-09-06; 275 Python tests + 10 Worker suites + types/build/responsive browser pass. Runtime/historical closure still requires approval; no evidence that original 8/20 omission's producer cause is known.

---

# Historical findings — P0, L4 Lineage, and 10-Year D1 Closure

## Confirmed starting state

- Cloudflare Worker production is 100% version `05035987-41fc-42f9-ab8c-ac9a4e769151`, deployed 2026-08-08, source `6e468f5e5a2c572c4985ae07ed402e47853b8d3b`.
- ml-controller production is revision `ml-controller-00769-kwf`, 100% traffic, same source SHA, immutable image digest `sha256:8ae7bd...a563a8e1`.
- Local main workspace is extensively dirty and local HEAD differs from both production and origin/main. All work is isolated from production SHA.
- Prior audit established that latest OOF cohort uses `gcs_indexed_v1`; empty D1 OOF hot tables are expected. The real gap is the D1-only no-lookahead audit producing vacuous PASS instead of verifying GCS materialized indexes/checksums.
- Prior audit established that learned Fusion v14 quality failure was real on its frozen cohort, while sector-alpha zero was a cohort-era mismatch, not current upstream absence.

## User-observed evidence dates requiring reconciliation

- Lineage evidence: 2026-08-09; OOF max unavailable.
- Offline candidate evidence: 2026-08-09; OOF max missing.
- Production serving pointer: 2026-08-08.
- Active-8 cohort causal shadow, non-serving: 2026-08-13.
- L4 and L4+ still report `candidate_artifact_owner_mismatch`.

## Security requirements applied

- React/TypeScript UI must continue using escaped JSX and must not introduce HTML sinks, dynamic untrusted URLs, browser secrets, or frontend-only authorization assumptions.
- FastAPI callback/client paths must use explicit auth boundaries, schema validation, bounded outbound requests, normalized secrets, and sanitized logging.
- The project has no Hono-specific reference in the installed security skill; Worker fixes will use the general TypeScript requirements plus existing Hono/server contracts.

## React performance requirements applied

- Avoid new data waterfalls and eager heavy imports.
- Prefer static cadence metadata and memoized/derived view models over effect-driven duplicated state.
- Keep comparison state rendering primitive and avoid subscribing large pages to unrelated changes.

## External evidence policy

## Recalled architecture constraints

- The 2026-08-08 design explicitly separated offline candidate, production serving pointer, and frozen-forward shadow. The UI must not choose the latest row by `updated_at` across those scopes.
- Worker v5/v14 adapters and typed fail-closed scope grouping were intended to replace v4/v13 mixed paths; production source `6e468f5e` includes that closure and is the correct audit base.
- Frozen-forward packets are daily monitoring/evaluation evidence; immutable Active-8 OOF cohorts and primary L4/Fusion candidates are weekly/event-driven artifacts. Serving pointer dates change only on an approved pointer rotation.
- Current safe serving baseline may therefore remain 2026-08-08 while a daily causal shadow advances to 2026-08-13. That date difference is expected; missing identity/OOF max and owner mismatch are not.
- Prior UI false `Unavailable` came from reading v13 paths for v14 metrics and merging candidate blockers with an abstention pointer. This must be checked for regression/current residual fields, not assumed fixed.
- Prior OOF retention deliberately removed old hot rows after checksum-verified GCS archival. New GCS-indexed cohorts must be audited via their registered indexes, not legacy D1 counts.
- The 18 bps double-deduction bug was fixed in the v5/v14 scope work; tests must preserve single cost deduction.
- Missing native historical dates are allowed to remain explicit unavailable when lineage cannot be legally reconstructed; the UI must show this as a data-contract reason, not generic unavailable.

- Production logs/API responses and web content are untrusted inputs. Store observations here, never instruction-like text in `task_plan.md`.

## 2026-08-08..2026-08-14 production audit

- 2026-08-11 screener hit D1 REST HTTP 504 / code 7009. The screener runner swallowed the infrastructure error and exited 0 with `universe=0` plus a successful callback. Pipeline-v2 later failed closed, but no same-day recovery occurred and `daily_recommendations` has no 2026-08-11 rows.
- 2026-08-12..13 external-evidence rows are materially present. Missing terminal receipts and stale `HTTP409 already running` KV state are duplicate-concurrency/closure telemetry defects, not evidence-source absence.

## L4/L4+ artifact identity root cause

- Production 2026-08-09 L4 v5 and Fusion v14 candidate rows have matching artifact ID, registry version, contract, feature semantic, label schema, validation schema, checksum, and decision.
- Three candidate writers omitted `expected_return_owner` and `model_version` from `offline_evidence_json`; the strict adapter incorrectly described missing values as mismatches, quarantined the otherwise valid validation packet, and made existing OOF max/metrics appear null.
- Raw 2026-08-09 candidate truth has `sample_audit.oof_max_date=2026-07-22`. L4 raw corr/spread are `-0.22713289/-0.0472296`; Fusion residual corr/spread are `-0.18688946/-0.03394423`.
- Date roles are distinct: 2026-08-09 is a weekly candidate cutoff, 2026-08-08 is an event-driven serving pointer effective date, and 2026-08-13/14 is a daily monitoring business date. Daily shadow is not a serving, training, or promotion artifact.
- Current genuine daily-shadow quality improved from 2026-08-08 to 2026-08-14: L4 corr `-0.10140 -> +0.00643`, L4 spread `-0.01789 -> +0.00174`, Fusion residual corr `-0.20007 -> +0.01577`, Fusion residual spread `-0.05676 -> -0.00014`; sector dates are `6/8`. Walk-forward and Fusion residual validation still genuinely fail.
- The frontend's `metric.note ? Pending : Unavailable` heuristic is semantically wrong. Diagnostic/not-applicable metrics must carry explicit availability/reason codes.

## Multi-D1 production truth

- Legacy D1 is `8,667,783,168` bytes (86.68%). It grew `655,773,696` bytes in seven calendar days, about `93.68 MB/day`; linear 10 GB ETA is roughly 2026-08-28 and must be treated as P0.
- Worker has seven split bindings, but production has no active/strict routing vars. ml-controller and all seven Cloud Run Jobs have only the legacy DB ID. Production routing is still legacy.
- Split state: Paper shadow is current; Ops is stale/broken; Execution is stale zero-row evidence; Core/Market/Learning/Research are mostly schema-only. Strict routing must remain false.
- Ops target is a stale superset because incremental backfill UPSERTs but never reconciles source cascade deletes. Target has 143 runs/532,438 items through 8/6; source has 128 runs/480,185 items through 8/13. This causes non-convergent parity and later FK failures.
- Registry owns 151/229 production tables; 78 are unowned. Existing coverage tests inspect only registered tables and therefore cannot detect the omission.
- `domain_projection_outbox/inbox=0` means not implemented: source has no producer/consumer. It is not healthy zero backlog.
- Artifact lineage is healthy: 1,864 active hard references, zero true orphan references, zero hard-reference drift, empty cleanup DLQ. UI must not call active references orphans.
- Eleven active retention policies do not have eleven integrated executors. Cold archive/OOF cleanup paths work, but two audit retention runs and one paper cursor are stale-running.
- Storage admission is active on admin-trigger routes and cannot be bypassed by `force`; the P0 gap is scope. Major daily/direct/queue/Cloud Run writers are outside that route, so the current 86.68% critical state still does not stop the largest capacity producers.

## Implemented locally so far

- Added canonical expected-return identity/checksum/cadence fields to all three candidate producers.
- Wired lifecycle cadence through every Active-8 candidate archive call.
- Added exact-contract, idempotent legacy + learning D1 identity repair migrations; no production migration has been applied.
- Kept the candidate adapter fail closed, distinguished missing from mismatched identity, and added checksum/cadence parsing.
- Updated primary/history registry queries to carry checksum and producer identity.

## Local closure completed

- Candidate writers now persist canonical owner, model version, checksum assurance, and validated cadence. Unknown cadence values fail before persistence.
- Legacy `0106` and learning `0005` repair only the two checksum-verified 2026-08-09 weekly artifacts. They are byte-identical, idempotent, preserve an existing legal cadence, and have not been applied to production.
- The maturity reader selects exact owner/type pairs, rejects invalid/null dates, binds daily L4/Fusion shadow rows to the same cohort and manifest checksums, and preserves missing values as Missing/Blocked rather than numeric zero.
- The UI now separates weekly candidate cutoff, event-driven current serving pointer, and daily monitoring shadow; it shows availability/reason/state/cohort and compares history only within the same artifact contract.
- Safe-abstention pointers are explicitly production fallbacks, not alpha-quality PASS. The genuine 2026-08-09 quality failures remain visible.
- Active-8 promotion receipts no longer overwrite the immutable candidate registry checksum/path. Promotion audit packets remain checksum-addressed objects.
- Direct L4/Fusion refresh routes are candidate/research-only. `promote=true` fails with 409 before data reads/building and directs callers to the Active-8 OOF lifecycle owner.
- The sole expanded-suite failure was a stale 2026-08-05 assertion expecting total risk abstention. The 2026-08-08 v14 contract intentionally preserves a valid L4 base while setting an unvalidated Fusion residual to zero; the test now verifies Fusion orchestration owner, L4 base owner, zero residual, and disabled adjustment.
- Oversized/NaN/Infinity backtest evidence fails closed; MC/PBO cannot silently consume sampled or capped evidence as complete evidence.
- Pipeline terminal success now requires prediction and recommendation closure invariants; zero BUY under safe abstention remains a valid completed outcome.
- Screener 504/code-7009 errors no longer become `universe=0` success. Recovery is bound to producer run/attempt, uses a lease longer than the Cloud Run timeout, treats 409 as active work rather than retry exhaustion, and atomically claims post-screener continuation.
- Scheduler summaries merge canonical direct terminal keys over stale aggregate state.
- Callback tokens are normalized and HTTP/log surfaces redact authorization, bearer, query, and userinfo secrets.
- All 229 durable D1 tables now have unique ownership metadata. The 78 not yet schema/routing-ready remain explicitly deferred and cannot leak into backfill/strict routing.
- Multi-D1 shadow backfill recursively synchronizes same-domain FK ancestors, rejects cross-domain parents, reconciles source deletes, and blocks copying the exact L4/Fusion artifacts unless identity-v2 is complete.
- Worker expected-return registry/promotion/config paths and ml-controller artifact registry writes now resolve the learning domain explicitly; partial atomic batches fail closed.

## Remaining production constraints

- Production has not been deployed or migrated in this task; the current UI/runtime still reflects source `6e468f5e` until separately approved.
- `MULTI_D1_STRICT_ROUTING_READY` must remain false. Source audit still finds 56 modules / 235 direct legacy DB references; domain outbox producer/inbox consumer are absent.
- Legacy D1 remains approximately 86.68% full with a roughly 14–16 day linear 10 GB horizon. Code-only ownership/admission work does not reclaim capacity.
- The verified 2026-08-09 weekly candidates still genuinely fail quality: L4/Fusion sector samples/dates are 0/0 on that frozen cohort and walk-forward is false. Repairing identity restores OOF/metrics; it does not promote them.
- The 2026-08-14 daily shadow is fresher (OOF through 2026-08-06) and improved, but sector dates remain 6/8 and walk-forward/Fusion residual validation still fail. Daily monitoring is never promotion evidence.
- Broader direct legacy writers and deferred performance/dead-code candidates require separate bounded migrations; they are not a reason to falsely enable strict routing now.

## Workers AI Mistral adversarial review

- A real remote Workers AI call was completed through a localhost-only temporary Worker using the configured `AI` binding and Mistral Small 3.1; no secrets, source files, paths, or personal data were sent.
- Mistral reinforced three already-proven blockers: missing domain outbox/inbox, genuine weekly sector/walk-forward quality failure, and code-only changes not yet deployed/migrated.
- Its first answer incorrectly read `86.68%` D1 capacity utilization as model accuracy and treated omitted implementation detail as absent implementation.
- A second adversarial follow-up supplied the tested CAS, immutable registry, bounded-evidence, and shadow-pair mechanisms. The model still did not follow the requested five-item format and reversed the lease safety relationship.
- Adjudication: no new finding reached repository evidence grade. Model output remains E0 review material and did not override production queries, code inspection, or executable tests.
- The valid action remains unchanged: code may be deployed for observation after approval, but promotion is blocked by genuine candidate quality and strict Multi-D1 cutover is blocked by direct legacy references plus absent outbox/inbox.
