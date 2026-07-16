# StockVision Production Security / Release Readiness

Date: 2026-07-14 (Asia/Taipei)

Status: historical release checkpoint; current remediation and production blockers are maintained in `docs/REAL_TRADING_DATABASE_SECURITY_REVIEW_2026-07-16.md`.

## Decision

**Source hardening is materially complete, but production is BLOCKED.**

No commit, push, deploy, retrain, traffic mutation, IAM mutation, secret rotation, or Scheduler mutation was performed in this review session. Production must not be described as vulnerability-free until every runtime blocker below is closed and the post-deploy gates pass.

## Source remediations completed

### Cross-process authentication and release contracts

- Added `ML_SERVICE_SECRET` to the Cloud Run Service and Job secret bindings and to Modal runtime secrets.
- Controller health now exposes whether Controller-to-ML authentication is configured.
- Post-deploy smoke tests now require:
  - Controller callback and ML auth configuration.
  - ML protected endpoint invalid-token rejection (`401`).
  - ML protected endpoint valid-token acceptance (`200`).
  - Dated Worker live predeploy decision exactly `PASS`; `WARN` and `BLOCK` stop release.
- Live P9 verifies required Worker secret bindings by name without reading their values.
- GCP Secret Manager references in the deployment script must use numeric versions. `latest` is rejected by production preflight.

### Cloud Scheduler static credential removal

- Removed a production-shaped Worker credential from `freqtrade/.env.example`.
- Expanded P12 tracked-secret scanning to detect StockVision service-token assignments and Bearer tokens.
- Added Google OIDC verification to the shared Worker service-auth middleware:
  - RS256 only.
  - Google JWKS signature verification with bounded cache lifetime and unknown-key refresh.
  - Exact issuer, audience, expiration, issued-at, verified email, service-account email, and subject checks.
  - Missing OIDC configuration fails closed.
- Removed two route-local token comparators and routed `adminControlRoutes` and `adminSimulationRoutes` through the shared middleware.
- Changed the authoritative Scheduler sync from a persisted static Authorization header to:
  - dedicated Scheduler service account;
  - explicit OIDC audience without query parameters;
  - no static Authorization header.
- Added a post-deploy Scheduler desired-state gate covering all manifest jobs and rejecting:
  - missing jobs;
  - target drift;
  - static Authorization headers;
  - service-account drift;
  - audience drift;
  - unmanaged direct Worker jobs.

### Contract bypass and release-gate repairs

- S12 candidate snapshot processing now fails closed when selected candidates exist but no snapshot can be persisted. The prior warn-and-continue path was a contract bypass.
- Fixed three Controller tests that depended on the caller's working directory.
- Fixed P9 Controller Python path normalization before changing directories.
- Production live gates accept only `PASS`.
- Added immutable GitHub Action SHAs, pinned dependency audit tooling, Node audits, Python installed-environment audits, SBOM/provenance builds, and digest-pinned Trivy scans.
- Both Controller and ML Service images are built and scanned independently in CI.

### Dependency vulnerability without feature downgrade

- Replaced vulnerable `pytorch-lightning==2.5.6` with `2.6.1`.
- Preserved NeuralForecast functionality by installing the pinned compatible runtime explicitly and installing `neuralforecast==3.1.9` with `--no-deps` after the safe base graph.
- Added build-time imports/version assertions for DLinear, PatchTST, and iTransformer.
- Production-equivalent Python 3.11 installed-environment audit reports zero known vulnerabilities.
- Production-equivalent ML tests pass without removing any model or reducing model capability.

## Verification evidence

| Gate | Result |
|---|---|
| Controller full suite | 1250 passed, 15 skipped |
| ML Service production-equivalent suite | 331 passed |
| Shioaji proxy | 21 passed |
| P9 Worker / release gate | PASS; Worker type-check/contracts, Controller 51 release contracts, diff hygiene, P12, Bug Hunter CPD |
| Frontend contracts + production build | PASS; 2618 modules transformed |
| Cross-subsystem Python compileall | PASS |
| Worker and Frontend npm audit | 0 known vulnerabilities at configured severity gate |
| Controller pip-audit | 0 known vulnerabilities |
| ML installed-environment pip-audit | 0 known vulnerabilities |
| Scheduler OIDC unit test | PASS; valid signature plus audience/identity/expiry/algorithm/tamper negatives |
| Scheduler OIDC dry-run | PASS for 46 authoritative manifest jobs; no mutation |
| Local production-ready audit | BLOCKED by fresh Pymoo runtime artifact requirement |

Docker is not available locally, so the two image builds and Trivy scans are enforced in CI but were not executed on this Windows workstation.

## Verified production blockers

Read-only runtime evidence on 2026-07-14:

1. `ml-controller` still uses the default Compute service account.
2. `ml-controller` has `ingress=all` and grants `roles/run.invoker` to `allUsers`.
3. `ml-controller` has 12 Secret Manager references using `latest`.
4. `ml-controller` does not currently bind `ML_SERVICE_SECRET`.
5. All 13 Cloud Run Jobs use the default Compute service account.
6. Cloud Run Jobs contain multiple `latest` secret references.
7. All 47 direct-to-Worker Cloud Scheduler jobs use static Authorization headers; none use OIDC.
8. The authoritative manifest manages 46 Worker jobs. Production additionally enables unmanaged `audit-json-retention`, although the source contract deliberately excludes that destructive job from automation.
9. The new Scheduler drift gate correctly blocks production with 139 violations: 46 audience, 46 service-account, 46 static-header, and 1 unmanaged-job violations.
10. A production Worker service credential existed in tracked git history. It must be rotated; deleting it only from HEAD is insufficient.
11. Recent Scheduler logs show Worker HTTP 500 for `external-evidence` and `morning-setup`. Five Scheduler jobs retain status code 13 in current metadata and require runtime verification after repair.
12. `local_prod_ready_audit` blocks promotion on `roadmap:p8:monthly_pymoo_runtime_contract_validation_artifact_fresh`.
13. Modal still has both `stockvision-ml` and legacy `quantaalpha-poc` deployed. Consumer verification is required before retiring the legacy app.
14. No new source has been committed, pushed, or deployed, so production does not contain the remediations in this report.

## Mandatory release order

1. Produce and approve a fresh Pymoo runtime validation artifact. This may require an explicitly approved retrain/runtime action; do not bypass freshness.
2. Create dedicated least-privilege identities for Controller, Jobs, and Scheduler; grant only required Secret Manager, storage, invocation, and job-execution permissions.
3. Create new numeric Secret Manager versions, including new Worker service token and ML service secret. Do not bind `latest`.
4. Rotate the exposed Worker service token across Cloudflare, Controller/Jobs, and every non-Scheduler consumer. The old version must be disabled only after dual-read/cutover verification where required.
5. Build Controller and ML images once. Require dependency audit, SBOM, provenance, and HIGH/CRITICAL image scans; publish and record immutable digests.
6. Deploy Modal with the new ML service secret and safe dependency graph. Run ML auth negative/positive smoke tests.
7. Deploy Cloud Run Service and all relevant Jobs from the approved immutable digest with dedicated service accounts and numeric secret versions.
8. Deploy Worker with OIDC verification variables and rotated secrets.
9. Run `sync_gcp_scheduler.ps1` to migrate the 46 authoritative jobs to OIDC. Use `-DeleteStale` only with explicit approval to remove unmanaged `audit-json-retention`.
10. Run `verify_scheduler_oidc.ps1`; it must report `PASS` with 46 jobs and zero drift.
11. Deploy Frontend.
12. Run post-deploy health/auth/live gates, then limited canary traffic. Any security, contract, error-rate, latency, or data-integrity failure triggers rollback.
13. Resolve and replay `external-evidence` and `morning-setup`; confirm all Scheduler statuses and downstream evidence.
14. Observe at least one complete scheduled cycle and one trading-day critical path before closing the release.

## Required production controls after deployment

- Centralized alerting on authentication failures, OIDC validation failures, Worker 5xx, Cloud Run Job failures, Scheduler code 13, Queue DLQ depth, D1 atomic-contract failures, and callback failures.
- Rate limits and anomaly detection on privileged routes, including per-caller identity and replay/deduplication evidence.
- Daily desired-state drift checks for Cloud Run IAM/ingress/service accounts, image digests, numeric secret versions, Worker secrets, Scheduler OIDC, and unmanaged jobs.
- Automated dependency and image scanning on every commit and scheduled re-scan of deployed digests.
- Secret rotation runbook with owner, version ledger, overlap window, rollback, revocation evidence, and periodic rotation schedule.
- Immutable audit evidence for release digest, configuration, migrations, smoke outputs, live gate result, approver, traffic shifts, and rollback target.
- Backup/restore and D1/R2 integrity drills; a backup is not accepted until restore has been tested.
- SLO monitoring for availability, p95/p99 latency, error ratio, callback completion, pipeline freshness, and model/evidence freshness.

## Closure definition

“Production has no known open vulnerabilities” may be stated only when:

- local, CI, image, dependency, contract, and secret gates pass;
- production IAM, ingress, identities, scheduler OIDC, numeric secret versions, and immutable digests match desired state;
- the leaked token is rotated and old versions are disabled;
- Pymoo freshness passes without lowering the requirement;
- live positive and negative authentication tests pass;
- all critical scheduled paths complete successfully;
- no unresolved P0/P1 findings remain, and lower-severity accepted risks have owner, expiry, and compensating controls.

Absolute “zero vulnerability” cannot be guaranteed. The defensible target is zero known exploitable findings, fail-closed controls, verified runtime configuration, continuous detection, and tested rollback/response.
