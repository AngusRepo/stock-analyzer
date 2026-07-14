# Strategy Discovery Lab Acceptance Matrix

Status values: `PENDING`, `PASS`, `BLOCKED_WITH_EVIDENCE`.

## Section 28 final acceptance

| # | Requirement | Implementation owner | Executable evidence | Status |
|---:|---|---|---|---|
| 1 | Exactly two primary actions | Dedicated frontend page | `strategyDiscoveryUiContract.test.ts`; desktop/mobile browser QA | PASS |
| 2 | One full-analysis action runs the whole Cloudflare flow | API + Workflow | fixture route/workflow E2E, 12 persisted steps | PASS |
| 3 | No per-LLM user actions | Workflow orchestration | UI contract + E2E | PASS |
| 4 | Analysis automatically creates Codex Bundle | Jury builder | bundle manifest + full-flow E2E | PASS |
| 5 | Codex button enables only at correct state | backend resolver | button-state unit tests + runtime UI QA | PASS |
| 6 | Drag/drop auto-import; no third button | Codex panel/import API | UI contract + automatic ZIP import E2E | PASS |
| 7 | Conclusion is readable in-page | conclusion builder/view | six-section view contract + browser QA | PASS |
| 8 | Checkpoint resume | checkpoint manager/Workflow | resume/input-hash reuse tests; 12 D1 checkpoints | PASS |
| 9 | All model output schema-validated | AI client/validators | schema repair/fail-closed tests; real-call proof pending external reservation | PASS |
| 10 | Run retains input hash, model and prompt versions | D1/R2 manifests | provenance integration assertions | PASS |
| 11 | Codex verdict has code/test evidence | result validator | fatal/evidence tests | PASS |
| 12 | No evidence means UNVERIFIED | result validator | evidence downgrade test | PASS |
| 13 | No majority-vote truth | conclusion/jury rules | contract/source-boundary test | PASS |
| 14 | SURVIVED is not Alpha proof | schemas/UI copy | contract/view test | PASS |
| 15 | No OpenAI API | native AI binding only | source-boundary scan + Wrangler AI binding | PASS |
| 16 | No production/trading modification | isolated bounded context | ownership/import/source-boundary scans | PASS |

## Section 25 minimum tests

### UI

- [x] two-primary-buttons-only
- [x] analysis-button-ready
- [x] analysis-button-running
- [x] analysis-button-recoverable
- [x] analysis-button-blocked
- [x] codex-button-disabled
- [x] codex-handoff-mode
- [x] codex-drag-drop-import
- [x] codex-result-view

### Workflow

- [x] snapshot-freeze
- [x] workflow-idempotency
- [x] checkpoint-resume
- [x] parallel-model-step
- [x] model-failure-isolation
- [x] schema-repair
- [x] neuron-budget-block

### Discovery

- [x] 6C-4B-2D allocation
- [x] Mode A disabled
- [x] parent-mutation isolation
- [x] regime sample gate
- [x] unknown-feature rejection
- [x] negative-lag rejection
- [x] candidate duplicate
- [x] complexity-limit

### Audit

- [x] issue-schema
- [x] duplicate-issue merge
- [x] E0 formal-defect rejection
- [x] cross-examination status
- [x] fatal evidence-level

### Codex

- [x] jury-bundle manifest
- [x] bundle-hash
- [x] result-run-id
- [x] candidate-hash
- [x] unknown-issue rejection
- [x] missing-output-file
- [x] automatic-ZIP-import

## Local closure and prod-ready evidence

- [x] Worker type-check passes on a clean-HEAD projection.
- [x] All 13 deterministic Strategy Discovery Worker test files pass; the runner reports 15 gates including frontend UI and generated-registry checks.
- [x] Frontend Strategy Discovery UI contract passes.
- [x] Frontend production build passes on a clean-HEAD projection.
- [x] Fixture E2E completes with visible `FIXTURE` provenance and zero neurons.
- [x] Steps 08–10 use allowlist-only role projections and per-step opaque references; synthetic sentinel and actual Jury Bundle transcript scans reject internal IDs, hashes, DSL/thresholds, entry/exit rules, data sources, governance, and system profile fields.
- [ ] **BLOCKED_WITH_EVIDENCE:** Approved `final23` passed the Dashboard budget check but made no POST/model call because Miniflare persisted final22's terminated Workflow instance as `running`. Resume now archives that local Workflow runtime evidence before Wrangler starts while preserving D1/R2/KV/checkpoints. Parser, regression, 14 gates, and full Worker typecheck pass, but no real-model completion is claimed; a fresh Dashboard check and separate approval are required.
- [x] No fixture call is counted as real-model evidence.
- [x] ZIP security corpus passes.
- [x] Auth/admin denial tests pass.
- [x] Migration/schema parity passes.
- [x] R2/D1 artifact mismatch is recoverable, never completed.
- [x] No TODO/placeholder/empty handler in the bounded context.
- [x] No import/call path to retrain, promote, deploy, broker, real-order, or production scheduler mutation.
- [x] `git diff --check` passes and unrelated changes remain untouched.

## Validation receipt (2026-07-11)

- Clean projection: detached HEAD `6fa95cac` at `C:\tmp\stockvision-strategy-discovery-clean`.
- Worker: full `type-check` PASS; 14 deterministic gates PASS.
- Frontend: production build PASS; lazy `StrategyDiscoveryPage` chunk emitted.
- Cloudflare packaging: Wrangler 4 dry-run PASS; Workflow, KV, D1, R2, and native AI bindings recognized; no deployment performed.
- Runtime fixture E2E: post-final22 bounded-parallel/stale-route closure run `RUN-20260712094550-d5ae53d7`, persisted under `.tmp/strategy-discovery-e2e-closure10`; full 12-step flow, deterministic candidate order, normal completed-run idempotent replay, explicit fixture provenance, zero neurons, complete raw-attempt envelopes, valid bundle/import, final `RESULT_READY`.
- Privacy-minimized runtime fixture E2E: `RUN-20260714053109-fa0ba4b3`, persisted under `.tmp/strategy-discovery-e2e-privacy4`; full 12-step flow and result import passed, and its actual five Steps 08–10 prompt transcripts contain no frozen internal candidate/strategy/feature identifiers or forbidden core fields.
- Clean projection after the `final16` repair: full Worker typecheck PASS, 14 deterministic gates PASS, frontend production build PASS, Wrangler 4 dry-run PASS, Worker/Frontend offline audits both 0 vulnerabilities.
