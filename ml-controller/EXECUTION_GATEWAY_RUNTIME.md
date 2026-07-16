# StockVision Dedicated Execution Gateway Runtime

`execution_gateway_app:app` is the only service allowed to call the broker
order API. The general `ml-controller` live-submit route remains fail-closed.

## Required Cloud Run contract

- distinct Cloud Run service and dedicated least-privilege service account
- private ingress / authenticated invoker only; never `allUsers`
- minimum instances: `1`
- maximum instances: `1`
- container concurrency: `1`
- CPU throttling: disabled
- request timeout: `10s`
- startup probe must not place an order or force broker login
- build with repo-root `Dockerfile.execution-gateway`; the image is minimal, non-root, and runs one uvicorn worker

## Required non-secret environment contract

- `ENVIRONMENT=production`
- `EXECUTION_GATEWAY_SERVICE_ROLE=dedicated_execution_gateway`
- `EXECUTION_GATEWAY_ALLOWED_HOSTS=<exact Cloud Run hostnames, comma-separated>`
- `LIVE_EXECUTION_GATEWAY_MODE=persistent_singleton`
- `LIVE_EXECUTION_SINGLE_INSTANCE_CONFIRMED=1`
- `LIVE_EXECUTION_CONTINUOUS_CPU_CONFIRMED=1`
- `LIVE_EXECUTION_MAX_PACKET_AGE_SECONDS=5`
- `LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS=500`
- `LIVE_EXECUTION_MAX_BROKER_TRUTH_AGE_SECONDS=5`
- `LIVE_EXECUTION_RECONCILE_SECONDS=30` (callback-first; polling is only for ambiguous `SUBMITTING/UNKNOWN` recovery)
- `LIVE_EXECUTION_HUB_TIMEOUT_SECONDS=0.75`
- `CF_EXECUTION_D1_DB_ID=<dedicated stockvision-execution-db id>`
- `CF_EXECUTION_D1_INSTANCE_ID=<provisioned execution ledger UUID>`
- `EXECUTION_D1_PROXY_URL=<dedicated Execution Ledger Proxy /v1/d1/query URL>`
- `EXECUTION_D1_PROXY_ALLOWED_HOSTS=<exact proxy hostname>`
- `EXECUTION_D1_REQUIRE_PRIMARY=1`

The Gateway must not use `CF_D1_DB_ID` for broker ledger access. In
production, `CF_EXECUTION_D1_DB_ID` must differ from `CF_D1_DB_ID`; otherwise
startup fails closed. Keep read replication disabled for this ledger unless a
future implementation carries D1 session bookmarks through every execution
lifecycle read.

Production Gateway access must go through the dedicated Execution Ledger Proxy
Worker. Direct Cloudflare D1 REST credentials are administrative fallback only
and are rejected by the production client contract.

Before the Proxy can serve traffic, generate a unique instance UUID, update
`execution_database_identity.instance_id` in the dedicated execution D1, and
set the exact same value as the Proxy Worker's
`EXECUTION_LEDGER_INSTANCE_ID` and the Gateway's
`CF_EXECUTION_D1_INSTANCE_ID`. The migration deliberately writes
`UNPROVISIONED`; leaving either side at that value keeps all queries disabled.
The Gateway token cannot mutate `execution_database_identity` or
`execution_control_state`; kill-switch changes require a separate audited
administrative path.

Worker live-submit also remains fail-closed unless all three values are enabled
for the same bounded approval window:

- `LIVE_EXECUTION_CLIENT_ENABLED=1`
- `LIVE_EXECUTION_SUBMIT_GUARD_ENABLED=1`
- `LIVE_TRADING_APPROVAL_SCOPE=<Wei-approved bounded scope>`

An unknown submit response must query `/v1/intents/{idempotency_key}` and return
`reconciliation_required`; it must never resend the same broker order.

The Worker must not call the IAM-private Gateway directly. Live execution uses
Worker -> authenticated general ml-controller -> Google-IAM-authenticated
Gateway. Configure the Worker with `ML_CONTROLLER_URL` and secret-bound
`ML_CONTROLLER_SECRET`; do not place `EXECUTION_GATEWAY_SERVICE_TOKEN` or a
Google service-account private key in the Worker. Configure the general
controller with disabled-by-default `EXECUTION_GATEWAY_LIVE_RELAY_ENABLED=0`,
`EXECUTION_GATEWAY_URL`, `EXECUTION_GATEWAY_IAM_AUDIENCE`,
`EXECUTION_GATEWAY_RELAY_ALLOWED_HOSTS=<exact Gateway hostname>`, and secret-bound
`EXECUTION_GATEWAY_SERVICE_TOKEN`. The live relay makes exactly one POST; any
lost/non-200 response is reconciled by idempotency key and is never retried.

## Paper-to-live shadow bridge

The Worker must not call this IAM-private service directly. The supported path
is Worker signed packet -> authenticated ml-controller relay -> Cloud Run IAM
-> `/v1/shadow/validate`.

Dedicated Gateway, disabled defaults:

- `LIVE_EXECUTION_SHADOW_ENABLED=0`
- `LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED=0`
- `LIVE_EXECUTION_SHADOW_SCOPE=<bounded paper parity scope>`

General ml-controller, disabled default:

- `EXECUTION_GATEWAY_SHADOW_RELAY_ENABLED=0`
- `EXECUTION_GATEWAY_URL=<private Gateway URL>`
- `EXECUTION_GATEWAY_IAM_AUDIENCE=<same private Gateway URL>`
- `EXECUTION_GATEWAY_SHADOW_TIMEOUT_SECONDS=1.75` (per attempt, one bounded retry)
- mount `EXECUTION_GATEWAY_SERVICE_TOKEN` as a secret
- grant the ml-controller service account only `roles/run.invoker` on the
  dedicated Gateway service

Worker, disabled defaults:

- `LIVE_EXECUTION_SHADOW_CLIENT_ENABLED=0`
- `LIVE_EXECUTION_SHADOW_GUARD_ENABLED=0`
- `LIVE_EXECUTION_SHADOW_SCOPE=<same bounded paper parity scope>`
- keep `LIVE_EXECUTION_HMAC_SECRET` and `ML_CONTROLLER_SECRET` secret-bound

The shadow endpoint validates signature, runtime kill switch, order caps,
price band, lot-specific snapshots and last-moment Market Data Hub books. It
never reserves a broker intent, writes the broker ledger, submits, updates or
cancels an order. With broker-read disabled, a valid result is deliberately
`partial / broker_truth_shadow_disabled`. Enabling broker-read is a separate
explicit approval because it starts a broker session, but still cannot submit.

## Required secrets

- Shioaji API key, secret, account id, certificate PFX file, certificate password and certificate person id
- `EXECUTION_GATEWAY_SERVICE_TOKEN`
- `LIVE_EXECUTION_HMAC_SECRET`
- Cloudflare D1/KV credentials
- `EXECUTION_D1_PROXY_TOKEN`, shared only by the Gateway and the dedicated
  Execution Ledger Proxy Worker
- `PROXY_SERVICE_TOKEN`

The certificate PFX must be mounted as a Secret Manager file and
`SHIOAJI_CERT_PATH` must point to that mounted path. It must not be injected as
the text value of an environment variable.

## Live unlock flags

The service must remain disabled unless all shadow gates pass. Enabling needs
all of the following at the same time:

- `FINLAB_LIVE_SUBMIT_ENABLED=1`
- `LIVE_TRADING_APPROVAL_SCOPE=<Wei-approved bounded scope>`
- `LIVE_TRADING_APPROVAL_EXPIRES_AT=<short-lived UTC timestamp>`

Removing any one value fails closed. Do not store secret values in source,
Wrangler vars, build logs or this document.

## Mandatory rollout evidence

- D1 broker execution migration applied and verified
- Market Data Hub 429/504 execution endpoints equal zero
- authoritative quote-age p99 within threshold
- callback queue overflow and persistence failures equal zero
- restart recovery returns no unresolved `SUBMITTING` leg
- order/deal callback and `update_status/list_trades` reconciliation agree
- impossible fill and duplicate broker order counts equal zero
- signed shadow requests pass for both board-lot and intraday odd-lot legs
- explicit Wei approval before any deployment, resource change or real order
