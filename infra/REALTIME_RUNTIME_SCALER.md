# Realtime Runtime Scaler v2

`realtime-runtime-min-1` and `realtime-runtime-min-0` are the only owners of
service-level minimum instances for:

- `shioaji-proxy`
- `stockvision-execution-gateway`

Rules:

- Trading-day open: both services use service-level `min=1`, `max=1`.
- TWSE holiday: the open job enforces `min=0`.
- Trading-day close and all off-hours: both services use `min=0`, `max=1`.
- Deploy commands must never set `autoscaling.knative.dev/minScale` on a
  revision.
- Production traffic must have one 100% serving revision and no traffic tags.
- `latestCreatedRevisionName`, `latestReadyRevisionName`, and the 100% serving
  revision must match.
- A mismatch makes the scaler Job fail; HTTP/Job success without topology
  parity is forbidden.
- Gateway readback must confirm `FINLAB_LIVE_SUBMIT_ENABLED=0`.

Source manifests:

- `infra/realtime-runtime-min-1.job.yaml`
- `infra/realtime-runtime-min-0.job.yaml`

Apply only with explicit deployment approval:

```powershell
gcloud run jobs replace infra/realtime-runtime-min-1.job.yaml --region=asia-east1
gcloud run jobs replace infra/realtime-runtime-min-0.job.yaml --region=asia-east1
```
