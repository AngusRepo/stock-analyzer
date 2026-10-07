# 3004 稀疏分鐘棒 ATR 暖機修補

狀態：本地驗證完成，Wei 已明確批准 commit／Research＋Worker deploy；發布與正式資料讀回進行中。不包含 push。基底為 production Worker source `7452a5ade09210c4e758cec837cab1642ded2c43`。

## 問題與修補

3004 今日首次原訊號是 09:20。當時只有四根今日五分 TR，需前一交易日最後連續交易五分 TR。昨日研究 K 線缺少三個分鐘標記；原程式要求每分钟都有 row，導致 unknown 一直無法修復。

- 新增 research `/atr-warmup/{symbol}?date=YYYY-MM-DD`：透過成功的歷史成交 ticks 區間查詢重建 13:19–13:25 六分鐘。只有完整 ticks 證明無成交才用先前實際成交價補零量棒；無 seed、無效成交、欄位／長度錯誤、逾時均拒絕。排除 13:25 後與收盤競價。
- Worker 原暖機 K 線不完整時改用此來源，核對 source、完整六分鐘時間戳及 OHLCV。有效結果以版本化 KV key 快取；暫時 cache 失敗仍可使用已驗證原始資料。
- 當日研究補抓 timeout 15 秒改為 25 秒，涵蓋實測 15.32 秒冷啟動；原送單截止、新鮮報價、L5、資金及風控仍適用。
- 保留首次訊號時間、當日 veto 與原 ATR 公式；unknown 只修原時點，不用後續訊號替換。原正式 ATR latch 不需手動刪除或重置。

## 驗證

- Research：12 tests passed。
- Worker：10 ATR tests、2 verified tick-warmup tests、9 native Paper scenarios passed（33 項含 research）。完整 native 證明 unknown 原時點修復後可成交且不重買；ticks 失敗時無 intent／order。
- 3004 今日真實研究 K 棒 fixture（0050 同時刻）重播原 09:20；已知末段價格／成交量 fixture 重建的前日 TR=0.5 時 ATR 通過。暖機成交 ticks fixture 是明示測試資料，尚非新端點的正式查詢收據；上線後須以實際 ticks 確認 TR。
- Worker production/test TypeScript、既有 s12RuntimeBars 回歸、native bundle 打包與 diff whitespace 驗證。
- 正式 Research 容器 image 的 `/app/main.py` 已只讀抽取，比對與本次 repo 基底相同；原 source archive 已不存在，使用容器內容作為驗證。SHA256 `13c6e7255a71c24667117dfeaa73975842e27136cd545dcbc9605dd9bf88f4b1`。
- 今日 streaming 缺少的17分鐘，原 research 回傳皆 volume=0。昨日 research 缺列原始 SDK 原因尚未證實；修補不把缺列直接當零成交。

## 發布及回滾

需 Wei 明確批准 commit/deploy，依 AGENTS.md Hard Safety Rules。

1. 限定提交本文件及本次列出的八個 source/test/fixture 檔案；不得夾帶主工作目錄修改。
2. 重新確認 production source、Research 設定、現有 runtime 核准未漂移。Research 先部署並保留服務設定，再只讀查 `/atr-warmup/3004?date=2026-10-06`，驗證實際返回六分鐘與 TR。若失敗停止 Worker 切換。
3. Worker 以帶來源驗證的既有部署工具發布；不得順帶部署舊 Controller、Proxy、Pages 或改核准 KV。
4. 以自然 intraday-check 的下一根完整五分棒確認原 ATR unknown 是否修復及目前阻擋原因。觀察意圖／成交，不手動補舊訊號或強迫成交。
5. 回滾：Worker version `f8e49000-877d-4f21-8380-14a24b159187`；Research revision `shioaji-research-00005-fwk`。保留 ATR 與成交證據，不刪表或 reset 當日狀態。

## 檔案

- shioaji-research/main.py
- shioaji-research/tests/test_research_service.py
- worker/src/lib/s12RuntimeBars.ts
- worker/src/lib/paperEntryTasks.ts
- worker/src/lib/atrTickWarmup.test.ts
- worker/src/lib/paperAtrOnce.test.ts
- worker/src/lib/paperAtrOnce.3004.fixture.json
- worker/src/lib/paperSwingNative.test.ts

## 來源

Paper D1 2026-10-07 事件 169550/169552、paper_atr_once_v1；Cloud Run 09:20 logs；只讀 research/proxy K 線；Shioaji 1.5.5 本地 ticks signature 與官方歷史行情文件 https://sinotrade.github.io/tutor/market_data/historical/ 。
