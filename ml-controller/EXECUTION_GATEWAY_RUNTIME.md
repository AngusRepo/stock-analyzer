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
- `LIVE_EXECUTION_GATEWAY_MODE=persistent_singleton`
- `LIVE_EXECUTION_SINGLE_INSTANCE_CONFIRMED=1`
- `LIVE_EXECUTION_CONTINUOUS_CPU_CONFIRMED=1`
- `LIVE_EXECUTION_MAX_PACKET_AGE_SECONDS=5`
- `LIVE_EXECUTION_MAX_SNAPSHOT_AGE_MS=500`
- `LIVE_EXECUTION_MAX_BROKER_TRUTH_AGE_SECONDS=5`
- `LIVE_EXECUTION_RECONCILE_SECONDS=30` (callback-first; polling is only for ambiguous `SUBMITTING/UNKNOWN` recovery)
- `LIVE_EXECUTION_HUB_TIMEOUT_SECONDS=0.75`

## Required secrets

- Shioaji API key, secret, account id, certificate PFX file, certificate password and certificate person id
- `EXECUTION_GATEWAY_SERVICE_TOKEN`
- `LIVE_EXECUTION_HMAC_SECRET`
- Cloudflare D1/KV credentials
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
