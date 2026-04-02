# Findings — 2026-03-28 Session 2

## #7/#8 興櫃分析
- stocks 表有 market 欄位：CHECK(market IN ('TWSE','OTC','US'))，無 EMERGING
- 興櫃資料目前不在 TWSE/TPEX API 中，需用 GRETAI API
- BUG: marketScreener.ts:749 硬編碼 market='TWSE'，OTC 股被標成 TWSE
- 修正計畫：1. 修 market 欄位 CHECK 加 EMERGING 2. 修 screener INSERT 邏輯判斷 TWSE/OTC 3. 暫不串接興櫃資料(無 API)，但在 screener 排除

## #4 Debate quadrant context 移除
- paper.ts L949-952：組裝 themeCtx
- paper.ts L969：傳入 runBuyDebate 第 9 參數
- debateTrader.ts：runBuyDebate 第 9 參數 themeContext?: string
- bullCase 注入位置：debateTrader.ts 內 bullCase 組裝

## #11 Phase 4.5 雙因子
- Leading+Mom≥0 → +0.00 | Leading+Mom<0 → -0.03 | Improving+Mom≥0 → -0.02
- 資料：sector_flow.rs_momentum（已有）
- 位置：paper.ts T2 filter 後、Debate 前
- 同步記錄 adjustment 到 quadrant_filter log

## PTT 情緒位置
- T1 Screener：pttBuzz.ts → marketScreener.ts
- buzzScore = min(30, mentionCount×5 + (sentiment>0 ? 10 : 0))
- 存入 D1 concept_buzz 表
- Debate 不讀 PTT 資料
