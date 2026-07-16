# Shioaji Execution Runtime Contract

Production execution must use one persistent broker-session owner.

Required Cloud Run settings:

- minimum instances: `1`
- maximum instances: `1`
- container concurrency: `4`
- CPU throttling: disabled (CPU always allocated)
- request timeout: `15s`
- `SHIOAJI_BROKER_QUERY_TIMEOUT_SECONDS=2`
- `SHIOAJI_STREAMING_CONTROL_TIMEOUT_SECONDS=12`
- `SHIOAJI_SESSION_CALL_LOCK_TIMEOUT_SECONDS=0.25`
- `SHIOAJI_ORDERBOOK_MAX_AGE_MS<=1500`
- `SHIOAJI_QUOTE_SESSION_RECONNECT_GRACE_SECONDS=15`

The service must not be deployed with the observed unsafe settings
`containerConcurrency=80`, `maxScale=2`, `timeoutSeconds=300`, or without a
trading-hours minimum instance.

Quote, snapshot, orderbook and current-session completed-kbar routes are
execution-critical and read only the streaming Tick/BidAsk cache. Subscription
recovery runs outside the request path on a dedicated single-owner streaming
control lane. A slow subscribe must remain serialized and observable, but must
not poison/restart the broker process; request-style SDK calls retain the hard
timeout/process-replacement policy. No request handler may call
`api.snapshots()` or `api.kbars()`. Historical kbar and research traffic belongs
to a separate research service/job and cannot share this broker session.

An unchanged orderbook is execution-confirmed only when its subscription and
session epoch still match the active Shioaji quote session. Shioaji system event
codes `1`, `2`, and `12` immediately fail-close quote execution; codes `0` and
`13` restore session readiness and trigger subscription recovery. The original
exchange source time remains unchanged and is stored separately from the
derived confirmation time.

Example update command (requires explicit deployment approval; do not run from
tests):

```powershell
gcloud run services update shioaji-proxy `
  --project gen-lang-client-0602998820 `
  --region asia-east1 `
  --min 1 `
  --max 1 `
  --concurrency 4 `
  --no-cpu-throttling `
  --timeout 15s `
  --update-env-vars SHIOAJI_BROKER_QUERY_TIMEOUT_SECONDS=2,SHIOAJI_STREAMING_CONTROL_TIMEOUT_SECONDS=12,SHIOAJI_SESSION_CALL_LOCK_TIMEOUT_SECONDS=0.25,SHIOAJI_ORDERBOOK_MAX_AGE_MS=1500,SHIOAJI_QUOTE_SESSION_RECONNECT_GRACE_SECONDS=15
```

After deployment, verify service metadata and require orderbook quote-age,
subscription recovery, 429/504, and impossible-fill gates to pass before any
live-submit pilot.
