# T8 Shioaji simulation runbook

> 執行者：**Wei 本人**，用自己的憑證，在自己的電腦上跑。parent 和 agent 都不碰憑證，也不代跑。
> 時間：11/23（一）–12/4（五）之間的交易日（plan §4.6、§5），每一次執行都要另外 go。
> 結果：一張 `t8_receipt.json`，它的 `receipt_sha256` 填進 R4-gate evidence 的 `live_tests.T8.wei_receipt_sha256`（M12 G6）。

## 1. 這次測什麼
T8 用永豐的模擬環境，跑實盤 gateway 實際會走的券商路徑。fake broker 測不到的部分在這裡驗：
- `finlab` 的 `SinopacAccount` 登入（`fetch_contract=False`）、`activate_ca`，以及 realtime callback 連線。
- 合約表：登入後是空表，gateway 會自己下載一次（`fetch_contracts(contract_download=True)`），然後讀 TSE 和 OTC 各一檔的參考價、漲跌停（broker truth）。
- 持股估值用的 snapshot（marks）。
- 實盤帳戶觀測：`account_balance`、`list_positions`、`settlements`。模擬環境不一定都支援，不支援就照實記成 fail。
- 送單（要帶 `--orders`）：TSE、OTC 各一筆整股、一筆零股，都用跌停價買進，掛著不成交，最後全部刪單。
- 成交（要帶 `--orders --fill-test`，可選）：TSE 一筆零股，用漲停價買進，模擬成交。`--fill-test` 不能單獨用。
- 最後用 `update_status` 對帳，再由 `evidence` 步驟檢查 callback 和對帳事件真的寫進 repository，並檢查 gateway health。

## 2. 安全設計（harness：`tools/live/t8_sim_harness.py`）
- 這個 process 裡建立的每一個 Shioaji client 都強制 `simulation=True`：`shioaji` 和 `shioaji._core` 底下的 `Shioaji`、`ShioajiAsync` 都包起來，而且在 import `finlab` 之前就包好。程式沒有關掉它的選項；傳 `simulation=False` 或位置參數會直接中止。
- `connect` 之後會確認 gateway 實際用的 client 是包裝過的模擬 client；不是的話整次執行中止（`SimulationOnly`），不會送單。
- 執行前會從環境移除這些前綴開頭的所有變數：`CF_`、`CLOUDFLARE_`、`MULTI_D1_`、`EXECUTION_GATEWAY_`、`GOOGLE_`、`GCP_`、`GCLOUD_`、`SJ_ADMIN_`。不讀寫 D1、KV、GCS。
- gateway 的 repository 和帳戶觀測都寫到 `--out-dir` 裡的本機 SQLite（`t8_local.sqlite3`）。R17 送單鏈用本機 stub，永遠是開；正式的 R17 鏈由 T9 驗。
- 收據只記：步驟結果、版本、git HEAD、`code_dirty`（4 個相關程式檔有沒有未 commit 的修改）、這 4 個檔案各自的 sha256、事件數量，以及原因代碼。原因代碼必須是 `小寫_小寫` 形式（可帶 `:型別名`），而且不含任何憑證值；不符合就記成 `null`。不記憑證、帳號、原始券商 payload，也不記錯誤訊息全文。
- `t8_local.sqlite3` 會存原始 callback payload，可能含帳號。不要分享；Wei 看完自己決定要不要刪。
- Shioaji 會在目前目錄寫 `shioaji.log`，並在 `~/.shioaji/` 留 token 快取。兩者都可能含敏感資訊：執行時先 `cd` 到輸出目錄，讓 log 留在那裡；兩者都不要分享。

## 3. 準備（一次）
```sh
set -e
# 1. 取得要測的版本（Live-2 release SHA，parent 會給）
cd /Volumes/FireCuda/CloudCode/wt-live
git rev-parse HEAD
# 2. 獨立 venv，版本和 gateway image 相同（shioaji 1.7.7、finlab 2.0.15）
python3.12 -m venv /Volumes/FireCuda/CloudCode/.venv-t8
/Volumes/FireCuda/CloudCode/.venv-t8/bin/pip install -q -r ml-controller/requirements-execution-gateway.txt pytest
# 3. 先跑 fake broker 測試，確認 harness 本身正常（不連線）
cd ml-controller && PYTHONPATH=.:tests /Volumes/FireCuda/CloudCode/.venv-t8/bin/python -m pytest -q tests/test_t8_sim_harness.py
```

## 4. 每次執行
憑證只放在 Wei 自己的 shell，不要貼到任何對話，也不要 `echo`。需要的變數：`SHIOAJI_API_KEY`、`SHIOAJI_SECRET_KEY`、`SHIOAJI_CERT_PERSON_ID`、`SHIOAJI_CERT_PASSWORD`、`SHIOAJI_CERT_PATH`、`SHIOAJI_ACCOUNT_ID`。缺哪個，harness 只會印出變數名稱。

模擬環境的開放時段以永豐 Shioaji 官方文件為準。login 失敗時，先確認是不是在開放時段內。

先把下面存成 `/Volumes/FireCuda/CloudCode/t8-runs/t8.sh`（不要直接貼進互動式 shell：`set -e` 遇到 exit 1 會把整個 shell 關掉）。憑證先在自己的 shell 載入並 export（例如 `set -a; source <自己的私密檔>; set +a`，不要印出），再執行 `zsh /Volumes/FireCuda/CloudCode/t8-runs/t8.sh`。

```sh
#!/bin/zsh
# T8：依序跑 3 段 simulation；任一段 overall=fail 就停
set -e
H=/Volumes/FireCuda/CloudCode/wt-live/tools/live/t8_sim_harness.py
OUT=/Volumes/FireCuda/CloudCode/t8-runs/$(date +%Y%m%d-%H%M%S)
PY=/Volumes/FireCuda/CloudCode/.venv-t8/bin/python

# 第 1 段：只讀（登入、合約、broker truth、marks、帳戶觀測、對帳），不送單
mkdir -p "$OUT-read" && cd "$OUT-read"     # shioaji.log 會寫在目前目錄
$PY "$H" --out-dir "$OUT-read" --tse 2330 --otc 6488

# 第 2 段：模擬送單（跌停價掛單，最後全部刪單）
mkdir -p "$OUT-orders" && cd "$OUT-orders"
$PY "$H" --out-dir "$OUT-orders" --tse 2330 --otc 6488 --orders

# 第 3 段（可選）：模擬成交一股零股
mkdir -p "$OUT-fill" && cd "$OUT-fill"
$PY "$H" --out-dir "$OUT-fill" --tse 2330 --otc 6488 --orders --fill-test
```
- `set -e` 下，收據 `overall` 是 fail 時 exit code 為 1，後面幾段就不會跑。這是刻意的：先處理前一段的失敗。
- 每次執行都要用新的輸出目錄。`--out-dir` 裡已經有 `t8_local.sqlite3` 時，harness 在連線前就拒絕，避免把上一次的事件算進這一次。重跑就重新執行整個 `t8.sh`（`OUT` 精確到秒）。
- 標的可以換，但 `--tse` 必須是上市股、`--otc` 必須是上櫃股；broker truth 對不上交易所會 fail。
- `--callback-wait`（預設 5 秒）是送單和刪單後，等 callback 的秒數。
- `--fill-test` 沒有 `--orders` 時，harness 在連線前就拒絕（exit code 2）。

## 5. 判讀收據
`t8_receipt.json` 的 `overall` 是 pass 才算 T8 通過，而且 3 段裡至少第 1、2 段要 pass。要逐項看：

| 步驟 | 通過條件 | 失敗時常見原因 |
|---|---|---|
| `connect` | gateway healthy，而且 client 是模擬 client | login 簽章（1.7.x 是否接受 `fetch_contract`）、`activate_ca`、realtime 連線、登入時對帳發現認不得的 lot type。**connect 失敗就停，後面步驟都不跑，也不會重試登入** |
| `broker_truth:TSE`／`OTC` | 交易所對、`reference_price`、漲跌停都有（`contracts_refreshed` 只是記錄，不是通過條件） | 合約下載逾時（10 秒）、`update_date` 不是今天、帳號不符 |
| `marks` | 兩檔都有當天價格（當天沒成交時是合約表參考價，`source=contract_reference`） | snapshot 逾時（3 秒）；當天沒成交而且合約表不是今天的、或 `trading_suspended` |
| `account_observation` | 有 `sha256` | 模擬環境不支援 `account_balance` 或 `settlements` |
| `resting_buy:*` | 4 筆都拿到 order id | 零股或上櫃在模擬環境不收、價格不在檔位上 |
| `marketable_odd_buy` | 拿到 order id | 同上 |
| `reconcile`／`reconcile_after_cancel` | 步驟不報錯；第一次 `reconcile` 的 `trade_count` 不少於送單數（模擬帳戶裡若有別的委託，可以多於） | `update_status` 失敗 |
| `cancel_open_orders` | `cancelled` 等於還掛著的筆數 | 刪單 API 不同 |
| `evidence` | 沒有 `problems` | 見下表 |
| `health` | healthy | callback 寫入失敗、lot type 認不得 |

`evidence` 讀本機 repository 的事件數（`broker_events`），有缺就 fail，所以 callback 沒進來時 `overall` 不會是 pass：

| `problems` 代碼 | 意思 |
|---|---|
| `order_callback_missing` | 有送單，但至少一筆送出的單沒有自己的 `ORDER_CALLBACK`（用 broker order id 或 client tag 對應） |
| `status_reconciliation_missing` | 有送單，但對帳沒寫出任何 `STATUS_RECONCILIATION` |
| `reconcile_trade_count_short` | 第一次對帳看到的委託數少於送出的筆數 |
| `cancel_count_mismatch` | 刪掉的筆數不等於還掛著的筆數（例如跌停單在模擬環境意外成交） |
| `deal_callback_missing` | 有 `--fill-test` 的成交單，但這筆單沒有自己的 `DEAL_CALLBACK` |

## 6. 結果怎麼交
- **通過**：Wei 把第 2 段（有 `--fill-test` 就用第 3 段）收據的 `receipt_sha256` 記進 DECISIONS，parent 再填進 R4-gate evidence 的 manual 檔 `live_tests.T8.wei_receipt_sha256`。
- **沒通過**：把收據的 `steps`（只有步驟名、`error` 型別、`reason` 代碼）交給 parent。修正放進 Live-3（11/28 週六班的預留），修完重跑 T8。
- 收據可以直接交給 parent，裡面沒有憑證和帳號；`t8_local.sqlite3` 不要交。
