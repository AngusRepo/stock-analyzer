# 2026-09-30 S12 / A-B 模擬交易修補

## 原因與變更

- S12 盤中只取當日分鐘 K，前一交易日 15m／1H 結構未預抓，開盤須等待當日結構。07:15 與 08:50 預抓前一交易日分鐘資料並驗證日期與價格區間；09:10–09:30 的 5m 回收訊號只在前一日偏向、當日掃低、連續回升、VWAP 與 2.5% 停損條件成立時提供半額模擬進場。
- 風控停買時報價快取提前返回，待買目前價位過期。Broker 報價在風控判定前更新，仍遵守 90 秒顯示期限。
- A 推薦曾被隔離比較的 baseline 覆蓋，改以正式 L4 Paper 計畫為唯一 A 清單來源。
- B 的完整帳戶 NAV 登記錯過首格時，原流程連選股配置也跳過。晚到時僅封存 B 配置並標示 selection_only；不建立 execution pair、不補 NAV 格、不給成熟度。

## 來源與驗證

Wei 於 2026-09-30 批准這批修補 commit、push 並部署到正式系統的模擬交易，不涉及真實券商下單。來源提交以部署證明 SHA 為準。重跑 Python 37 項、Worker 4 組與型別檢查、前端正式編譯均通過。Cloud Build 要求 native-paper bundle 的精確行為版本；本次變更使其指紋為 `native-paper-v1:4f5f6555107617427166bf53f396696b7b0abc01df3bb8ae8d90eb509b274be0`。

此來源身份檔只允許映像建置，不是 active8 Paper runtime approval，不宣稱舊新版等價，也不移轉完整帳戶 NAV 成熟度。9/29 訊號日的 9/30 NAV 首格已錯過；今日不能補成 prospective 績效。盤前預抓與開盤分支最早由下一交易日完整驗證。

Raw source: `worker/src/lib/s12RuntimeBars.ts`, `worker/src/lib/s12IntradayStructure.ts`, `worker/src/lib/paperEntryTasks.ts`, `worker/src/lib/strategyAbRecommendations.ts`, `ml-controller/services/paired_nav_pipeline.py`; Cloud Build `009a577c-5324-48bf-8ac3-3ef8517fda0b`。
