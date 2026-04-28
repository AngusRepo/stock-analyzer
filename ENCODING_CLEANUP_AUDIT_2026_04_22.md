# Encoding Cleanup Audit

日期：2026-04-22  
範圍：`stockvision-cloudflare-v12`

## 結論

目前 repo 仍存在大量編碼污染，而且不只是註解或文件層級。至少有兩個前端頁面已經污染到會影響 TypeScript / JSX 編譯。

## 已驗證證據

- `frontend/npm run build` 失敗
- 失敗檔案：
  - `frontend/src/pages/BotDashboard.tsx`
  - `frontend/src/pages/SchedulerPage.tsx`

## 分級

### P0：編譯或 UI 直接受影響

- `frontend/src/pages/BotDashboard.tsx`
  - 目前存在大量斷裂 JSX、壞掉的中文字串、未正確關閉的標籤片段
  - `npm run build` 已直接報出多個 `Unexpected token`、`Unterminated string literal`、`JSX element has no corresponding closing tag`
- `frontend/src/pages/SchedulerPage.tsx`
  - 目前也存在斷裂 JSX 與污染字串
  - `npm run build` 已報出 `AppShell has no corresponding closing tag`、`Unexpected token` 等錯誤

### P1：文件層級嚴重污染

- `ARCHITECTURE.md`
- `RISK_FRAMEWORK_ARCHITECTURE.md`
- `ML_POOL_ARCHITECTURE.md`

這三份文件已不適合作為乾淨的 authoritative doc，需要重新整理或重寫。

### P2：後端註解與說明字串污染

- `worker/src/lib/marketScreener.ts`
- `worker/src/index.ts`
- `worker/src/lib/schedulerStatus.ts`
- `worker/wrangler.toml`
- `ml-controller/services/recommendation_service.py`
- `ml-controller/services/modal_client.py`
- `ml-controller/routers/retrain_trigger.py`
- `ml-controller/routers/model_pool.py`

這層目前較偏維護性問題，但會嚴重增加後續接手成本。

## 建議清理順序

1. 先處理 `BotDashboard.tsx` 與 `SchedulerPage.tsx`
2. 再重整三份 root architecture 文件
3. 最後清後端註解與 runbook comment

## 建議做法

### 前端頁面

不要再做零碎字串替換。  
建議改成：

1. 以現在的功能結構為準
2. 重新生成乾淨 JSX 文案
3. 每修一頁就跑一次 `frontend/npm run build`

### 架構文件

不要嘗試機械式轉碼。  
建議直接重寫成新的乾淨版本，再逐步淘汰舊檔。

## 今天的 ML 補跑判斷

目前不建議先手動補跑 `ml predict`。原因：

- `daily_recommendations` 今天已有資料，但 `predictions` 今天為 `0`
- live `ml-controller` 仍缺：
  - `GCP_PROJECT_ID`
  - `GCP_REGION`
  - `PIPELINE_JOB_NAME`

因此先補跑很可能只是重複失敗。
