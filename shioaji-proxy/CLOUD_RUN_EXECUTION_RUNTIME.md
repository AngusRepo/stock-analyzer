# Shioaji Execution Runtime Contract

Production execution must use one persistent broker-session owner.

Required Cloud Run settings:

- minimum instances: `1`
- maximum instances: `1`
- container concurrency: `4`
- CPU throttling: disabled (CPU always allocated)
- request timeout: `15s`
- `SHIOAJI_BROKER_QUERY_TIMEOUT_SECONDS=2`
- `SHIOAJI_SESSION_CALL_LOCK_TIMEOUT_SECONDS=0.25`
- `SHIOAJI_ORDERBOOK_MAX_AGE_MS<=1500`

The service must not be deployed with the observed unsafe settings
`containerConcurrency=80`, `maxScale=2`, `timeoutSeconds=300`, or without a
trading-hours minimum instance.

Orderbook routes are execution-critical and read only the streaming cache.
Subscription recovery runs outside the request path. Request-type snapshot and
kbar SDK calls share a single bounded broker-query lane and fail fast when that
lane is busy. Historical kbar traffic should move to a separate research
service before real-trading unlock.

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
  --update-env-vars SHIOAJI_BROKER_QUERY_TIMEOUT_SECONDS=2,SHIOAJI_SESSION_CALL_LOCK_TIMEOUT_SECONDS=0.25,SHIOAJI_ORDERBOOK_MAX_AGE_MS=1500
```

After deployment, verify service metadata and require orderbook quote-age,
subscription recovery, 429/504, and impossible-fill gates to pass before any
live-submit pilot.
