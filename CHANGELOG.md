# StockVision Changelog

All notable changes to this project will be documented in this file.
Format: [Conventional Changelog](https://keepachangelog.com/)

---

## [12.4.0] - 2026-04-03

### Changed — Screener v2 Bottom-up 多因子重構
- **架構翻轉**：Top-down（概念族群→個股）→ Bottom-up（全市場個股評分→產業加分）
- **籌碼評分**：絕對金額 → 相對比例（`法人佔日均成交%`），消除大小型股偏差
- **RRG 產業輪動**：官方 38 產業 TWSE/TPEx + Regime-conditioned 參數（HMM bull→長窗口, sideways→短, high vol→極短）
- **趨勢品質 Gate**：ADX14 + 價格意圖因子（Kaufman ER）+ 流動性分級
- **D1 資料源**：多因子評分改讀 D1 stock_prices（API fallback），假日結果可重現
- **候選硬上限**：top 25 + 同產業 ≤5 + Pearson 60d 去重（舊流程 ~45 檔不穩定）

### Added — FinLab 12 項優化
1. 籌碼相對比例（`chip_intensity = net_buy / avg_daily_turnover`）
2. RSI 40-80 全給分，超買不扣分（FinLab 回測驗證）
3. 價格意圖因子（`return / Σ|daily_return|`，偵測主力護盤）
4. F-Score 簡化版 overlay（5 項基本面品質）
5. NATR 低波動加分（<3% + MA 上方 = 穩健趨勢）
6. Z-score 工具函式
7. IC 驗證框架（`/admin/trigger/factor-ic`）
8. MAE 停損分析（`/admin/trigger/mae-analysis`）
9. MDD 動態部位管理（Circuit Breaker binary→連續調控）
10. 外資淨買超天數佔比（<35% → 全體扣分）
11. ATR V 轉指標（market NATR > 8% 偵測）
12. 營收高成長加分（YoY > 20%）

### Fixed — ML Ensemble
- `avg_confidence` 只算勝出方向模型（修正全模型平均導致信心被拉低）
- Soft gate 放寬：`signal_score ≥ 0.52` 給 BUY/SELL（原本單項不過就強制 HOLD）
- TWSE/TPEX 產業代碼 map 全面重建（用 sample stocks 逐一驗證）

### Fixed — Pipeline 一致性
- Screener 寫 `daily_recommendations`（chip+tech+price），recommendation 只補 ML
- 移除有害的 `INSERT OR REPLACE`（舊 Controller 殘留，覆寫 screener 分數）
- `buildStockPayloads` 擴大查詢範圍（含 daily_recommendations 的股票）
- `current_price` 改讀 D1 stock_prices（不依賴 technical_indicators 的舊日期）
- `is_active` 保證：screener 寫完 recommendations 後強制 UPDATE
- `sector_flow` UNIQUE 約束加入 `classification`
- 推薦理由三面向：【籌碼】+【技術】+【ML】

### Removed
- 舊 `runMarketScreener`（top-down，832 行 dead code）
- `computeSectorHeatScores` + `filterCandidates` + `SectorAgg` interface
- Controller `/recommend` 依賴（recommendation 改為本地評分）

### Impact
- `marketScreener.ts`：-832 行 dead code，+500 行新 bottom-up 邏輯
- `ensemble.py`：avg_confidence + soft gate 修正（Modal deploy）
- `dailyRecommendation.ts`：流程從「自己算分」改為「讀 screener + 補 ML」
- 新 migration：`migration_screener_v2.sql`、`migration_sector_flow_unique.sql`

---

## [12.3.0] - 2026-04-01

### Changed — ML Anomaly Gate 重構
- Isolation Forest hard gate → soft penalty（不再阻擋 model 推論）
- HMM Regime 提前到 pipeline 最前面
- Conformal Prediction 加入（Split Conformal 校準器）
- Signal score 從硬階梯改為連續分數
- `confidence_threshold` 0.60 → 0.55（adaptive via KV）

---

## [12.2.0] - 2026-03-27

### Changed — MVC 架構重構
- **Worker → Controller → Modal 三層 MVC**
  - Worker (TS): cron 調度 + data pipeline + D1/KV CRUD (1268→1206 行)
  - Controller (Python/Cloud Run): ML orchestration + scoring + adaptive params (977 行)
  - Modal Functions: 並行 ML compute (predict / retrain / ARF)
- Worker `processMLBatch` 移除 (~255 行)，ML_QUEUE 移除
- `dailyRecommendation.ts` 評分邏輯移至 Controller `/recommend`
- `adaptiveEngine.ts` 計算邏輯移至 Controller `/risk-assess`
- `predictionVerifier.ts` 新增 ARF feedback via Controller `/verify`

### Why
- 解決 cron timeout + sequential batch 效能瓶頸
- ML 邏輯集中在 Controller (Python)，不再分散在 TS + Python 兩端
- Modal `.map()` 並行推論：77 stocks in ~150s（舊架構 12-15 min）

### Impact
- 新增 `ML_CONTROLLER_URL` / `ML_CONTROLLER_SECRET` 環境變數
- ML_QUEUE 移除（wrangler.toml + types.ts）
- 所有 Controller 路徑有 legacy fallback（ML_CONTROLLER_URL 未設定時走舊路徑）

### New Files
```
ml-controller/
  main.py, Dockerfile, requirements.txt
  routers/  predict.py, retrain.py, verify.py, recommend.py, risk.py, status.py
  services/ modal_client.py, scorer.py, adaptive.py
```

### Deployments
- Controller: `https://ml-controller-530028717113.asia-east1.run.app`
- Modal: `https://wayne60619--stockvision-ml-fastapi-app.modal.run`
- Worker: `bae24d2d` → `3f4cabb7`

---

## [12.1.0] - 2026-03-27

### Added
- Adaptive Parameter System (9 files)
- Freqtrade W1 基礎建設 (Docker + Strategy + Cross-validation)
- D1 `backtest_results` table
- Worker `GET /api/cron/schedule` (single source of truth)

### Fixed
- paper.ts 8 處 UTC→TW timezone (M6)
- Position sizing dailyRemaining (M11)
- Cron `*/1` → `*` syntax (M12)
- Intraday heartbeat KV mechanism

---

## [12.0.0] - 2026-03-26

### Added — Day-1 Production Launch
- Bot Dashboard (Dark mode + Mobile-first)
- Paper Trading Real-Time (4 functions + limit order simulation)
- KV Config System (38 parameters)
- US Leading Indicators + Monthly Revenue + Market Breadth + Margin/Shareholding
- FEATURE_COLS: 27→44 (+17 ML features), D1 Tables: 29→34

### Fixed
- FinMind aggregateChips Chinese→English mapping
- PE/PB from TaiwanStockPER dataset
- CronLogger UTC→TW date (6 locations)
- Pipeline admin trigger + waitForQueue
