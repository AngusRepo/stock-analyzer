# Control Plane Cutover Checklist (2026-04-25)

## Goal

在正式 deploy 前，確認 `Worker`、`ml-controller service`、`pipeline-v2 job` 三層 control plane target 與 secrets 完全對齊，避免 cron、callback、frontend 各自指向不同 owner。

## Runtime Owners

- `frontend`
  - 讀 API 的入口
  - 目前 repo 內 production base 指向 `workers.dev`
- `worker`
  - edge controller
  - cron shell
  - admin trigger
  - callback receiver
- `ml-controller service`
  - GCP orchestration controller
  - 接收 `/pipeline/v2/run`、`/verify/run` 等 controller request
- `pipeline-v2 job`
  - long-running pipeline executor
  - 執行完成後 callback 回 Worker

## Required Alignment

### 1. Worker secrets

必須確認 Worker runtime 已設定：

- `ML_CONTROLLER_URL`
- `ML_CONTROLLER_SECRET`
- `STOCKVISION_AUTH_TOKEN`

說明：

- `ML_CONTROLLER_URL` 未設時，`verify-v2`、`regime-compute`、`weekly-audit`、`weekly-optuna`、`optuna-queue` 等 GCP-domain cron 現在會直接 fail fast。
- 這是刻意設計，避免 scheduler 再把「根本沒打到 GCP」記成成功。

### 2. ml-controller service env

必須確認 service env 已設定：

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `PIPELINE_JOB_NAME`
- `STOCKVISION_WORKER_URL`

說明：

- `pipeline.py` 目前會從 service env 讀 `STOCKVISION_WORKER_URL`
- 如果 service 沒這個 env，就算 job 有 callback URL，service-side callback / helper path 仍可能漂移

### 3. pipeline-v2 job env

必須確認 job env 已設定：

- `STOCKVISION_WORKER_URL`
- 與 service 相同的 callback target

說明：

- job callback target 必須與 frontend/worker 的 live owner 一致
- 不可出現 service 與 job 的 callback target 不同

### 4. Frontend production API base

必須確認 frontend production base 與 live Worker owner 一致：

- `frontend/.env.production`
  - `VITE_API_URL`

說明：

- frontend 讀的 worker 與 pipeline callback 打回的 worker 若不同，scheduler / cron log / dashboard 會 split-brain

## Pre-Deploy Verification

### Worker side

- `wrangler whoami`
- 確認 deploy target account 正確
- 確認 Worker secrets 完整
- hit `/api/health`
- 確認回傳：
  - `runtimeVersion = worker-mvc-refactor-2026-04-25`
  - `controlPlaneVersion = control-plane-cutover-2026-04-25`
  - `schedulerModelVersion = scheduler-status-v2`

### GCP side

- `gcloud run services describe ml-controller --region=asia-east1`
- `gcloud run jobs describe pipeline-v2 --region=asia-east1`
- 對比：
  - service env
  - job env
  - callback target

### Functional checks

- `17:30 pipeline`
  - 只應 thin trigger `/pipeline/v2/run`
- `19:00 verify-v2`
  - 應命中 `/verify/run`
- `scheduler`
  - `<1s` 顯示應為 `<1s`
  - pipeline child tasks 不應因缺 child log 就直接顯示 fail

## Post-Deploy Verification

### GCP logs

- `ml-controller` 需看到：
  - `/pipeline/v2/run`
  - `/verify/run`

### Worker logs / KV cron logs

- `pipeline`
  - 應有 success 或明確 error
- `verify-v2`
  - 應有 success 或明確 error
- 不應再出現「其實沒打到 GCP，但 UI 只顯示 -- / fail / 0s」這類模糊狀態

## Known Risks

- 如果 live Worker 仍是舊版本，repo 內目前的 thin trigger / fail-fast refactor 不會生效
- 如果 `ML_CONTROLLER_URL` 或 `ML_CONTROLLER_SECRET` 在 Worker side 漏設，GCP-domain cron 會全部直接失敗
- 如果 `STOCKVISION_WORKER_URL` 只存在於 job env、不存在於 service env，service-side callback helper 仍可能漂移
