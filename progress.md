# Progress — Day-1 Production Issues

## Session: 2026-03-26

### ✅ 已完成（13 個問題全部處理）

#### Data Fixes
| # | 問題 | 根因 | 修復 | 檔案 |
|---|------|------|------|------|
| D1 | 法人籌碼全 0 | `aggregateChips()` 用中文比對，FinMind v4 回傳英文 | 加 Foreign_Investor/Investment_Trust/Dealer_self mapping | `finmind.ts` |
| D4 | PE/PB 都是 "--" | parseFinancials 不提取 PE/PB，FinMind 財報無此欄位 | 新串 `TaiwanStockPER` dataset（每日 PER/PBR/殖利率） | `finmind.ts` + `stocks.ts` |
| D8 | 評分明細全 0 | Schema + INSERT 缺 chip_score/tech_score/ml_score | ALTER TABLE + INSERT 補三欄 | `dailyRecommendation.ts` + schema.sql |
| D9 | 族群流向 +0.0 | D1 連鎖（法人=0 → sector_flow=0） | 法人修好自動正常 | — |

#### UI/UX Fixes
| # | 問題 | 修復 | 檔案 |
|---|------|------|------|
| D2 | 缺 K 線圖 | 新建 CandlestickChart（OHLC + Volume，Recharts custom shape） | `CandlestickChart.tsx` + `Dashboard.tsx` |
| D7 | 回不去首頁 | StockHero 加 Home icon → setActiveStock(null) | `Dashboard.tsx` |
| D10 | 側邊欄=screener 非 watchlist | 新增 GET/POST/DELETE /api/watchlist per-user API，前端改讀 | `other.ts` + `api.ts` + `Dashboard.tsx` |
| B3 | Bot 無 signal 詳情 | SignalTable click-to-expand（score breakdown + reason + watch_points） | `BotDashboard.tsx` |

#### Bot/Cron Fixes
| # | 問題 | 根因 | 修復 | 檔案 |
|---|------|------|------|------|
| B1 | Cron "沒跑" | cronLogger 用 UTC date，早上 cron 存前一天 key | 全改 TW date（6 處） | `cronLogger.ts` + `index.ts` + `other.ts` + 前端 |
| B2 | Signals 空的 | 同 B1 UTC/TW 不一致 | 同上 | — |
| Pipeline | 時序斷裂 | update 只 enqueue，recommendation 不等 queue | 加 `pipeline` admin trigger + waitForQueue | `index.ts` |

#### 不需修改
| # | 問題 | 結論 |
|---|------|------|
| D3 | 風險指標/多因子 | 非 Manus 遺留，依賴 cron 填資料 |
| D5 | AI 分析 4 頁籤重疊 | ML定量/摘要綜合/技術深度/交易建議，低重疊 |
| D6 | Regime N/A | market_risk 無資料時合理降級 |

### 驗證結果（pipeline 跑完）
- chip_data: 3303 筆非零 ✅
- financials PE: 7.3 / 7.62 / 9.63... ✅
- financials PB: 1.38 / 1.17（部分 null = FinMind 資料源限制） ✅
- recommendation 子分數: 16/30/18, 12/30/18 ✅
- sector_flow: 航空+0.56億, 電信+0.27億 ✅
- pipeline: screener → 112 prices → 68 predictions → recommendation ✅

### 部署狀態
- Worker: `7ec156fb`（pipeline + PER/PBR + watchlist + 法人 + UTC fix）
- Frontend: `9af1a5e9`（K 線 + Home 按鈕 + watchlist + signal expand）
- D1: 新增 chip_score/tech_score/ml_score 欄位

### 下次 Session 啟動
```
讀 mistake.md + progress.md，繼續
```

---

## Session: 2026-03-27 — MVC 架構重構

### Phase 1: Modal Functions ✅
- [x] Extract /predict → predict_stock() standalone function（已在 main.py）
- [x] Rewrite modal_app.py with @modal.function()（predict_single_stock / retrain_single_stock / update_arf_reward）
- [x] Keep old ASGI coexistence（fastapi_app legacy 保留）

### Phase 2: Cloud Run Controller ✅ (2026-03-27)

**建立 `ml-controller/`（977 行，14 個檔案）：**
- [x] `main.py` — FastAPI entry + X-Controller-Token auth dependency
- [x] `routers/predict.py` — POST /batch-predict → Modal predict_single_stock.map()
- [x] `routers/retrain.py` — POST /batch-retrain → Modal retrain_single_stock.map()
- [x] `routers/verify.py` — POST /verify → Modal update_arf_reward.map() + accuracy summary
- [x] `routers/recommend.py` — POST /recommend → scorer + Claude Haiku LLM
- [x] `routers/risk.py` — POST /risk-assess → adaptive params 計算
- [x] `routers/status.py` — GET /model-status → Modal function 可用性檢查
- [x] `services/modal_client.py` — batch_predict / batch_retrain / batch_update_arf
- [x] `services/scorer.py` — chip_score(0-40) + tech_score(0-30) + ml_score(0-30)（移植自 dailyRecommendation.ts）
- [x] `services/adaptive.py` — 4 個自適應函數（移植自 adaptiveEngine.ts）
- [x] `requirements.txt` — fastapi + uvicorn + modal + httpx（輕量，無 ML 套件）
- [x] `Dockerfile` — python:3.11-slim，PORT=8080

**設計要點：**
- Worker 傳完整 raw data → Controller stateless（不直接存取 D1）
- Modal 並行推論：50 stocks × 15s(sequential) → ~30s(parallel)
- auth: `X-Controller-Token` header（env ML_CONTROLLER_SECRET）
- recommend LLM: ANTHROPIC_API_KEY 從 Worker 傳入 or Controller env var

### Phase 3: Worker 簡化 ✅ (2026-03-27)

**index.ts（1268→1206 行，-62 行）：**
- [x] `postController()` helper — X-Controller-Token auth, 300s timeout
- [x] `runMLAndRisk()` 重寫 — 共用查詢提取 + 逐股 payload 建構 + Controller /batch-predict
- [x] `processMLBatch()` 刪除（~255 行）— ML_QUEUE sequential → Controller parallel
- [x] `runWeeklyRetrain()` 重寫 — Controller /batch-retrain（legacy fallback 保留）
- [x] Queue consumer 簡化 — 移除 ml_batch branch，只剩 update_batch
- [x] `arf_features` 寫入 forecast_data（供 verifier ARF feedback 用）
- [x] Legacy ML_QUEUE fallback 保留（ML_CONTROLLER_URL 未設定時走舊路徑）

**dailyRecommendation.ts 重構：**
- [x] `buildStockPayloads()` — pre-query D1 chip/tech/ML/accuracy，組 Controller 格式
- [x] 評分 + LLM 邏輯移至 Controller /recommend
- [x] D1 寫入（daily_recommendations + sector_flow）保留在 Worker
- [x] Legacy fallback — Controller 失敗時降級為「只看 ML signal 排名」

**adaptiveEngine.ts 重構：**
- [x] `queryAdaptiveInputs()` — pre-query D1 market_risk/model_accuracy/paper_orders
- [x] Controller /risk-assess 路徑 + legacy 本地計算 fallback
- [x] KV 寫入保留在 Worker

**predictionVerifier.ts 增強：**
- [x] 接受 full env（向後相容 D1DB | VerifyEnv）
- [x] ARF feedback 收集（arfBatch array）+ POST Controller /verify
- [x] D1 驗證邏輯不變，ARF 是非阻塞附加功能

**wrangler.toml + types.ts：**
- [x] ML_QUEUE producer/consumer 移除
- [x] ML_CONTROLLER_URL / ML_CONTROLLER_SECRET 新增到 Bindings
- [x] MLQueueMsg type 移除

**Wrangler dry-run：** ✅ 397 KiB, bindings: DB + KV + UPDATE_QUEUE + AI（ML_QUEUE 已消失）

### Phase 4: 部署 + 連線驗證 ✅ (2026-03-27)

**Controller 部署（Cloud Run）：**
- [x] `gcloud run deploy --source` — python:3.11-slim, 1 CPU / 512Mi, maxScale=2
- [x] 修復：f-string backslash syntax (Python 3.11 限制)
- [x] 修復：`status.py` 移除 `import modal`（改 httpx /health 檢查）
- [x] 移除 `modal` 硬依賴（requirements.txt），改 httpx 並行呼叫 ML Service
- [x] URL: `https://ml-controller-530028717113.asia-east1.run.app`
- [x] Auth: `X-Controller-Token: sv-controller-2026-prod`
- [x] Env: ML_SERVICE_URL → stockvision-ml, ML_SERVICE_SECRET → sos32sos

**連線驗證：**
- [x] `/health` → 200 OK ✅
- [x] `/model-status` (no token) → 401 Unauthorized ✅
- [x] `/model-status` (with token) → backend=cloud_run, ml_service.status=ok ✅

**Worker 部署：**
- [x] `wrangler secret put ML_CONTROLLER_URL` → set ✅
- [x] `wrangler secret put ML_CONTROLLER_SECRET` → set ✅
- [x] `wrangler deploy` → `3410d85c` (397 KiB, ML_QUEUE 已消失) ✅
- [x] `/api/health` → 200 OK ✅

**架構（production, backend=modal）：**
```
Worker (CF) → Controller (Cloud Run) → Modal .map() × 20 containers (max)
                                        predict: 1 CPU, 2GB, max_containers=20
                                        retrain: 1 CPU, 2GB, max_containers=10
                                        arf:     1 CPU, 1GB, max_containers=5
```

**Pipeline 驗證（2026-03-27）：**
- [x] 77 stocks → 75 predictions 寫入 D1（150s）
- [x] BUY signals: 2880 (0.758), 2308 (0.752), 2885 (0.737), 3231 (0.734)
- [x] Modal Starter Plan: $17/mo 預估 < $30 免費額度 ✅

### Phase 4+5: 狀態遷移 + 版本控制 ✅ (2026-03-27)

**Phase 4 確認：**
- [x] linucb_bandit.py — 已有 GCS 持久化（`#3` 先前 session 完成）
- [x] arf_aggregator.py — 已有 GCS 持久化（`#3` 先前 session 完成）
- [x] ASGI endpoint 保留但降規格（1 CPU, 2GB, max_containers=2）— warmup + IC audit 用
- [x] Modal Functions 資源優化：CPU 2→1, memory 4GB→2GB, min_containers=1→0, max_containers=20

**Phase 5 版本控制：**
- [x] `CHANGELOG.md` — v12.0.0 / v12.1.0 / v12.2.0 完整紀錄
- [x] `deploy.sh` — 新增 Step 6.5 Controller 部署 + ML_CONTROLLER_SECRET
- [x] ML_QUEUE 建立步驟移除
- [x] Summary 新增 Controller URL 顯示

### MVC 重構完成 ✅

| 元件 | 行數 | 部署 |
|---|---|---|
| Worker (CF) | 1206 行 | `stockvision-worker` (3f4cabb7) |
| Controller (Cloud Run) | 977 行 | `ml-controller-530028717113.asia-east1.run.app` |
| Modal Functions | 120 行 | `stockvision-ml` (wayne60619) |
| ML Service (app/) | 4315 行 | 含在 Modal image 內 |

**效能：** 77 stocks 12-15min → 150s（~5x 提升）
**成本：** ~$17/mo（Modal $30 免費額度涵蓋）+ Cloud Run $0.05/mo

---

## Session: 2026-03-27 下午 — UI + Sector Flow 修復

### ✅ 已完成

1. **非 admin 登入 "頁面不存在" 修復**
   - `frontend/src/App.tsx` 加入 `<Route path="/unauthorized" component={Unauthorized} />`

2. **AdminUsersPanel 加到 Dashboard 首頁**
   - `Dashboard.tsx` EmptyState 改為 3 欄（admin）/ 原佈局（一般）
   - AdminUsersPanel 在右側第三欄，緊湊卡片式（avatar + name + approve/reject icon）
   - `frontend/src/components/AdminUsersPanel.tsx` 重寫為窄欄版

3. **D1 手動修復 6 支 sector null 股票**
   - 2330 台積電→半導體業, 2317 鴻海→其他電子業, 7879/6682→半導體業, 6980→光電業, 7707→半導體業

### 🏗️ 進行中（代碼已寫，未 deploy）

4. **sector_flow 改用 FinMind sector mapping**
   - **問題根因**:
     - 舊版 calcSectorFlow 用 D1 `stocks.sector`（screener 自訂分類 AI_Server, IC設計）
     - 台積電 sector=null → 半導體顯示 0 億
     - 嘗試 FinMind full-market bulk API → Worker 30s CPU limit 超時失敗
   - **最終方案**: D1 chip_data + FinMind `fetchTWStockInfo`（metadata only）
     - `fetchTWStockInfo` 回傳 ~2500 筆 stock metadata（含 `industry_category`）
     - FinMind 失敗 → fallback D1 stocks.sector
     - chip_data 日期範圍: `-5 days`（涵蓋 ~3 交易日）
     - 寫入前 `DELETE FROM sector_flow WHERE date = today`（清除舊分類）
     - 寫入上限 20 族群
   - **檔案**: `worker/src/lib/dailyRecommendation.ts` calcSectorFlow 函數
   - **⚠️ 待確認**: chip_data.foreign_net 單位是「張」還是「股」
     - 目前假設是「張」: `foreign_net * price * 1000 / 1e8`（= 億元）
     - 若是「股」: 改成 `foreign_net * price / 1e8`
   - **下一步**:
     ```bash
     cd worker && npx wrangler deploy
     curl -s -X POST ".../api/admin/trigger/recommendation" -H "Authorization: Bearer sv-stockvision-2026-prod"
     npx wrangler d1 execute stockvision-db --remote --command "SELECT sector, total_net, stock_count FROM sector_flow WHERE date='2026-03-27' ORDER BY total_net DESC"
     ```

### 待做

5. **TimeVerse + Debate Trader 整合**
   - TimeVerse 同步已完成: `worker/src/lib/timeverse.ts`
     - 從 GitHub `Timeverse/My-TW-Coverage` → D1 `stock_profiles`
     - 欄位: supply_chain, key_customers, key_suppliers, business_desc, wikilinks
     - 每週日 cron + 手動 `timeverse-sync` trigger
     - Migration: `worker/migration_timeverse.sql`
   - **待做**: Debate Trader prompt 注入 `stock_profiles` 資料
   - **Debate 相關檔案位置待找** (可能在 `worker/src/lib/debateTrader.ts` 或 Controller)

6. **Git commit + push** — 所有近期改動未提交
   - GitHub repo: `https://github.com/AngusRepo/stock-analyzer.git`

### 重要參考
- Auth token: `sv-stockvision-2026-prod`
- Worker URL: `https://stockvision-worker.angus-solo-dev.workers.dev`
- D1: `stockvision-db` (6401a5f6-5767-4fa8-a1a7-ec8d4739ac79)
- Controller: `https://ml-controller-530028717113.asia-east1.run.app`
- Controller token: `sv-controller-2026-prod`
- FinMind sector: `fetchTWStockInfo` → `industry_category`（~30 TWSE/OTC 官方分類）
- Screener 分類: AI_Server, HBM記憶體, IC設計（細粒度，獨立於 FinMind）
- **兩套分類共存**: FinMind → Dashboard 族群流向; Screener → ML 選股
