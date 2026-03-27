# StockVision Changelog

All notable changes to this project will be documented in this file.
Format: [Conventional Changelog](https://keepachangelog.com/)

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
