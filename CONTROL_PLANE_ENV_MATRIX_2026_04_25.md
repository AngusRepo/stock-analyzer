# Control Plane Env Matrix (2026-04-25)

## Purpose

整理 `frontend / worker / ml-controller service / pipeline-v2 job` 四層的 owner、必要 env、驗證方式，避免 deploy 時只改一層造成 split-brain。

## Matrix

| Layer | Runtime owner | Required config | Why it matters | Verify after deploy |
| --- | --- | --- | --- | --- |
| Frontend | Pages / frontend build | `VITE_API_URL` | 決定 dashboard / scheduler / admin API 讀哪個 Worker | 檢查 production build env，並從頁面實際呼叫 API |
| Worker | Cloudflare Worker | `ML_CONTROLLER_URL`, `ML_CONTROLLER_SECRET`, `STOCKVISION_AUTH_TOKEN` | 決定 cron / admin trigger 能不能打到 `ml-controller` | `GET /api/health` 應回版本指紋 |
| ml-controller service | Cloud Run Service | `GCP_PROJECT_ID`, `GCP_REGION`, `PIPELINE_JOB_NAME`, `STOCKVISION_WORKER_URL` | 決定 `/pipeline/v2/run`、service-side callback helper、CORS 預設 origin | `GET /health` 應回版本指紋與 configured flags |
| pipeline-v2 job | Cloud Run Job | `STOCKVISION_WORKER_URL` | 決定 long-running pipeline 完成後 callback 打回哪個 Worker | `gcloud run jobs describe pipeline-v2` 對照 env |

## Expected Health Contracts

### Worker `/api/health`

應回：

- `runtimeVersion = worker-mvc-refactor-2026-04-25`
- `controlPlaneVersion = control-plane-cutover-2026-04-25`
- `schedulerModelVersion = scheduler-status-v2`

### ml-controller `/health`

應回：

- `runtimeVersion = ml-controller-mvc-refactor-2026-04-25`
- `controlPlaneVersion = control-plane-cutover-2026-04-25`
- `callbackConfigured = true`
- `pipelineJobConfigured = true`

## Drift Patterns To Avoid

### Pattern 1: frontend / callback split-brain

- frontend 指向 Worker A
- pipeline callback 打回 Worker B

結果：

- dashboard 顯示與 callback 寫入不同步
- scheduler / cron log / pipeline status 互相對不上

### Pattern 2: service / job drift

- `ml-controller service` 沒有 `STOCKVISION_WORKER_URL`
- `pipeline-v2 job` 有 `STOCKVISION_WORKER_URL`

結果：

- job callback 看似正常
- 但 service-side helper / callback path 仍可能漂移

### Pattern 3: worker env drift

- Worker 漏設 `ML_CONTROLLER_URL`
- 本地 repo 有 GCP-domain cron code
- live runtime 卻無法真正打到 `ml-controller`

結果：

- 看起來 cron 有跑
- 實際沒有 controller request
- scheduler 很容易出現假成功或模糊錯誤
