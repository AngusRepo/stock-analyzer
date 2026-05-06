# System Cleanup Roadmap 2026-04-24

本文件把 `stockvision-cloudflare-v12` 的完整掃描結果，收斂成可執行的 cleanup / 瘦身路線圖。

目標不是一次「大重寫」，而是分波次把系統從：

- V1 / V2 混跑
- fallback / legacy 疊床架屋
- 巨型單體檔過胖
- repo hygiene 髒亂

收斂成：

- 單一 owner 的 production 主流程
- 清楚的責任邊界
- 可回歸驗證的瘦身節奏
- 更低的 incident triage 成本

---

## 1. 掃描基線

截至 `2026-04-24` 的靜態掃描基線：

- core source 檔數：`274`
- core source 總行數：約 `66,802`
- compatibility tax 命中數：
  - 關鍵字：`fallback | legacy | deprecated | rollback | backwards compat`
  - 總命中：約 `450`
- 前 5 個巨檔總行數：`13,333`
  - 約佔 core source `20.0%`
- 前 10 個巨檔總行數：`19,122`
  - 約佔 core source `28.6%`

最大單體檔：

| 檔案 | 行數 | 角色 |
|---|---:|---|
| `ml-controller/services/backtest_engine.py` | 3572 | 回測核心 |
| `worker/src/index.ts` | 2924 | Worker app + cron + admin + orchestration |
| `worker/src/routes/paper.ts` | 2906 | paper trading 核心 |
| `ml-service/app/main.py` | 2339 | ML service 主入口 |
| `worker/src/lib/marketScreener.ts` | 1592 | screener / ranking |

---

## 2. 高風險發現

### P0-1. Pipeline owner 尚未真正單一化

正式 cron `17:30 TW` 目前仍在 `worker/src/index.ts` 直接跑 `runFullPipeline(env)`。

這代表：

- Worker 還持有 bulk fetch / screener / queue wait / ML trigger / recommendation
- 但 ml-controller V2 又已承接 LangGraph pipeline 與 recommendation / verify 邏輯
- 註解、runbook、實際 code 存在漂移

直接風險：

- incident root cause 難追
- V1/V2 寫入語意可能漂移
- 後續任何優化都要雙邊同步

### P0-2. Paper trading 主鏈仍集中在超大單體檔

`worker/src/routes/paper.ts` 已接近 3000 行，且同時承載：

- account summary
- pending buys generation
- debate orchestration
- intraday execution
- EOD exit
- sizing / risk / fallback
- API route

直接風險：

- 改一個地方牽動整檔
- 測試很難切模組邊界
- morning-setup / intraday / exit 容易互相污染

### P1-1. 相容層稅過重

高命中熱點：

| 檔案 | compatibility 命中數 |
|---|---:|
| `worker/src/routes/paper.ts` | 47 |
| `ml-service/app/models.py` | 39 |
| `ml-controller/routers/admin.py` | 37 |
| `ml-controller/services/backtest_engine.py` | 26 |
| `ml-controller/services/recommendation_service.py` | 22 |

直接風險：

- 真正主路徑不清
- rollback code 長期留著變成 maintenance tax
- 新功能常要雙寫 / 雙讀 / 雙驗證

### P1-2. 重複 boilerplate 太多

`worker/src/index.ts` 內部重複跡象：

- `STOCKVISION_AUTH_TOKEN` guard 約 `30` 處
- `X-Controller-Token` header 寫法約 `21` 處

直接風險：

- auth 行為不一致
- timeout / header / error handling 漂移
- review 噪音大

### P1-3. 業務邏輯仍有多 runtime 重複

明顯重複群：

- `worker dailyRecommendation` vs `ml-controller recommendation_service`
- `worker predictionVerifier` vs `ml-controller verify_service`
- `ml-controller kv_pusher` vs `ml-service kv_pusher`
- debate 流程 TS / Python 各一套

直接風險：

- parity drift
- 同一邏輯修兩份以上
- production 行為難保證一致

### P2-1. Repo hygiene 仍可直接瘦身

可立即清掉的 tracked 噪音：

- `frontend/dev-dist/registerSW.js`
- `frontend/dev-dist/sw.js`
- `frontend/dev-dist/workbox-8839f217.js`
- `scripts/backfill_output.sql`，約 `770 KB`

風險：

- repo 發胖
- review 雜訊
- generated artifact 混入 source control

### P2-2. 文件與註解仍殘留 production 指紋 / 硬編碼範例

目前掃到的例子包含：

- prod token 字串
- prod worker URL
- handoff / POC 文件中的固定 secret fallback

風險：

- secret hygiene 差
- 新人接手容易把範例當正式配置

---

## 3. Cleanup 波次

### Wave 0. Repo Hygiene

目標：

- 先把不該進 repo 的東西清掉
- 不改 production 行為

範圍：

- `frontend/dev-dist/*`
- `scripts/backfill_output.sql`
- 文件中的明顯 prod token / prod URL 範例字串

預估刪減：

- repo tracked artifact 約 `942 KB`
- 淨減 source 變更噪音，不以行數為主

可解決問題：

- review 噪音
- repo 發胖
- secret hygiene 風險

驗證：

- `git ls-files` 不再包含 generated output
- build 不受影響

---

### Wave 1. Pipeline Owner 收斂

目標：

- 讓 `17:30` pipeline 真正只有一個 owner
- Worker 只保留 trigger / log / callback / guard

範圍：

- `worker/src/index.ts`
- `worker/src/lib/dailyRecommendation.ts`
- `worker/src/lib/predictionVerifier.ts`
- `ml-controller/graphs/daily_pipeline_v2.py`
- `ml-controller/services/recommendation_service.py`
- `ml-controller/services/verify_service.py`

執行原則：

- 正式 cron 不再直接跑本地 `runFullPipeline()`
- recommendation / verify 只保留一個 production owner
- Worker 只做 thin trigger 與結果可觀測

預估刪減：

- `1,200 ~ 2,000` 行有效複雜度

可解決問題：

- V1/V2 混跑
- pipeline 漂移
- incident triage 跨 runtime 追查

預估提升：

- pipeline root cause 分析時間可下降 `30% ~ 50%`
- cron 與 runbook 一致性顯著提升

風險：

- 若某些手動 admin path 還依賴 V1 helper，需要補 thin adapter

驗證：

- `17:30` cron call path 明確只剩 controller owner
- `recommendation` / `verify` live log 不再雙邊執行

---

### Wave 2. Paper Trading 拆模組

目標：

- 拆解 `paper.ts`
- 把 route 與 orchestration / execution 分層

建議拆法：

- `worker/src/routes/paper-account.ts`
- `worker/src/routes/paper-pending.ts`
- `worker/src/routes/paper-execution.ts`
- `worker/src/routes/paper-exit.ts`
- `worker/src/lib/paperRisk.ts`
- `worker/src/lib/paperPricing.ts`

優先移出：

- `setupMorningPendingBuys`
- `reconcilePendingBuyDebates`
- `runIntradayCheck`
- `runEODExit`
- account summary / snapshot queries

預估刪減：

- 主檔可由 `2906` 行降到 `1200 ~ 1600`
- 實際移出約 `1300 ~ 1700` 行

可解決問題：

- morning-setup / intraday / exit 互相污染
- 無法針對 pending-buy 流程做 focused test

預估提升：

- paper trading 變更風險下降
- pending-buy / debate 鏈條更容易做下一步優化

風險：

- route import / type 依賴多，拆時要避免 circular import

驗證：

- `worker npm run type-check`
- paper API smoke tests
- pending buy store 路徑不回退到舊 KV-only 模式

---

### Wave 3. 共用 Auth / Client / Header Builder

目標：

- 抽掉重複 auth 與 controller call boilerplate

建議新增：

- `worker/src/lib/controllerClient.ts`
- `worker/src/lib/serviceAuth.ts`
- `worker/src/lib/httpGuards.ts`

處理對象：

- `worker/src/index.ts`
- `worker/src/routes/paper.ts`
- `worker/src/routes/other.ts`
- `worker/src/lib/adaptiveEngine.ts`
- `worker/src/lib/predictionVerifier.ts`
- `worker/src/lib/debateTrader.ts`

預估刪減：

- `200 ~ 350` 行重複碼

可解決問題：

- auth / header / timeout 不一致
- controller 呼叫錯誤格式分散

預估提升：

- incident 時更容易觀察所有 controller calls
- 新增 controller endpoint 成本下降

驗證：

- auth route smoke test
- controller call error 統一格式

---

### Wave 4. Compatibility Tax Burn-down

目標：

- 系統性移除已經不需要的 fallback / legacy 欄位

第一批優先：

- `worker/src/lib/adaptiveConfig.ts`
- `worker/src/lib/adaptiveEngine.ts`
- `worker/src/routes/paper.ts`
- `ml-controller/services/recommendation_service.py`
- `ml-service/app/model_store.py`
- `ml-service/app/model_pool.py`

執行原則：

- 先盤點哪些 fallback 真正還被 live 用到
- 沒有 rollback 意義的 legacy path 先移除
- migration 完成後再清第二層 fallback

預估刪減：

- `800 ~ 1,500` 行
- compatibility hit 先下降 `35% ~ 50%`

可解決問題：

- 新功能需要雙寫 / 雙讀
- 調整時怕碰到回滾死角

預估提升：

- review 與 debug 更直接
- 設定與流程語意清楚

驗證：

- 每移除一組 fallback，都要有對應 live owner / schema owner 清單

---

### Wave 5. 業務邏輯唯一 owner 化

目標：

- recommendation / verify / kv push / debate 各只有一個真正 owner

候選合併：

- `worker predictionVerifier` -> `ml-controller verify_service`
- `worker dailyRecommendation` -> `ml-controller recommendation_service`
- `ml-controller kv_pusher` + `ml-service kv_pusher` -> 單一共用模組
- TS/Python debate prompt contract 對齊，最終只保留一個 authoritative prompt source

預估刪減：

- `500 ~ 1,000` 行

可解決問題：

- parity drift
- port 後忘記同步
- 一個 bug 要改多份

預估提升：

- 同一功能只需一套測試與一套 runbook

驗證：

- cross-runtime parity test
- prompt / verdict / risk adjustment 對齊檢查

---

### Wave 6. 巨檔專項重構

這波不是先做，但一定要排上日程。

優先對象：

- `ml-controller/services/backtest_engine.py`
- `ml-service/app/main.py`
- `worker/src/lib/marketScreener.ts`

建議方向：

- `backtest_engine.py`
  - 切成 data access / portfolio state / execution / metrics / report
- `ml-service/app/main.py`
  - 切 API route / train / predict / feature alignment / model loading
- `marketScreener.ts`
  - 切 fetch / factor assembly / ranking / persistence / audit

預估刪減：

- 巨檔本身不一定淨減很多行
- 但可把修改爆炸半徑下降 `40%+`

---

## 4. 預估總收益

若完成 `Wave 0 ~ Wave 5`：

- 有效複雜度可下降約 `2,700 ~ 4,800` 行
- compatibility tax 可先從 `450` 命中降到約 `225 ~ 290`
- repo 噪音檔可直接減少約 `942 KB`
- 巨檔集中度可明顯下降
- pipeline / paper trading / controller call 三條主鏈會更容易觀測與驗證

可直接改善的問題：

- pipeline root cause 難追
- morning-setup / pending-buy / intraday 改動風險高
- controller / worker 職責重疊
- config / fallback 語意不清
- repo 中混有 generated artifact 與 prod 指紋

---

## 5. 建議執行順序

### 第一週

- Wave 0
- Wave 1
- Wave 2 起手式

目標：

- 先把 production owner 收斂
- 同時把 paper trading 最危險的大檔拆開

### 第二週

- Wave 2 完成
- Wave 3
- Wave 4 第一批

目標：

- 開始系統性降低 maintenance tax

### 第三週

- Wave 4 第二批
- Wave 5
- Wave 6 規劃與第一刀

---

## 6. 執行守則

- 不做 blanket rewrite。
- 每一波只解一種結構問題。
- 每一波都要附：
  - 影響檔案清單
  - 刪減量
  - 行為不變保證
  - 驗證命令
- production owner 改動優先於 UI polish。
- 若 runbook、handoff、code 不一致，以 `code + live behavior` 為準，再補文件。

---

## 7. 下一步

建議直接從這 3 件開始：

1. `Wave 0` repo hygiene 清理
2. `Wave 1` pipeline owner 收斂
3. `Wave 2` 把 `paper.ts` 拆成 `pending / execution / exit`

這三步做完，系統會先乾淨一大截，後續優化才不會一直踩在舊結構上。
---

## Deferred Small Consolidations

這批先記錄，等 `M` 層完成後再回來評估是否要收斂；目前不先動。

原則：

- 目標是 `解耦`，不是把檔案拆到極細。
- 若模組已經形成清楚邊界，而且 debug / call path 成本沒有明顯升高，就先保留。
- 只有在「單純多一層、沒有明確 owner 價值」時，才做回併。

目前暫列的候選：

1. `adminTrigger*` 小收斂
- 觀察對象：
  - `worker/src/lib/adminTriggerTaskMap.ts`
  - `worker/src/lib/adminTriggerTypes.ts`
  - `worker/src/lib/adminTriggerGcpTasks.ts`
  - `worker/src/lib/adminTriggerWorkerDomainTasks.ts`
- 傾向：
  - 保留 `workerDomain` / `gcpDomain` 邊界
  - 但不排除把 `TaskMap + Types` 合併，降成 2~3 檔

2. `controllerWorkflows` barrel 是否保留
- 觀察對象：
  - `worker/src/lib/controllerWorkflows.ts`
  - `worker/src/lib/controllerDailyWorkflows.ts`
  - `worker/src/lib/controllerResearchWorkflows.ts`
- 傾向：
  - 目前可接受
  - 若後續 import 邊界更穩，可視情況保留 barrel；若只是多一層轉拋，可考慮收掉

3. `optunaQueueProcessor` 是否維持獨立
- 觀察對象：
  - `worker/src/lib/optunaQueueProcessor.ts`
  - `worker/src/lib/optunaQueue.ts`
- 傾向：
  - 若 queue processor 長期只做極薄 dispatch，可考慮回併到 queue owner

4. `cron` / `paper` 不再往下細拆
- 已定案：
  - `paperEntryTasks`
  - `paperExitTasks`
  - `paperExitPolicy`
  - `paperMarketData`
  - `paperIntradayData`
  - `paperTradeMath`
  - `cronOrchestrator`
  - `cronWorkerDomainTasks`
  - `cronGcpDomainTasks`
- 原則：
  - 這個粒度先停
  - 除非未來再次膨脹或出現重複邏輯，否則不再拆成更多微型 helper

下一階段優先順序：

1. 先掃 `M` 層：
- `ml-controller/services/modal_client.py`
- `ml-service/modal_app.py`
- `ml-service/app/main.py`
- model lifecycle / retrain / inference runtime

2. 等 `M` 層結構清楚後，再回來做這批小收斂。
## M-Layer Guardrails (2026-04-25)

- 目標是 `解耦`，不是把 `M` 層拆成大量 20~50 行的小檔。
- 目前優先保留的 owner：
  - `ml-service/app/models.py`
  - `ml-service/app/model_pool.py`
  - `ml-controller/services/model_ic_tracker.py`
  - `ml-controller/services/lifecycle_promotion_gate.py`
- 目前最大的 monolith hotspot：
  - `ml-service/app/main.py`
- `main.py` 現階段同時混有：
  - FastAPI route shell
  - predict / retrain use-cases
  - universal prep / train
  - SHAP audit
  - ARF update
  - regime / walk-forward endpoints
- `modal_app.py` 不應直接依賴 `main.py` 當唯一 use-case owner。
- 已完成第一步：
  - 新增 `ml-service/app/use_cases.py`
  - `modal_app.py` 主要 runtime import 已改走 `app.use_cases`
- 已完成第二步：
  - 新增 `ml-service/app/universal_training.py`
  - 新增 `ml-service/app/prediction_runtime.py`
  - `Modal` 與 `HTTP` 的主要入口已開始改走這兩個 owner surface
- 已完成第三步：
  - `run_shap_audit()` 的 active implementation owner 已移到 `ml-service/app/universal_training.py`
  - `main.py` 目前只保留 delegate + legacy body，後續再做物理刪除
- 已完成第四步：
  - `prep_universal_batch()` 的 active implementation owner 已移到 `ml-service/app/universal_training.py`
  - `train_universal_from_gcs()` 的 active implementation owner 已移到 `ml-service/app/universal_training.py`
  - `main.py` 目前對這兩個 use-case 也只保留 delegate + legacy body
- 暫時接受的過渡狀態：
  - `main.py` 內仍殘留 `UniversalPrepRequest / UniversalTrainRequest` 舊定義
  - 目前 runtime 已改吃 centralized schema alias，不是當前 blocker
  - 等 `main.py` 再下沉一刀時，再一起物理刪除 legacy duplicate schema
- 下一步優先順序：
  1. 優先把 `universal prep/train + shap audit` 抽成單一 use-case owner
  2. 再評估 `predict/retrain` 是否需要從 `main.py` 下沉
  3. `ARF` 若要抽離，應維持為單一 feedback/update owner，不要再碎成多個 helper 檔
- 明確避免：
  - 再把 `paper` / `cron` 繼續切更細
  - 在 `M` 層為了整齊而新增太多 barrel / helper-only modules
