# R33-NEW-37 實盤協議預先登記（草稿 v1）

> 狀態：草稿。**必須在看到任何 Paper 結果之前凍結**。Wei 在 Paper 第 1 天前核准（plan 寫 11/10 前）。
> 凍結時，把本檔的 git blob sha 記進 DECISIONS。之後要改，只能開新版並寫明理由，不能回頭改舊版。

## 1. 交易範圍
- 實盤只跟 Paper 當天實際 commit 的委託：同一檔、同一方向。實盤不跑配置器，也不自己選股（D-6）。
- intake 走 pull（L0 方案 B）：
  - 非 native 的 cron 呼叫端在 `runIntradayCheck`／`runEODExit` 之後觸發。
  - controller 用 `paper_orders` 的 cursor 讀取已 commit 的委託意圖。
  - 這個做法涵蓋 Paper 的 7 個寫入點：auto_ml 買進、auto_swap、daytrade_force_close、eod_exit、eod_tp1，以及兩處 intraday_exit。
- 實盤只讀委託意圖，不讀 Paper 的現金、持股表、NAV 表（T3）。
  - 買單的分母例外：讀 Paper 下單當下已算好、由 Paper 自己寫進 `paper_order_sizing_v1` 的 `portfolio_value`（見 §2）。
- 每筆委託拆成整股和零股兩條 leg，TSE 和 OTC 都支援。Paper 的 `validateOrder` 不改（H1c）。
- 結果不明的委託只對帳、**絕不重送**：`live_intake_orders_v1` 的 UNKNOWN 只能轉成 RELAYED 或 BLOCKED。
  - 送出前先標成 UNKNOWN，標記帶一次性的 attempt 值，兩個重疊的 pass 不會都以為自己標到。
  - 唯一例外（Wei 10/29 核准的 0008 窄例外）：賣單被明確標記為「reserve_intent 之前就擋下」，才轉回 DEFERRED，下一交易日重驗再送。買單照舊記 BLOCKED。
    - 條件全部成立才算：`status` 剛好是 `blocked`；`blocked_before_reservation` 剛好是 `true`（gateway 的 reserve 前擋單和 relay 送出 POST 前的擋單才會帶；gateway 回覆前會再查一次這個 key 有沒有 intent，有、或查不到，就改成 `false`）；沒有 intent_id、沒有已送 leg、沒有券商委託編號；原因不是 idempotency conflict，也不是 reservation 寫入失敗。
    - 其他任何情況都可能已經到券商，一律維持 UNKNOWN、只對帳：逾時、連線錯誤、5xx、非 200、partial、reserve 之後的 leg 擋單、旗標缺漏或不是 `true`、未知狀態。
    - 轉回之前再讀一次控制狀態；標成 UNKNOWN 之後有 pause，就記 BLOCKED，不轉回 DEFERRED；控制狀態讀不到，就維持 UNKNOWN、只對帳。
    - 已知殘留：reserve 之後才被暫時性原因擋下的 leg，對帳後會記 BLOCKED，這筆出場不會自動重送，由 Wei 手動處理。
- 同一天已經承諾出去的現金和股數不會被重複使用：
  - 買單保留當天 RECEIVED 和當天送出（RELAYED、UNKNOWN）的現金；
  - 賣單保留 RECEIVED、DEFERRED、所有 UNKNOWN，以及當天送出的 RELAYED 股數；
  - 「當天送出」看 `sent_on`（送出的台灣日期），不是 Paper 的下單日。
  - Gateway 送單前另外扣掉同一檔、當天其他還沒完結的賣單 leg；這個檢查和 reserve_intent 在同一把 submit lock 裡，兩筆並發的賣單不會同時通過。
  - 每一筆送出前，從 D1 重新算一次「其他列」已承諾的現金和股數，不用 pass 開始時的快照，所以兩個重疊的 pass 不會用到同一筆錢或同一批股票；不夠就先不送（`cash_committed_elsewhere`、`exit_waits_for_open_sells`）。
    - 先進先出：已送出的列（UNKNOWN、當天 RELAYED）和比自己早記錄的未送出列才算「其他列」；比自己晚的未送出列不算。較晚的列一定會替較早的列保留，所以最早的一筆永遠能先走，兩筆出場不會互相卡住。順序看記錄時間（created_at），不看編號字串。
    - 還沒送出的 DEFERRED 清倉單，放行時會賣掉當下全部可用持股，所以送出前替該檔保留全部持股；其他賣單等它送出後再算。
  - 已成交的部分可能被重複扣，結果只會少買或少賣，不會超買或超賣。
  - 出場不因此丟失：保留的股數吃光可用持股、但券商實際還有持股時，改用實際持股換算並記 DEFERRED（`exit_waits_for_open_sells`），下一交易日重驗；放行時券商實際持股為 0 才記 BLOCKED。

## 2. 資金與股數換算（D-6）
- **實盤 NAV（3a）**：券商現金＋持股市值（當下權威報價）−未交割。KV：`trading:live_config.capital_source='broker_nav_authoritative_marks'`。
  - 持股報價（Wei 10/30 Q1）：用券商 snapshot 當天的最後成交價。snapshot 顯示當天還沒成交（成交量 0，或最後成交在更早的日子）時，改用券商合約表 `update_date` 為今天的參考價（`shioaji_contract_reference_price`）。合約表不是今天的、`trading_suspended`，或 snapshot 根本沒回來，都不給報價。每日帳本 snapshot（R18）也用同一套報價（Wei 10/30），`marks` 逐檔記下來源：`shioaji_snapshot_last_trade` 或 `shioaji_contract_reference_price`（gateway 回的類別是 `snapshot_last_trade`／`contract_reference`）。
  - NAV 算不出來時（Wei 10/30 Q2）：只擋買單。這一輪不記錄新的買單（下一輪再試，過了當天就照漏掉日子的規則 SKIPPED），已記錄的買單也不送；賣單和出場照常，依 Live 持股換算，不需要 NAV。每輪發一次 `live_intake_nav_unavailable` 告警。gateway `/v1/marks` 讀不到（503、逾時）也算 NAV 算不出來：持股全部沒有 mark，只擋買單。帳戶觀測本身讀不到或驗證不過時，照舊整輪不做。
- **Paper 分母（3b，只用在買單）**：Paper 下單當下的 `portfolioValue`（就是 `sizingAuthorization.portfolioValue` 那個值）。
  - 來源（Wei 10/29 方案 A）：Paper 在買進寫入點把已算好的值另寫一列到 `paper_order_sizing_v1(order_id, portfolio_value)`。
  - 這是 native 改動，獨立 commit、搭 Slice A；Paper 的決策、寫入順序和失敗行為不變，這列寫失敗也不擋 Paper。
  - 分母接上之前（或某筆沒有這列），買單一律 BLOCKED，原因 `paper_denominator_unavailable`。
  - 這列還讀不到時（Wei 10/30 A 案）：這一輪不記錄這筆買單、不送單（summary `waiting`），下一輪再讀。期限是該筆 Paper 買單當日的 `trading:live_config.session.continuous_close`（含 13:30:00），不新增常數。
  - 過了期限仍讀不到：記 BLOCKED `paper_denominator_unavailable`（漏掉日子的買單也是這個原因，不記 SKIPPED），conversion 帶 `paper_denominator_not_ready`，並發出 `live_intake_paper_denominator_unavailable` 告警（summary `warnings`，由 cron 呼叫端寫 writeSystemLog(ops, warn)＋console.warn）。告警在寫入成功後才發，每筆只發一次；告警端失敗不影響這一輪。
  - 盤前或收盤後才下的 Paper 買單本來就不送，所以不等這列、不告警，照舊記 SKIPPED `paper_buy_outside_session`。
  - 等這列的期間，如果同一檔較晚的 Paper 賣單已經入列（較晚的買單不算），這筆買單記 BLOCKED `paper_buy_superseded_while_waiting` 並告警（`live_intake_paper_buy_superseded`），不送，避免 Paper 已出場後 Live 才進場。
  - 已知缺口：Live 第一天如果只有等待中的買單、收盤後又沒有再跑一輪，隔天這筆會被略過（沒有 row、沒有告警；不會送出）。要補需要 Live 起始日的來源，待決定。
  - 同一個缺口也涵蓋 NAV：Live 第一天因為 NAV 算不出來而沒記錄的買單，隔天同樣被略過、沒有 row（當天每輪都有 `live_intake_nav_unavailable` 告警）。
  - 賣單不讀這列，不受影響。
  - 已接受的副作用：等待中的買單還沒入列，不佔現金保留額；同日較晚的買單可能先用掉現金，這筆入列時被現金截短。只會少買，不會超買。
- **買進**：
  - 比例 ＝ 實盤 NAV ÷ Paper `portfolio_value`，兩者都取委託當下的值。
  - 實盤股數 ＝ floor(Paper 股數 × 比例)，再依券商可用現金與 `trading:risk_config.order.maxSingleOrderValue` 截斷。
  - 可用現金 ＝ min(銀行餘額, 銀行餘額＋未交割淨額) − 當天已承諾（含結果不明）的買單所需現金。
    - 這裡的未交割淨額包含「今天到期」的款項：盤中觀察到的銀行餘額可能還沒扣。NAV 照 R18 規則，不含今天到期的款項。
- **賣出（3e，Wei 10/29 修正為按比例）**：
  - 實盤股數 ＝ min(floor(Paper 賣出股數 ÷ Paper 賣出前持股 × 實盤持股), 實盤持股)。
  - Paper 這筆把部位清空時，實盤把該檔持股全部賣出。
  - Paper 賣出前持股只從 `paper_orders` 依序累加推得，不讀 `paper_positions`。賣出股數大於推得的持股時記 BLOCKED（`paper_position_inconsistent`）。
  - 賣單不用分母。
- 換算結果、輸入和截斷原因寫進 `live_intake_orders_v1.conversion_json`，記錄 sha，之後不可修改。
- 單筆金額、每日筆數、價格偏離沿用 `trading:risk_config.order`，和 Paper 相同。實盤要不要另外設值由 Wei 決定。
- 現金緩衝從 `trading:config.fees` 推導，不寫死：整股和零股兩條 leg 各付 max(leg 金額 × `commission`, `minCommission`)。這個值不會低於 Worker 的逐 leg 手續費。
  - `commission`／`minCommission` 缺漏，或 `trading:risk_config.order.maxSingleOrderValue` 缺漏時（Wei 10/30 m-4）：比照 Paper 分母還讀不到的規則。這一輪不記錄這筆買單、不送（summary `waiting`），下一輪再讀；到該筆 Paper 買單當日 `session.continuous_close` 仍缺，才記 BLOCKED（`trading_fees_unavailable`／`risk_config_unavailable`）並發 `live_intake_trading_config_unavailable` 告警（每筆一次）。不用 Python 預設值。盤外的買單照舊 SKIPPED `paper_buy_outside_session`；分母和設定同時缺時，記分母的原因；Paper 分母存在但不能用（不是正數）的買單照舊立刻 BLOCKED、不告警，不等設定。
  - 賣單換算不需要這兩個值，照常記錄。現況：`trading:config` 缺時出場照常送；`trading:risk_config` 缺時 kill switch 讀不到，所有送單（含出場）在簽封包時停下（`packet_unavailable`，列保留，下一輪重試，跨日轉 DEFERRED），出場不會丟失。KV 讀取本身失敗（HTTP 錯誤）時整輪不做。

## 3. 時段
- **連續交易時段外 commit 的 Paper 出場（3c）**：記成 DEFERRED，下一交易日 `deferred_sell_release`（09:00）後用新報價重驗再送。
  - 時段判斷精確到秒：13:30:01 commit 的出場算時段外。
  - 時段內 commit、但當天沒送出的出場，隔天也轉成 DEFERRED；同樣情況的買單記 BLOCKED，不跨日送。
  - intake 漏跑的交易日：那天的出場記 DEFERRED（`paper_exit_missed_by_intake`），買單記 SKIPPED。
  - 重驗時券商持股（扣掉其他列已保留的股數）如果已經少於換算股數，就截斷；Paper 清倉的那筆賣出當下全部可用持股；券商實際持股為 0 才記 BLOCKED，並寫明原因；實際還有、只是被其他賣單保留，就先不送。
  - 報價、持股或簽章讀不到時，維持原狀態（RECEIVED 或 DEFERRED），下一輪再試，不記 BLOCKED。時段內沒送出的出場，隔天照上一條轉成 DEFERRED。
  - 還沒送出就 pause 時，照 D-7 不送（BLOCKED `live_paused_before_send`）；之後由 Wei 手動處理。
    - 判斷用 `last_pause_at`（控制鏈最新一筆 pause 的時間）：委託最後一次變成可送（`updated_at`）之後有 pause，即使 pass 執行前已經 resume，也一樣不送。
    - 讀得到的控制鏈一定有 `last_pause_at`（第一筆就是 pause）。沒有這個值代表沒讀到：這一輪不送，也不做任何會更新 `updated_at` 的轉換（例如換日轉 DEFERRED），以免蓋掉之前的 pause。
    - 換日、放行 DEFERRED、送當天 RECEIVED，以及每筆送出前的最後一次讀取，都會檢查。時間讀不懂（沒有時區）一律當成已 pause。
  - 核准過期或控制狀態讀不到，只算暫時關閉：委託維持原狀態，不送也不 BLOCKED。
  - 每一筆送出前，都重新讀一次控制狀態和當下時間；任一項不通過就先不送。
  - 只送「今天」的 RECEIVED；別的日期的 RECEIVED（例如重疊 pass 剛寫進來的）不送。
  - **清倉補賣（Wei 10/29）**：Paper 在某檔已經空手、最後一筆 Paper 委託是一筆前一交易日（或更早）已送出的清倉，而 Live 還有殘量（例如同日一筆部分成交的賣單讓清倉少賣），下一交易日 `deferred_sell_release`（09:00）後記一筆 DEFERRED 補賣（`paper_orders:<id>:topup:<日期>`），股數取 Live 當下持股，不從 Paper 推；接著照其他 DEFERRED 出場的方式重驗再送。
    - 不補賣的情況：Paper 還有持股、清倉之後 Paper 又交易過該檔、同一檔還有未送出或結果不明的列、同一檔今天已經送過單（可能還在成交）、清倉送出當天（台北時間 00:00 起）或之後有過 pause、券商已經沒有持股、control 不是 open 或讀不到。
    - pause 用「送出當天」比，不用 `updated_at`：reconcile 會刷新 `updated_at`，會把送出後的 pause 蓋掉；整天都算只會少補賣，不會多補。
    - 補賣送出後如果還有殘量，下一交易日再補一次；最新一筆補賣若是 BLOCKED（例如過期且券商沒有委託），就不再補，留給人工處理。
- **mode 切換（Wei 10/29，E）**：Live 開始之後切回 `mode=paper` 的那幾天，切回 live 時一律當成 intake 漏跑的日子：出場記 DEFERRED（下一交易日重驗），買單記 SKIPPED。
- 交易時段與假日讀 `trading:live_config.session` 和 holiday KV。

## 4. 評估
- **主要**（實盤和 Paper 的落差）：
  - 成交率；
  - implementation shortfall（實盤均價對 Paper 成交價，單位 bps）；
  - 換算截斷損失；
  - pull 延遲（Paper commit 到實盤送出的秒數）。
- **次要**：實盤扣出入金後的報酬（`live_daily_snapshots_v1` 的 return index，NEW-H1g）對同期間 Paper NAV 報酬，附 HAC CI。
- 訊號品質的評估仍然只看 Paper，Paper 持續並行。

## 5. 停止規則
任何一條成立，就一鍵 pause（D-7，不需要 go）：
1. 結果不明的委託到下一交易日開盤前還沒對帳完成。
2. 券商端和實盤帳本對不上。
3. 出現對不回 Paper 委託的實盤單。
4. 落差帶超界。帶寬在 R4-gate 時，用 20 日 Paper 的 `paper_broker_reconciliation` expected_slippage 分布算成一個獨立產物；R4-gate 收據帶它的 sha（`slippage_band.artifact_sha256`），不是人為常數。
5. 單日和累計暫停線：欄位存在但不啟用（R_PLAN §3、`trading:live_config.pause.enabled=false`）。要啟用時，值取「修正未交割後的 Paper NAV 回放最差值」，先給 Wei 看再開。

## 6. 退回紙上與恢復
- **退回（D-7）**：
  - 新的買單和賣單都停；
  - 已送出的委託照常對帳，broker session 不關；
  - 持股由 Wei 手動處理。
- **恢復（D-8）**：resume 是獨立指令，必須帶 Wei 核准的 scope、到期時間和 R4-gate 收據 sha。三者都要等於部署值，而且未過期。
  - 核准 env 失效時，系統讀成暫時關閉，不算 durable pause；按一次 pause 會寫入停止紀錄。

## 7. 取代的舊規則（d）
- Worker `submitSignedLiveExecutionPacket` 裡有一條規則：「KV `ml:active8:paper_admission:v1` 有值時，Paper 策略不能送實單」。
- 新的實盤路徑不經過這個函式，D-6（實盤照 Paper 下）取代了這條規則。那個函式維持原樣，不刪也不改。

## 8. 評估期與後續
- 前 20 個實盤交易日每週報告一次，期滿由 Wei 決定繼續、放大或停止。
- 實盤起始日由 Wei 決定（X1），本計畫提供的最早日期是 12/10（四）。
