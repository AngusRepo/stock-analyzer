# 永豐零股手續費修補發布紀錄

狀態：已依使用者批准完成程式提交、分支推送與正式 Worker／Pages 部署。

## 修補

- 手續費依整股與零股分別計算，零股依官方規則最低 1 元，費用小數捨去。
- 全部買賣及風控估費呼叫傳入實際股數。
- 畫面將含買入手續費的均成本明確標示，顯示兩位小數。
- 折扣月退分開認列，未將預估退費加入現金。

## 驗證

交易數學、13 個原生交易流程、7 個帳務測試、Worker TypeScript 與部署 dry-run、前端建置通過。正式程式來源核對與前端產物比對通過，指定模擬帳務更正完成並讀回驗證。瀏覽器視覺檢查未完成。

特定交易、帳戶、帳務事件、完整發布細節與讀回證據只保存本地。實盤帳務完整串接不在本次變更範圍。

## 官方依據

- https://www.sinotrade.com.tw/inside/Batch_Order
- https://www.sinotrade.com.tw/inside/dist/view/Batch_Order/js/main.nw.min.js
- https://www.sinotrade.com.tw/richclub/Decoding_Stock/video/-65645bd51c0a5012c8480876
- https://www.sinotrade.com.tw/ec/upload/Service-charge.pdf
