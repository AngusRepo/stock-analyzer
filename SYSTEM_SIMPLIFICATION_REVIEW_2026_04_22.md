# System Simplification Review

日期：2026-04-22
範圍：`stockvision-cloudflare-v12`

## 核心判斷

問題不在於模型或流程太多本身，而在於：

- production path 不夠單一
- scheduler / dashboard / runtime state 的來源不一致
- screener / recommendation / retrain 的責任邊界混在一起
- research 路徑與 production 路徑沒有切乾淨

## 建議的目標架構

### 1. Production Predict 單一路徑

只保留：

- `/predict/v2`
- `ensemble_v2`
- recommendation layer 的同一份 prediction provenance

避免：

- gate 看 `ensemble_v2`
- 顯示與分數又回頭讀 legacy signal

### 2. Production Retrain 單一路徑

只保留：

- `/retrain/universal`

legacy：

- `/retrain/trigger`

應降級為：

- deprecated
- debug / emergency only

否則 active/watchlist 與 universal 會形成兩套 training semantics。

### 3. Screener 拆出三層

`worker/src/lib/marketScreener.ts` 現在是 god module。建議拆成：

- `screener_core`
  - universe / filter / ranking / sector heat
- `screener_persistence`
  - `daily_recommendations`
  - selection history
  - watchlist writes
- `screener_postprocess`
  - indicator repair
  - notifications
  - auxiliary logging

### 4. Recommendation Service 拆出四層

`ml-controller/services/recommendation_service.py` 建議拆成：

- `prediction_view`
- `recommendation_policy`
- `reason_builder`
- `recommendation_writer`

現在同一模組同時做：

- SELL/BUY gate
- score
- ranking promotion
- reason / watch_points
- D1 write

這會讓 debug 與 provenance 追查都很痛苦。

### 5. Scheduler Registry 單一來源

現在 job 定義至少散在：

- `worker/wrangler.toml`
- `worker/src/lib/schedulerStatus.ts`

建議抽成單一 registry，再讓：

- cron
- dashboard
- status API

都讀同一份定義。

### 6. Monthly Retrain 不要硬塞所有模型

較適合納入 retrain 主鏈：

- tree models
- FT-Transformer
- DLinear
- PatchTST

較適合留在 inference / research side：

- Chronos
- Kalman
- MarkovSwitching

Chronos 目前只是 `chronos-t5-tiny` baseline，不應被包裝成 production monthly retrain 主角。

## 今天是否應手動重跑 ML Predict

目前判斷：**先不要**

原因：

1. 今天 `daily_recommendations` 已有資料，但 `predictions` 為 `0`
2. root cause 是 pipeline trigger path 失敗，不是單純 `ml_score` 算錯
3. live `ml-controller` 仍缺：
   - `GCP_PROJECT_ID`
   - `GCP_REGION`
   - `PIPELINE_JOB_NAME`

## 建議補救順序

1. 先補 live `ml-controller` env
2. 驗證 `/pipeline/v2/run` 能真正觸發 job
3. 再補跑：
   - `pipeline/v2`
   - 或至少 `ml_predict -> recommendation -> write_d1`

不要只補跑 `ml predict`，否則 `daily_recommendations` 上的 `signal / confidence / ml_score` 仍可能不完整。
