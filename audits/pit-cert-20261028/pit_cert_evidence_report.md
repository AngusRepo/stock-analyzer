# C28-02 Phase 0：PIT vintage 認證證據報告

- 日期：2026-10-28（三），台灣時間。
- 受測程式：PR #78 `8938d5e1`。
- 性質：全程唯讀。GCS 只讀；D1 只用 SELECT（E3 讀 core `stocks`）；沒有寫入 KV、GCS、D1，沒有跑 Modal、沒有部署、沒有 commit。
- 依據：`plan_C28-02_pit_vintage.md` §1 定義、§2 V1–V6／U1–U5、§4.1 E1–E7，以及 `DECISIONS_WEI_20261028.md` C28-02 Q1–Q8 的答覆。
- 證據檔放在本目錄：

| E | 檔案 |
|---|---|
| E1 | `e1_availability.json` |
| E2 | `e2_revisions.json` |
| E3 | `e3_universe.json` |
| E4 | `e4_revenue_keydate.md` |
| E5 | `e5_lineage.csv` |
| E6 | `e6_truncation.json` |
| E7 | `e7_scale.json` |

---

## 1. E1–E7 結果

### E1 同日可得率（`e1_availability.json`）

**資料來源。** 98 份 `finlab-v4-daily-*` manifest（07-01～10-27）的 `source_key_reports`。以 r33trial-20261022d（下稱 F）的非空檔數當作終值分母。

**「21:00 鏈」的判定方式。** 某交易日 t 的 run 若在 t 當天 20:45–21:20 啟動，就算作 21:00 鏈的 run。這類 run 啟動後約 15–35 分鐘寫完。07-03～10-22 共有 80 個交易日，其中 59 天有這種 run。

| dataset | 21:00 同日有資料 | Q2（≥95%） |
|---|---|---|
| raw close／OHLCV、adj_close、market_value | 59/59 = 100% | lag 0 |
| 法人 foreign／trust／dealer_self／dealer_hedge | 58/59 = 98.3%（07-20（一）21:00 缺，22:31 補跑才到） | lag 0 |
| **融資／融券** | **0/59**（見下方說明） | **lag 1** |
| pe／pb（dividend_yield 同一 dataset） | 59/59 | lag 0 |
| 分點 broker | 58/59 = 98.3%（09-23（三）缺）；09-14（一）只有 53%，算缺時為 57/59 = 96.6% | lag 0 |
| TAIEX | 59/59 | lag 0 |

**融資／融券的細節。**
- 帳面上有 2/59 天「有資料」，那兩天是 10-12、10-13。但這兩天的 run 依 C28-25 會等候晚到的 lane，margin parquet 實際寫入時間是 22:19 和 21:51。
- 歷來同日最早出現 margin 的時間是 21:50（08-20（四））。
- 這與 #72 的 12/65 一致。

**月營收。**
- 只有 2026-06-10（三）這一列能逐日量測。key_date 當晚 22:00 的覆蓋率是 **98.94% < 99%**；+1 session（06-11 22:00）後是 99.19%。
- 另一個量測點：10-12 列在 10-13（二）21:00 的覆蓋率是 99.19%。
- 依 Q3 → **+1 session**。

**財報。**
- **無法量測。** 2026 年各截止日（05-15、08-14）當天都沒有 capture 含 eps／roe／revenue_growth_yoy。
- 代理指標：2020 年起有 31.4% 的 symbol×quarter 是在截止日當天才申報，另有 3.4% 晚於截止日（2026-Q2 有 739 檔落在 08-14 當天）。
- 依 Q3 採 fail-closed → **+1 session**。

**日曆。**
- 沒有 run 的平日共 5 天：09-25、09-28、10-09、10-23、10-26。KV 都有對應的 holiday。
- **2026-07-10（五）實際休市**：F 沒有 close 列，07-10 的 run 各 lane 全空，FinLab 也把 7 月營收的 key_date 改到 07-13。但 **KV `holiday:2026-07-10` 不存在**。這是 holiday 表缺漏，不是 capture bug。

### E2 revision 率（`e2_revisions.json`）

比對基準 F；容差為相對 1e-6、絕對 1e-9。

| 欄位 | 結果 |
|---|---|
| raw close | 0 改變（舊 vintage 05-17、07-01、10-12） |
| adj_close | 水準值改 0.505%（rebase）；日報酬只改 2 cell（V0701）與 1 cell（V1012）→ I |
| **market_value** | **V0701→F 改了 12.46% 的 cell**（932 檔，最多約 8 倍，推測是股數回填）；V1012→F 為 0.064% → **U2 成立** |
| 法人 | trust 0.019–0.026%、foreign 1 cell、dealer 0 |
| margin／short | 0 |
| pe／pb／dy | 4 cell（約 0.0003%） |
| **revenue（locked）** | **V0517→F 改 41 cell（0.061%）、V0701→F 改 27 cell（0.040%）** → locked 不是不可變，**V 級不成立** |
| **eps** | **S1013→S1027 這 14 天累計 0.659%**（roster 內 614／93,168 cell，44 檔）。其中 2 檔（6741、6875）是整段歷史乘同一常數（股數 rebase），扣除後仍有 **0.613%（42 檔、2024-Q3～2026-Q2 每季 24–36 cell）** → **> 0.5%**。依 Q4 走 (ii) 遮罩 |
| roe | 0.050% |
| revenue_growth_yoy | 0.005% |
| broker_daily | V0701→F 為 0.040% |
| V0603 eps | 不同 dataset（報表 EPS），標為 `invalid_comparison`，不採用 |

### E3 宇宙（`e3_universe.json`）

- capture 中有 173 個 symbol 停止交易，其中 79 檔是 4 碼普通股。
- **10-22 snapshot 的 roster 缺 41 檔下市股**，合計 13,425 個 symbol-day，佔 capture 的 0.40%。
  - 其中 40 檔是被 exporter 視窗（下市日 < 2023-06-26）排除；另 1 檔 4947 不在 core `stocks`。
- core `stocks` 裡有 28 檔下市股的 `delisted_date` 是 NULL。它們會被當成仍上市，但價格只到最後一筆，所以歷史仍會被使用。
- **V5：** 14 檔 TPEX→TWSE 轉市股，label 的市場別取的是 2026 年的 venue，造成 8,677 個非 PIT 的 label symbol-day；另一例 413 個。合計約 0.27%。
- 限制：R33 dataset snapshot 的起訖日存在 learning-db，本次沒有查。

### E4 月營收 key_date（`e4_revenue_keydate.md`）

- key_date 是**申報截止日**（10 日，遇假日順延），不是首次出現日。
- 早申報者的值會比 key_date 早出現（例：06-04 已有 8.6%），屬保守方向。
- 晚申報者的值會被補寫回**舊的 key_date 列**，屬前視方向：
  - 07-01 之後才補進的檔數：04-10 列 38 檔（17 檔當時已在交易）、05-11 列 25 檔、06-10 列 8 檔。
  - 即使 +1 session，06-10 列仍缺 16 檔（0.81%）。
- locked 與 revised 的 key_date 依 vendor 宣告（LOCKED_NOTE）相同，但 revised 版沒有 capture，無法實測。
- key_date 本身也會被改：07-10 → 07-13，原因是颱風休市。

### E5 lineage（`e5_lineage.csv`）

**方法。** 從 200 檔樣本中取 50 檔，每次擾動一條 builder 輸入路徑，跑 `build_feature_matrix(historical_training=True)`，記錄 131 個 feature 中哪些跟著變。

**來源分佈（131 個 feature，同一 feature 可有多個來源）：**

| 來源 | feature 數 |
|---|---|
| raw price | 91 |
| adj | 19 |
| 指標（由 raw OHLCV 重算） | 16 |
| 法人 | 6 |
| margin／short | 4 |
| 營收 | 3 |
| 財報 | 3 |
| pe／pb／dy | 3 |
| broker | 2 |
| market_cap | 1 |
| breadth | 1 |
| US | 1 |

**D1 snapshot 殘留（U4）：** 擾動 snapshot 的 `per_stock_ts` 殘留欄位（retail_pct、sector*、disposal、limit_down、locked_open_down）和 `stock_meta`，131 個 feature 都**沒有任何一個**跟著變。它們只會進 EXCLUDED 的 6 個 feature → **U4 不成立**，不需修改。另外 sentiment、holding 都不在 131 裡。

### E6 截斷等價（`e6_truncation.json`）

**規模：** 200 檔分層樣本（市值三分位 × 上市年齡，加 20 檔已停止交易）× 24 個 session，共 3,938 個 cell × 131 個 feature。

**(B) 純日期截斷：只有 1 個 feature 不一致。**
- feature 是 `l1_volumeMomentumDivergence132710`，11 個 cell 不同。
- 原因：`features/__init__.py:919` 以整欄是否存在來選 fallback。
- 這 11 個 cell 全落在該 symbol 的前 19 根 bar 內。R33 會切掉每檔前 252 列 warmup，所以**影響 0 筆 R33 訓練列**。
- 其餘 130 個 feature 都 bit-identical，包括 `avg_price` 整欄判斷那條分支。

**(C) 依 contract 截斷：不一致的 feature 全部可以由 V1／V2／V3 解釋，沒有其他漏洞。**

| 不一致的 feature | 不一致 cell 數 | 原因 |
|---|---|---|
| margin_balance、margin_ratio、margin_change_5d_ts | 約 2,870–2,895 | V1 |
| short_squeeze_proxy | 126 | V1 |
| l1_monthlyRevenueMoM、l1_monthlyRevenueYoY、val_sp | 約 1,030 | V2，只出現在 key_date session（含 07-13） |
| l1_eps、l1_roe、l1_revenueGrowthYoY | 672–689 | V3，只出現在截止日 session |

C2 實作之後，這些 feature 會依 contract 定義一致。

### E7 尺度不變（`e7_scale.json`）

**資料。** 用 r32 plan-a full-fit 的 artifact。score = forecast / signal_close − 1。

| 模型 | 結果 | 等級 |
|---|---|---|
| **TimeXer** | max \|Δscore\| ≤ 1.5e-7，**通過** | I |
| **PatchTST** | c=0.5 時為 2.1e-6，**超過 1e-6** | 需容差決定 |
| **iTransformer** | 所有 c 都超過 1e-6，最大 1.46e-4（約 cross-sectional std 的 0.21%）；rank corr ≥ 0.99999995 | 需容差決定 |

PatchTST 與 iTransformer 的成因是 RevIN 的 eps=1e-5；eps→0 時誤差為 0。

---

## 2. 建議 lag／等級表（依 Wei 門檻機械套用）

套用規則如下：

- **Q2：** 21:00 同日可得率 ≥ 95% → lag 0，否則 lag 1。
- **Q3：** 公告日 21:00 覆蓋率 < 99%，或無法量測 → +1 session。
- **Q4：** 重編 ≤ 0.5% 接受；> 0.5% 遮罩有重編的 symbol×quarter。
- **Q5：** 用 sidecar 補。

| dataset | 進 131 的 feature | 建議 lag | 等級 | 依據 |
|---|---|---|---|---|
| 價格 raw OHLCV | 91 個技術／量能類 | 0 | **R** | E1 100%；E2 0 改變 |
| 還原價 adj_close | 報酬類、label、序列模型 | 0 | **I** | 日報酬 ≤ 2 cell；E7 TimeXer I |
| | | | PatchTST／iTransformer：I（容差待定） | E7 |
| 市值 market_value | `size_log_mktcap` | 0 | **U（待 Wei）** | E2 12.46%／0.064% |
| 三大法人 | 6 個 | 0 | **R** | E1 98.3%；E2 ≤ 0.026% |
| 融資融券 | 4 個 | **1** | **R**（改 lag 後） | E1 0/59 |
| PE／PB／殖利率 | val_ep／bp／dp | 0 | **R** | E1 100%；E2 0.0003% |
| 月營收 | MoM、YoY、val_sp | **+1 session** | **R（不是 V）** | E1／E4 98.94%；E2 0.04–0.06%；晚補約 1% 待定 |
| eps | `l1_eps` | **+1 session** | **R＋遮罩**（Q4 ii） | E2 0.659%（扣 rebase 為 0.613%）> 0.5% |
| roe | `l1_roe` | **+1 session** | **R** | 0.050% ≤ 0.5% |
| revenue_growth_yoy | `l1_revenueGrowthYoY` | **+1 session** | **R** | 0.005% |
| 分點 broker | brokerConcentration、brokerNetAmount5d | 0 | **R** | E1 98.3%（嚴格 96.6%）≥ 95%；E2 0.040% |
| 集保 holding | 無 | — | **N/A** | E5 |
| breadth（advance_ratio） | `advance_ratio` | 0 | **R** | 官方檔有 sha256 封存 |
| US（us_sentiment_score） | `us_sentiment_score` | 0（取前一個 US 日） | **R** | loader 規定嚴格早於 TW 日 |
| 產業／處置／跌停等 snapshot 欄位 | 無（只進 EXCLUDED 6 個） | — | **N/A** | E5 擾動 |
| 宇宙／roster | 全部列 | — | **U → 補 sidecar 後為 R**（Q5 i） | E3 缺 41 檔 |
| label 市場別 | label 分母 | — | **需修 C3** | E3 V5，0.27% |

---

## 3. 需要 Wei 決定或確認的事項

1. **Q4 eps 重編超過門檻。**
   - 數字：14 天累計 0.659%（扣掉 6741、6875 兩檔整段 rebase 後為 0.613%），涉及 42 檔，橫跨 2024-Q3～2026-Q2。
   - 依 Wei 規則應走 (ii) 遮罩。
   - 待確認：
     - 遮罩範圍：只遮 S1013→S1027 期間有改的 symbol×quarter，還是整檔遮罩？
     - 整段乘同一常數的 rebase 算不算「重編」？
   - 注意：這只是 14 天的量；全歷史實際累計的重編率**無法量測**，因為 10-13 以前沒有同一 dataset 的 vintage。
2. **market_value revision（U2）。**
   - 07-01 vintage 相對 F 有 12.46% cell 不同（932 檔、最多約 8 倍）；10-12 以後只有 0.064%。
   - 這不在 Q4（Q4 只講財報）的範圍內，是新問題。
   - 可選：
     - (i) 接受最新值，評 R 並寫進收據；
     - (ii) 把 `size_log_mktcap` 評為 U，改用遮罩或其他來源。
3. **月營收 locked 不是不可變。**
   - locked 值事後改寫 0.04–0.06%，等級只能評 R 不能評 V。
   - 晚申報值被補回舊 key_date 列，約佔每月列的 0.7–1.9%，其中約一半當時已在交易。+1 session 也補不完。
   - 處置選項見 E4 §4：(i) 接受、(ii) 2026-05～06 做 first-seen 遮罩、(iii) 從現在起每日記錄 first-seen。
   - 依 plan HL1-1，#92 要同步改成 `key_date < decision_date`。
4. **E7 容差。** PatchTST、iTransformer 的 score 誤差最大 1.46e-4，超過嚴格門檻 1e-6，但 rank 幾乎不變。請決定容差（例如接受 ≤ 1e-3 × score std），或維持「I 帶容差」的評級。TimeXer 已通過，不需改 normalization。
5. **Q5 確認。**
   - 依 Wei 選的 (i) sidecar，要補 41 檔：40 檔是被 exporter 視窗（下市日 < 2023-06-26）排除的，另 1 檔 4947 不在 core `stocks`。合計 13,425 個 symbol-day。
   - core `stocks` 裡另有 28 檔 `delisted_date` 為 NULL，目前會被當成仍上市，但只用到最後一筆價格，對訓練無害。這部分只需知會，不需決定。
6. **KV holiday 缺 2026-07-10（五）颱風休市。** 這是唯讀發現，本次沒有寫入。要不要補寫 KV 需要 Wei 同意。另建議 T2 lag 測試以 capture calendar 為準，不以 KV 為準。
7. **E6 唯一的非因果 feature。** `l1_volumeMomentumDivergence132710` 只在 warmup 內出錯，影響 R33 訓練列 0 筆。請決定 Phase 1 要不要順手修（改法：一律建立該欄）。這不擋認證。

---

## 4. 限制、未完成與環境備註

- **E1：**
  - 21:00 是用「run 啟動時間」當代理，wall-clock 21:00 當下的狀態無法直接觀測。
  - 7–9 月沒有每日的營收／財報 capture，所以財報公告日覆蓋率無法量測，只能用代理指標。
  - broker 在 10-12 以前，daily lane 只涵蓋 F 的約 90% symbol（F 是之後擴充 universe 回補的）。
- **E2：**
  - eps 只有 10-13 之後的 sealed native 可比；V0603 是不同 dataset。
  - market_value 07 月與 10 月之間的大幅差異，沒有追查到 vendor 的公告來源。
- **E3：** 沒有讀 learning-db 的 R33 dataset_snapshots 起訖日。
- **E5／E6 harness：**
  - broker 用 raw `broker_daily`（單位是 shares）代替 `training_long_full_vintage/broker.parquet`（43.8 MB）。不抓是為了守 GCS 預算；兩者 date key 與 lag 相同。
  - market history 用合成值，但日期是真實 session。
  - 指標用 #78 的 `worker/src/lib/technicalIndicators.ts` 經 Node `stripTypeScriptTypes` 去型別後的 scratch 副本（公式未改），由 #78 的 `training_indicators.cjs` 執行。原因是 repo 沒有 `ml-controller/worker-dist`。
  - D1 snapshot 的 prior 列沒有放進 harness；E5 已證明它們不進 131。
- **E7：** 用的是 r32 cohort，不是未來的 R33 cohort；TimeXer 的 exogenous 輸入是合成的（詳見 JSON）。
- **本機環境：** `ml-service/.venv` 的 pyarrow 26 需要 numpy 2，但 venv 只有 numpy 1.26，導致 neuralforecast import 失敗。處理方式是在 scratch 疊一層 pyarrow 20，venv 本身沒有改動。之後在 Mac 上跑 ml-service 測試前需要修這個 venv。
- **GCS 讀取量：** 約 516 MB（< 1 GB）。
  - ledger 411 MB
  - gcloud CLI 約 19 MB
  - E7 子任務 77.7 MB
  - E3 子任務 8.5 MB
- **下載清理：** 下載檔已刪除，只保留本目錄的 JSON／CSV／MD。
