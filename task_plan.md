# Task Plan: Day-1 Production Issues Fix

## Goal
修復使用者回報的 13 個 Day-1 production 問題（Dashboard 10 + Bot 3）

## Phase 1: Data Issues `status: complete`
- [x] D1: FinMind aggregateChips 中文→英文 name mapping
- [x] D4: PE/PB 從 TaiwanStockPER dataset 取（非自算）
- [x] D8: daily_recommendations 加 chip_score/tech_score/ml_score 欄位 + INSERT
- [x] D9: 連鎖 D1，法人修好後 sector_flow 自動正常

## Phase 2: UI/UX Issues `status: complete`
- [x] D2: CandlestickChart.tsx K 線圖（OHLC + Volume）
- [x] D3: 風險指標/多因子分析 — 非 Manus 遺留，保留
- [x] D5: AI 分析 4 子頁籤 — 低重疊，保留
- [x] D7: StockHero 加 Home button → setActiveStock(null)
- [x] D10: 側邊欄改讀 per-user watchlist API（非 stocks.is_active）

## Phase 3: Bot Issues `status: complete`
- [x] B1: cronLogger + 5 API endpoints UTC→TW date
- [x] B2: 同 B1，date 統一 TW timezone
- [x] B3: SignalTable 加 click-to-expand（score breakdown + reason + watch_points）

## Phase 4: Pipeline 時序 `status: complete`
- [x] Admin trigger 加 `pipeline` task：依序等 queue 消化再跑下一步
- [x] waitForQueue 輪詢機制（10s interval, 5min timeout）

## Phase 5: D6 Regime N/A `status: won't fix`
- Regime N/A = market_risk 無資料時的合理降級
- 信心度由 10 模型 weighted vote 決定
