# Findings — 完整財報資料流 Audit

## 現有架構
- `financials` 表：stock_id, period, period_type, revenue, revenue_growth_yoy, eps, roe, pe, pb, dividend_yield, dividend_per_share, book_value_per_share, price_at_record
- 已填：eps, revenue, roe（quarterly from t187ap06/07）, pe, pb, dividend_yield（daily from BWIBBU）
- 未填：book_value_per_share, price_at_record, dividend_per_share, revenue_growth_yoy

## 資料來源已在用
- TWSE t187ap06 (損益表) → eps, revenue — 已在 fetchTwseFinancials()
- TWSE t187ap07 (資產負債表) → roe — 已在 fetchTwseFinancials()
- TWSE BWIBBU_ALL → pe, pb, dividend_yield — 已在 fetchTwseValuation()
- 對應 TPEX endpoints 也已在用

## 缺少的欄位
需求：operating_income, net_income, total_assets, total_liabilities, cash_flow
- operating_income (營業利益) → t187ap06 有
- net_income (本期淨利) → t187ap06 有
- total_assets (資產總計) → t187ap07 有
- total_liabilities (負債總計) → t187ap07 有
- cash_flow → t187ap08 (現金流量表)，需確認 endpoint 是否存在

## 安全改動策略
1. ALTER TABLE 加新欄位（nullable，不影響現有）
2. 修改 fetchTwseFinancials / fetchTpexFinancials 多提取欄位
3. INSERT ON CONFLICT 用 COALESCE 保護現有值
4. 前端 FinancialSummary 加新區塊顯示
5. 不動 fetchTwseValuation（PE/PB 流程不改）

## 關鍵檔案
- worker/src/twseApi.ts: fetchTwseFinancials() L504, fetchTpexFinancials() L360
- worker/src/index.ts: fetchWave2Data() L430, INSERT SQL L524
- worker/src/routes/stocks.ts: GET /financials L140
- frontend/src/components/FinancialSummary.tsx
