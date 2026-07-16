# StockVision Real-Trading Database and Security Review

Date: 2026-07-16
Status: local implementation and non-deployment gates complete; production cutover not authorized

## Executive decision

Real trading should use **two production D1 databases plus R2**, not one D1 and
not an immediate three-way D1 split:

1. `CORE_DB`: product state, strategy metadata, canonical projections, paper
   trading and operational state.
2. `EXECUTION_DB`: real-order intents, legs, callbacks, risk decisions,
   reconciliation and the authoritative live kill switch.
3. R2: immutable/high-volume JSON evidence and cold archives with prefix-based
   lifecycle expiration.

`STRATEGY_DB` is deferred. Current learning and canonicalization paths contain
cross-table joins between strategy decisions, screener runs and canonical
heads. Splitting those tables now without an outbox/projection layer would
create stale reads and contract-bypass risk. A third D1 is justified only after
measured CORE contention or after those joins are replaced with explicit
versioned projections.

## Fixed critical/high findings

### RTDB-001 — execution ledger shared the generic CORE D1 client

Impact: dry-run behavior, retries or a wrong database binding could corrupt or
silently skip live-order state.

Fix: a dedicated production-only client requires an independent database ID,
an exact proxy host, a provisioned instance UUID, primary-write proof and no
write retry. See `ml-controller/services/execution_d1_client.py`.

### RTDB-002 — multi-step order state was not transactionally claimed

Impact: concurrent/replayed requests could submit without a durable risk
decision or while the kill switch changed.

Fix: reservation, legs and risk evidence use atomic batches. The final leg
claim checks both the persisted allow decision and D1 kill switch in the same
atomic mutation. See `D1BrokerExecutionRepository.claim_leg`.

### RTDB-003 — wrong-D1/configuration binding could remain self-consistent

Impact: a Proxy accidentally bound to another D1 could pass a simple schema
check.

Fix: Gateway header, Proxy environment and D1 identity row must carry the same
unique instance UUID. The migration starts as `UNPROVISIONED`, so traffic is
disabled until an explicit provisioning step.

### RTDB-004 — execution Proxy could mutate the kill switch or identity

Impact: a compromised Gateway token could disable the authoritative control or
rewrite database identity.

Fix: `execution_database_identity` and `execution_control_state` are read-only
through the execution Proxy. SQL comments, multi-statements, quoted-identifier
bypasses, comma joins, schema tables, DDL and extension loading are denied.

### RTDB-005 — request-size limit trusted `Content-Length`

Impact: chunked/no-header requests could bypass the 512 KB limit.

Fix: Proxy measures the actual `ArrayBuffer.byteLength` before JSON parsing.

### RTDB-006 — Worker could not authenticate to IAM-private Cloud Run

Impact: production live submit would always fail before reaching the Gateway;
making the Gateway public to compensate would weaken the design.

Fix: Worker calls the authenticated general controller. The controller obtains
a Google identity token from its attached service account and relays exactly
one POST to the private Gateway. Any lost or non-200 submit result becomes
`unknown` and is reconciled by idempotency key; POST is never retried. Worker
no longer contains a direct Gateway URL/token contract.

### RTDB-007 — IAM relay URL was HTTPS-only but not destination-bound

Impact: a bad production environment value could forward a signed execution
packet to an unintended HTTPS host.

Fix: live and shadow relays now require an origin-only URL and exact production
hostname allowlist.

### RTDB-008 — route authentication and request envelope were ad hoc

Impact: a future dedicated-Gateway route could omit the service-token check;
unexpected envelope fields could be silently ignored.

Fix: every `/v1` route is mounted under one authenticated `APIRouter`; production
OpenAPI is disabled, `TrustedHostMiddleware` is required, and request envelopes
forbid extra fields.

### RTDB-009 — archive verification/reporting and R2 growth

Impact: corrupt R2 writes could be followed by D1 scrub; concurrent D1 changes
could be misreported; cold data would grow indefinitely.

Fix: archive objects are read back and SHA-256 verified before manifest/scrub.
Scrub uses optimistic original-blob equality and reports actual partial state.
Hot D1 defaults are:

| Data | D1 hot | R2 class/expiry |
|---|---:|---:|
| noncanonical screener evidence | 30 days | IA after 90 days; delete after 2 years |
| canonical screener evidence | 180 days | IA after 90 days; delete after 5 years |
| strategy decision evidence | 180 days | IA after 90 days; delete after 5 years |
| paper execution evidence | 730 days | IA after 90 days; delete after 2 years |

The lifecycle script is dry-run by default and was not applied:
`scripts/configure_r2_audit_lifecycle.ps1`.

### RTDB-010 — shared controller credential could invoke admin mutations

Impact: the Worker and other normal controller clients share
`ML_CONTROLLER_SECRET`. The old `/admin/modal-deploy` and QuantaAlpha mutation
routes accepted that same credential, so a compromised normal client could
deploy Modal code, create secrets, launch paid work or cancel calls without a
separate Wei approval boundary.

Fix: every `/admin` route now requires a distinct `ADMIN_API_TOKEN`; it is
rejected if equal to the controller token. External-state mutation routes also
require a matching approval id, an explicit route scope, an enabled flag and an
expiry no more than 30 minutes away. The generic Modal deploy route accepts only
the reviewed `/app/ml-service/modal_app.py` path. All missing or stale policy
states fail closed.

## Real execution retention

Real-order intent, event, risk and reconciliation rows remain in
`EXECUTION_DB`. Do not apply the paper-trading two-year policy to legal broker
records. Before live cutover, define the jurisdiction/accounting retention
period with the broker/accountant; the operational default should be seven
years with legal hold support. R2 export for this ledger is a separate audited
phase and must never delete the authoritative D1 row before checksum, readback
and reconciliation proof.

## Production blockers

The code is not equivalent to a safe production rollout. The following remain
mandatory:

1. Create the dedicated D1 and apply only
   `worker/migrations-execution/0001_execution_ledger.sql`.
2. Generate an instance UUID; write it to the D1 identity row and configure the
   same value in Proxy and Gateway.
3. Deploy the dedicated execution Proxy with only `EXECUTION_DB` and its token.
4. Configure the general controller IAM relay, exact host allowlist and
   `roles/run.invoker` on only the dedicated Gateway.
5. Replace the existing old-contract Gateway revision. The current service has
   max instances `1`, concurrency `1`, continuous CPU and a dedicated service
   account, but min instances is unset and all seven execution-D1/proxy identity
   settings are absent. Deploy the reviewed image with min/max instances `1`,
   one process, authenticated invocation, and every live-submit flag disabled.
6. Apply and verify R2 lifecycle rules only after reviewing existing bucket
   rules; the script must not be run blindly against another bucket.
7. Run shadow/canary, callback/restart/reconciliation and impossible-fill gates.
8. Remove Shioaji order credentials and the certificate mount from the general
   controller after the dedicated Gateway cutover. Keeping broker credentials in
   both processes preserves a credential-level contract-bypass path even while
   controller live-submit flags are disabled.
9. Move the legacy `stockvision-ml` service's plaintext secret-valued environment
   setting to Secret Manager, rotate the value, and retire the service if it is
   no longer a production dependency. The secret value must never be emitted in
   audit artifacts or deployment logs.
10. Reduce CORE D1 below the agreed operating headroom before real trading. The
   read-only account inventory reported 9,044,840,448 bytes, while the dedicated
   execution D1 is not yet present.
11. Build and scan the immutable Gateway container. Docker/Podman/nerdctl are
   unavailable in this local environment, so the actual image gate is not yet
   proven. CI now builds SBOM/provenance and fails on HIGH/CRITICAL findings for
   the controller, ML service and execution Gateway images.
12. Obtain explicit Wei approval before commit, push, deploy, resource changes
   or any real order.
13. Before using any controller admin route, provision `ADMIN_API_TOKEN`
   separately from `ML_CONTROLLER_SECRET`. For an approved mutation window,
   set `ADMIN_PRODUCTION_MUTATION_ENABLED=1`, a unique
   `ADMIN_MUTATION_APPROVAL_ID`, the minimum comma-separated route scopes and a
   UTC expiry no more than 30 minutes away; remove/disable them immediately
   after the approved action.

## Verification evidence

- Formal P9 gate passed: Worker application/test type-check, Worker contract
  suite, 61 controller security/critical-path tests, frontend production build, tracked
  secret scan, diff hygiene and Bug Hunter CPD.
- Full Python suites passed: controller `1303 passed / 15 live-parity skipped`,
  ML service `331 passed / 2 local-ABI skipped`, and Shioaji Proxy `21 passed`.
  The two ML tests were then executed under the production-aligned Python 3.11,
  NumPy 1.26.4 runtime and both passed.
- Worker Execution Ledger Proxy, allocator guard, frontend cookie/CSRF storage,
  strategy-discovery contract registry and 16 strategy-discovery gates passed.
- Local Strategy Discovery fixture E2E passed all 12 workflow steps, idempotent
  start/import replay, jury-bundle privacy checks and Codex result import.
- Controller, ML service, Execution Gateway and Shioaji Python manifests report
  no known vulnerabilities. Worker and Frontend lockfiles report zero known
  vulnerabilities at the configured high gate.
- The monthly PyMOO runtime contract was regenerated by its official validator;
  the production cutover packet is fresh and the local readiness audit reports
  `local_prod_ready: done` with no failed checks.
- Migration is executed in an in-memory SQLite contract test; default identity
  is unprovisioned and the kill switch is on.
- R2 lifecycle dry-run is valid and preserves existing rules, but the four audit
  retention rules are not yet applied. Applying them remains a cloud mutation.
- Read-only Cloud Run IAM verification found exactly one Gateway invoker: the
  general controller service account. No public principal is bound.

## External source

Cloudflare R2 lifecycle rules support prefix filters, IA transitions and expiry;
deletion normally completes around the expiration window, and lifecycle
changes require R2 Storage Write permission:
https://developers.cloudflare.com/r2/buckets/object-lifecycles/
