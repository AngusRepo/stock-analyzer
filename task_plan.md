# Task Plan: 財報 Bug Fix + AI 個股報告頁 + Dashboard 微調

## Task A: 財報 P/E P/B 殖利率缺值 Bug Fix
**Root Cause**: 估值 API（BWIBBU_ALL）寫入 financials 時 period 用 `2025-12-31` 日期格式，但季報用 `2025Q4`。前端查最新季度 → 取到 `2025Q4` → pe/pb/dividend_yield 都是 null。

**Fix**: 估值更新時，UPDATE 到最新季度的記錄而非插入新行。
- 位置: `worker/src/index.ts` fetchWave2Data → fetchTwseValuation / fetchTpexValuation 的 INSERT/UPDATE 邏輯
- 改為: 先查 `SELECT MAX(period) FROM financials WHERE stock_id=? AND period LIKE '%Q%'`，再 UPDATE 該行的 pe/pb/dividend_yield

## Task B: AI 個股報告頁（獨立頁面）
**需求**: 點擊個股 → 展開完整 AI 分析報告，不是 Dashboard 上的小面板。

**報告內容**（從 daily_recommendations + predictions 取）:
1. 信號 + 信心分數
2. ML 10 模型投票明細（每個模型方向 + 信心 + 權重）
3. 進場/停損/目標價（T1/T2）
4. 推薦理由（LLM 綜合）
5. 籌碼面（法人 5 日淨額）
6. 評分明細（籌碼/技術/ML 各項）

**實作**:
- 前端: 在個股詳情頁的 「AI 分析」tab 裡渲染完整報告
- 不需新 API — 現有 `GET /api/stocks/{id}/prediction` 已有 forecast_data（含模型投票）
- 位置: `frontend/src/components/AIAnalysis.tsx`（已存在，需擴充）
- 移除 Dashboard 上錯誤的 `AIReportPanel`

## Task C: Dashboard 確認
- Bar chart + Treemap + Ranking Heatmap Table 三個都保留（已完成）
- 移除 AIReportPanel（錯誤版本）

## 執行順序
1. Task A（財報 bug fix）— 改 worker 估值寫入邏輯
2. Task C（移除 AIReportPanel）— 快
3. Task B（AI 個股報告頁）— 擴充現有 AIAnalysis.tsx
4. Deploy + Verify
