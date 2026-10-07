# Shioaji Execution Runtime Contract

Production execution must use one persistent broker-session owner.

Required Cloud Run settings:

- service-level minimum instances: `1` during TW weekdays 08:30–13:31 (calendar gate), `0` outside
- revision/template minimum instances: `0` always; service-level scaler is the sole owner
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

The in-process completed 1-minute bar cache is intentionally ephemeral. The
Worker incrementally checkpoints completed OHLCV bars into the skinny
`intraday_minute_bars` D1 table and merges that canonical current-session
lineage after a Cloud Run revision restart. The execution Hub must not perform
D1/R2 writes or restore historical research bars into the broker session.

An unchanged orderbook is execution-confirmed only when its subscription and
session epoch still match the active Shioaji quote session and an actual market
Tick/BidAsk callback arrived within 10 seconds. A subscription ACK is not a
market heartbeat. The pending buy list prewarms the odd-lot stream before a
signal; an absent book still cannot authorize an order. Shioaji system event
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
  --min-instances 0 `
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

After every release and scale operation run `scripts/runtime_min_policy.py` for the service. It verifies both levels plus every routed/tagged revision. Use `--apply --desired 0/1` only with approved configuration changes; CPU/RAM, image, connection settings and environment must remain identical. Scalers refuse every revision-floor repair; it requires a separately approved release and routing change. Do not shorten this trading window.
