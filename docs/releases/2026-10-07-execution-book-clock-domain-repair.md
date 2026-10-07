# 執行報價時鐘域修補

狀態：本地修補與必要驗證全部通過，Wei已明確批准本次commit與僅Worker部署，發布進行中。正式基底為 Worker source203c071cdac06eedcc6ef695834779363cbb9f07，version54e7f050-1d12-43c1-bcd5-3413d063f9de。

## Root cause 與實際證據

2026-10-07 11:00，3004 event170179 的 Swing 所有執行條件與 ATR 通過；event170181 L5通過；event170185 L4允許買入，budget120508。event170191 最後拒絕 execution_book_stale_or_incomplete，沒有委託意圖或成交。

Worker snapshot.createdAt=03:00:25.130Z，Proxy confirmed_at=11:00:25.154894+08:00，Date.parse 差24ms。五檔完整，sessionEpoch1、streamHeartbeatAgeMs633。normalizedAge 將 Proxy 的確認時間直接和 Worker 時鐘比較，confirmedAt>nowMs 即失效。舊 L5 的 sourceTime=11:00:18.480298+08:00、age6650ms，不能替代最後執行報價。重播原觀測，舊程式原時間 blocked；只將驗證時點往後25ms即ready。這證明失效分支；沒有證明哪一台主機時鐘偏移。

11:15 唯讀確認：event170307 swing_waiting_or_touch，Paper intents/orders仍0。不能將11:00的全綠沿用成11:15可買。

## 修補

1. Worker在既有 batch/single streaming book HTTP呼叫前後量測 requestStartedAtMs/responseReceivedAtMs，且只有有效的遠端數值 quote_age_ms/source_age_ms 才生成 timingReceipt。遠端payload同名欄位不能覆寫此收據，null/負值/非數值不轉成0。
2. 同一 broker quote session 的確認年齡改採保守上界：Proxy quoteAge + Worker完整request RTT + Worker收到response後等待時間。各自時鐘只算自己的經過時間。原 sourceTime/confirmedAt保留原值作為證據；不把遠端確認時間抹成Worker now、不增加固定clock-skew容忍、不延長1500ms執行門檻。
3. 共用買賣 snapshot owner驗證timestamp有效、source<=confirmation、台灣當日、正整數session、活躍heartbeat（含傳輸與等待老化）；symbol_event仍受來源年齡3000/10000ms限制。沒有本地transport證據的舊路徑仍保留原嚴格future/stale檢查。
4. Swing訊號的quote時間投影到同一Worker時鐘域；board/odd L5轉換使用同一確認年齡；最後買入與兩條賣出snapshot呼叫保留timingReceipt和串流heartbeat。

## 驗證範圍

- event170191價格/時戳/深度回歸用顯式測試transport80ms：買賣共用owner通過，買單122只吃31股可見ask；不跨越122.5深度。
- 1500ms邊界、1501ms過期；quoteAge2000、長RTT、local clock regression、NaN、跨日、source晚於confirmation、失效session、過期heartbeat、symbol_event來源過期、沒有transport收據均fail closed。
- batch与single fallback均實測本地request/body時間；缺少/無效age與偽造payload收據不能產生權威收據。
- native完整情境加入L5通過後6秒account/risk處理，再取最後book：24ms跨服務確認差可買入、防重買、隔日hard-stop可賣出；新book stale/dead heartbeat且舊L5已過期時，0 intents/0 orders。所有native source皆是明示fixture，不是真實委託。
- 既有ATR暖機成功/缺資料/veto、缺broker book、unchanged stream book、正常退出、收盤競價、20交易日等回歸。

驗證log：output/atr-warmup-repair/native-clock-final.log；原始read-only事件：3004-1100-book-rejection.json；舊判斷重播：replay-book-rejection.ts。TypeScript production/tests及worker dry-run列入發布前確認。

最終結果：12個native完整情境全部通過；authoritativeExecutionSnapshot、paperIntradayData、paperExitTasks.oddLotExecution、paperOrderBookMatcher四組回歸通過；production/tests TypeScript、git diff --check、Worker deploy --dry-run皆通過。第一次dry-run受sandbox對外部node_modules junction限制，經只讀依賴授權後打包成功；沒有正式發布。

新增native fixture初次驗證失敗的原因已修正：舊事件超過board L5門檻時無法到达最後gate；另需區分account/risk處理耗時和HTTP傳輸耗時。最終fixture將第一份Controller L5設為當時新鮮，在account讀取時推進封存時鐘6秒，再讀取最後book。負例不借助仍新鮮的獨立L5掩蓋最後報價失效；正例還驗證防重買與隔日hard-stop退出。

## 操作邊界

此變更只需Worker；Research/Proxy/Controller/Pages不需發布。不得重置ATR、手動補11:00舊訊號、強迫觸發送單、改核准KV或啟用真實交易。正式是否生效須以新Worker source attestation及自然五分訊號的最新snapshot收據核對。

回滾：Worker54e7f050-1d12-43c1-bcd5-3413d063f9de；保留事件、委託、ATR與資金紀錄，不回復資料表。

## Raw source pointers

- Paper D1 paper_execution_events ids170179/170181/170185/170191/170307；paper_order_intents與paper_orders symbol3004/date2026-10-07。
- Worker203c071c:authoritativeExecutionSnapshot.ts normalizedAge；paperIntradayData.ts streaming讀取；paperEntryTasks.ts最後snapshot；paperExitTasks.ts兩個sell snapshot。
- Proxy7452a5a:main.py orderbook_effective_confirmation/orderbook_age_ms/_orderbook_payload。現有端點已提供quote_age_ms/source_age_ms，不需Proxy變更。
- https://developers.cloudflare.com/workers/runtime-apis/performance/ ：Worker Date.now/performance.now在I/O後更新。本次root cause不以此推定24ms物理偏移來源；修補使用實測subrequest經過時間。
