# Findings — Day-1 Production Issues

## Phase 1: Data Issues

### D1: 三大法人籌碼都是 0
- **Frontend**: `ChipChart.tsx:8-23` → calls `/api/stocks/:id/chips?days=60`
- **Worker**: `stocks.ts:144-154` → `SELECT * FROM chip_data WHERE stock_id=?`
- **Schema**: `chip_data` table exists with `foreign_net`, `trust_net`, `dealer_net` ✅
- **Pipeline**: `finmind.ts:62-69` `fetchTWChips()` → `aggregateChips()` → INSERT
- **Root Cause**: chip_data 未被填充。pipeline 存在但可能未執行（cron 問題？FinMind token？）

### D4: 財報 EPS/PE/PBR/殖利率/ROE 都是 "--"
- **Frontend**: `FinancialSummary.tsx:31-36` expects `latest.pe`, `latest.pb`
- **Worker**: `stocks.ts:328-337` INSERT 只寫 9 欄（eps/revenue/roe/dividend），**缺 pe、pb**
- **Schema**: `financials` table 有 `pe REAL`, `pb REAL` 欄位但從未被填入
- **Root Cause**: `parseFinancials()` (finmind.ts:357-395) 不提取 PE/PB。FinMind 的 TaiwanStockFinancialStatements 本身不含 PE/PB
- **Timeverse**: 只填 `stock_profiles.financials_summary` (JSON text)，不寫 `financials` structured table

### D8: 每日選股評分明細(籌碼/技術/ML)都是 0
- **Frontend**: `DailyRecommendationPanel.tsx:115-120` expects `chip_score`, `tech_score`, `ml_score`
- **計算**: `dailyRecommendation.ts:204-264` 正確計算三項分數
- **INSERT**: `dailyRecommendation.ts:389-402` 只存 `score`（total），**不存三項子分數**
- **Schema**: `daily_recommendations` 表**缺** `chip_score`, `tech_score`, `ml_score` 欄位
- **Root Cause**: Schema + INSERT 都缺三項子分數欄位

### D9: 族群資金流向都是 +0.0
- **Frontend**: `DailyRecommendationPanel.tsx:162-183` expects `total_net`
- **計算**: `dailyRecommendation.ts:106-108` 從 `foreign_net_5d` + `trust_net_5d` 累加
- **Root Cause**: 依賴 chip_data（D1），若法人資料是 0，sector_flow 也必然是 0。連鎖問題。

## Phase 2: Bot Cron Issues

### B1: 多個 cron 今天沒跑
- Cron schedule (UTC → TWN):
  - `30 22 * * 1-5` → 06:30 TWN — US Leading
  - `15 23 * * 1-5` → 07:15 TWN — Morning Setup
  - `50 23 * * 1-5` → 07:50 TWN — Morning Brief
  - `*/1 1-5 * * 1-5` → 09:00~13:59 TWN — Intraday Check
- Holiday check: `index.ts:961-966`，若 KV 有 `holiday:2026-03-26` 就跳過
- **待確認**: KV 中是否有 `holiday:2026-03-26`？

### B2: Signals 頁籤空的
- **Frontend**: `BotDashboard.tsx:236` 用 `new Date().toISOString().slice(0,10)` (UTC)
- **Backend**: `dailyRecommendation.ts:359` 也用 UTC 存日期
- **Root Cause**: UTC vs TW 時差 8 小時。cron 在 15:35 TW (07:35 UTC) 跑，存的日期是 UTC "2026-03-26"。但若前端在凌晨後 (00:00~08:00 TW = 16:00~24:00 UTC) 查詢，UTC 日期已是下一天 → 查不到。
- **更關鍵問題**: 今天本來就應該看到「昨天」分析的推薦，但前端用 `today` 查詢。

### B3: Bot 看不到 signal 詳細
- **BotDashboard SignalTable**: `BotDashboard.tsx:235-276` 只顯示最小欄位
- **Root Cause**: 前端設計問題，SignalTable 沒做展開/詳細功能
- **✅ Fixed**: 加入 click-to-expand，顯示 score breakdown + reason + watch_points

## Fixes Applied (Session 2026-03-26)

### D1: FinMind 法人名稱不匹配
- `finmind.ts:aggregateChips()` 用中文「外資/投信/自營」，但 FinMind v4 回傳英文（Foreign_Investor/Investment_Trust/Dealer_self）
- **Fix**: 加入英文 name mapping

### D4: PE/PB 從未被計算
- `parseFinancials()` 不提取每股淨值，INSERT 不含 pe/pb
- **Fix**: 加 `bookValuePerShare` 提取 + 從 price/EPS*4 算 PE + 從 price/bookValue 算 PB

### D8: 評分明細子分數缺欄位
- Schema + INSERT 缺 chip_score/tech_score/ml_score
- **Fix**: ALTER TABLE + 更新 INSERT

### B1/B2: UTC vs TW 日期不一致
- cronLogger、API endpoint、frontend 全用 UTC `new Date().toISOString().slice(0,10)`
- 早上 cron 在 22:xx-23:xx UTC 跑，日期比 TW 少一天
- **Fix**: 全改 `new Date(Date.now() + 8 * 3600_000)` (TW date)
