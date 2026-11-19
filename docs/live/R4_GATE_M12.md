# M12 R4-gate 條件（審核版 v1-rc，11/18）

> 狀態：審核版。**Paper 第 1 天之前由 Wei 核准並凍結**（D-9）。K20 R33 cutover 延到 11/19（四）盤後，Paper 第 1 天＝11/20（五），所以核准期限是 11/20（五）開盤前。凍結做法：
> 1. policy 的 `status` 改成 `frozen`；`calendar.official_closures` 填入 TWSE 公告、涵蓋 gate 期間的休市日。
> 2. 用 `python -c 'import json,sys; sys.path.insert(0,"tools/live"); import r4_gate_check as g; print(g.sha256_of(json.load(open("docs/live/r4_gate_policy_v1.json"))))'` 算出 canonical sha。
> 3. 把這個 sha 寫進 `docs/live/r4_gate_policy_v1.approved_sha256`，和 policy 放在同一個 commit；sha 同時記進 DECISIONS。這一步由 parent 在 Wei 核准凍結時做。
>
> 腳本一定要帶 `--expected-policy-sha256`（DECISIONS 裡的值），沒帶就不跑。核准檔只從 repo 讀，不能用命令列換成別的檔案。核准檔不存在、policy 還是草稿、命令列的 sha 和核准檔不同，或 policy 的 sha 和核准檔不同，一律 FAIL。Wei 審收據時，還要再把收據的 `policy_sha256` 和 DECISIONS 的值逐字比對一次。
> 凍結之後不得回頭改。要改就開 v2，寫明理由，並從 v2 核准日重新計數。

## 1. 用途
- R4-gate 是 Live 啟用（plan §4.7）前的最後一道資料閘門。
- 檢查腳本 `tools/live/r4_gate_check.py` 只讀兩個本機 JSON：凍結的 policy 和 evidence bundle。
  - 它產出 `live_gate_receipt`，`receipt_sha256` 是收據本體 canonical JSON（sort_keys、`(",", ":")`）的 sha256。
  - 腳本不連網路，不讀寫 D1、KV、GCS，也不碰券商。
- R17 resume（D-8）必須帶這個 `receipt_sha256`，而且它要等於部署值 `LIVE_GATE_RECEIPT_SHA256`。
- 只要缺資料、格式不對、出現 NaN／Infinity 或重複 JSON key，或 `as_of` 不是收據產生時（台灣時間）當天以前最新的交易日，一律 FAIL，也就是 fail-closed。每個 gate 的例外都收成該 gate 的 FAIL，照樣產出收據。
- exit code 只在七項全部 PASS 時為 0。

## 2. 判準（G1–G7）

| Gate | 條件 | 失敗時 |
|---|---|---|
| G1 identity 連續 | 從 `as_of` 往回數交易日。交易日曆由腳本自己推導：`calendar_start` 到 `as_of` 的平日，扣掉兩種休市日。一是凍結在 policy 的 TWSE 公告休市日；二是 evidence 補的臨時休市（例如颱風），每一天都要有 `wei_confirmed=true` 和原因，否則 FAIL。收據會分開列出這兩種。這樣可以防止 collector 把缺 Paper 的日子改標成休市。每天都要有 Paper 紀錄，identity（`grant_key`、`execution_owner_version`、`l3_identity`、`allocator_identity`）相同。連續段的第一天必須等於 **K20 R33 cutover 之後的 identity**（11/19（四）盤後 G14 讀回後，由 parent 填進 manual 的 `slice_a_identity`；欄位名稱沿用，不改程式）。推論：cutover 會換 `l3_identity`／`allocator_identity`（R33 四模型 roster＋isotonic，以 11/20 第一天讀回為準），所以 cutover 之前的 Paper 日不計入。中途如果 identity 改變，必須有 Wei 確認過的 D-12 重播收據（from／to identity sha 加收據 sha），否則從改變那天重新計數。需要 ≥20 個交易日。 | FAIL，列出實際天數 |
| G2 工程健康 | G1 連續段內每一天，這 5 個計數都要是 0：08:45 後才出現的 pending buys、NAV 報價日期不符、`paper_execution_scope` 違規、evening chain 沒跑完、T3 帳本交叉寫入。欄位缺失也算 FAIL。 | FAIL，列出每一筆違規 |
| G3 訊號方向 | 在 L2 池算日內去均值的 5 日超額；z 分段邊界用封存的校準 blocks（訊號強度條件化，不做 top-k 截斷）。只算 5 日報酬已實現的訊號日，需要 ≥ 20 − 5 = 15 天。訊號日是否已實現由腳本依交易日曆推導（之後到 `as_of` 至少有 horizon 個交易日），不採信 evidence 的旗標。每個尾端（z≥1.5、z≥2）：有名單的天數也要 ≥15。window 剛好 20 天時，等於這 15 天每天都要有該尾端的名單，只要缺一天就會 FAIL。**z≥2 尾端的嚴格度（Wei 11/18 選 B）**：z≥1.5 維持「有名單的天數 ≥ 15」；z≥2 改成「有名單的天數 ≥ 10」，同號與 CI 重疊條件不變。寫進 policy `signal.tail_min_days_with_names`；OOS 日均值的符號必須和 OOF 點估計相同；OOS 95% CI 和 OOF CI 有重疊；OOS 日均值和 HAC CI 減一次來回成本（2 × `commission` + `tax`）後的值照算照報，**只列報告，不當 gate**（Wei 10/29）；扣成本後的 gate 由 G4 在組合層級負責。CI 用 HAC Newey-West（Bartlett），lag ＝ horizon − 1 ＝ 4，這個值由 target 定義推出，不是調出來的。CI 跨 0 時要照實標示。全段 Spearman 照實報告。HMM 各狀態分開列，只做描述，不當 gate；regime 只用 ml-service HMM。 | FAIL |
| G4 扣成本淨超額 | 主要指標：每日淨超額 ＝ 毛超額 − 單邊換手 × (2 × `commission` + `tax`)。費率取自 `trading:config.fees`，不另設常數；實際值以收據的 `cost_per_one_way_turnover` 為準。費率和換手都必須 ≥0。這個公式沒有計入 `minCommission`（NT$20）和當沖稅，小額或零股的成本會被低估。點估計 > 0 才算通過（0 是語意門檻），HAC CI 照實列出；lag 沿用 horizon − 1，因為部位約持有 horizon 天，日報酬會重疊。Paper 帳戶報酬（含成本、修正未交割）有資料就一併列點估計和 CI，只報告，不當 gate。 | FAIL |
| G5 配置器 | R13 重播和 NEW-L08 的結論都要有 Wei 的定案紀錄：`decided_by=wei`、收據引用、定案日 ≤ `as_of`。 | FAIL |
| G6 Live 測試 | 在 release SHA 上 T1–T7 全部 pass。T8 有 Wei 自己跑 Shioaji simulation 的收據 sha。T9 有 prod R17 切換再切回的收據，當時 gateway 送單開關 = 0、委託 = 0 筆。 | FAIL |
| G7 設定 | `trading:live_config.mode` 仍是 `'paper'`；`pause` 欄位存在且 `enabled=false`（R_PLAN §3）；`capital_source='broker_nav_authoritative_marks'`（見 §3）；有一筆驗證過的實盤帳戶觀測（R18）；NEW-37 §5 的落差帶寬已另外算成產物，收據帶它的 sha（`slippage_band.artifact_sha256`）。 | FAIL |

G1 的 20 日、G3 的 z 尾端和 horizon、CI 水準都寫在 `r4_gate_policy_v1.json`，凍結後收據會帶 `policy_sha256`。這些是閘門參數，不是交易決策常數。

## 3. 已定案的設計（Wei 10/29）
- **L0 seam 用 B（pull）**。
  - native 只多 `dataDomainRegistry.ts` 的 5 列 execution owner，設 `route_ready:false`，搭 Slice A 那班新 grant。
  - 實盤 intake 由非 native 的 cron 呼叫端觸發。controller 用 `paper_orders` 的 cursor 只讀 Paper 已 commit 的委託意圖。
  - cron 呼叫端的改動要等 W-REL merge 後才做。
- **實盤資金（3a）**：券商現金＋持股市值（當下權威報價）−未交割。KV 值是 `capital_source='broker_nav_authoritative_marks'`，取代 plan 原本的 `broker_available_cash`。
- **Paper 端分母（3b，只用在買單）**：Paper 下單當下的 `portfolioValue`，不讀 Paper 的 NAV 表。
  - 來源用方案 A：Paper 在買進寫入點另寫 `paper_order_sizing_v1(order_id, portfolio_value)`（native，搭 Slice A，寫失敗不擋 Paper）。
  - 接上之前，買單一律 BLOCKED（`paper_denominator_unavailable`）。
  - 這列還讀不到時，最多等到該筆買單當日的 `session.continuous_close`（Wei 10/30 A 案），之後 BLOCKED 並告警。細節見 `LIVE_PROTOCOL_NEW37.md` §2。
- **13:30 後才產生的 Paper 出場（3c）**：
  - 記成待送賣單（`live_intake_orders_v1.status='DEFERRED'`），下一交易日 09:00 後用新報價重驗再送。
  - 每筆都可以對帳。還沒送出就 pause 時，照 D-7 不送。
- **賣單換算（3e，10/29 晚修正）**：實盤股數 ＝ min(floor(Paper 賣出股數 ÷ Paper 賣出前持股 × 實盤持股), 實盤持股)；Paper 清倉時實盤全部賣出。Paper 賣出前持股只從 `paper_orders` 推得，不讀 `paper_positions`；賣單不用分母。
- **(d)**：新路徑不經過 Worker `submitSignedLiveExecutionPacket` 的 `paper_admission` 規則；D-6 已經取代它。那個函式不改，NEW-37 文件會寫明這件事。
- **G3 的成本條件**：z 尾端扣掉一次來回成本後的均值和 HAC CI 只列報告，不當 gate。扣成本後的 gate 是 G4。
- **凍結方式**：見本檔開頭。腳本必須帶 `--expected-policy-sha256`，草稿一律 FAIL。

## 4. Evidence bundle（`r4-gate-evidence-v1`）
由唯讀查詢產生。收集器在 Live-2 交付，只用讀權限。

| 欄位 | 來源 |
|---|---|
| `as_of`、`calendar_start`、`ad_hoc_closures` | `as_of` 必須是收據產生時（台灣時間）當天以前最新的交易日；臨時休市取自 holiday KV `holiday:YYYY-MM-DD`，而且每天都要有 Wei 確認 |
| `slice_a_identity`、`paper_days[].identity` | Slice A release 收據；每日 native grant／execution owner／L3／allocator identity |
| `paper_days[].health` | paper_execution_events、evening chain 稽核、NAV 報價檢查、T3 掃描 |
| `d12_replay_receipts` | Wei 確認的 D-12 重播收據 |
| `signal.oos_days`、`signal.oof` | L2 池 5 日超額（日內去均值）、封存的 OOF 校準 blocks 與 CI |
| `trading_config_fees` | KV `trading:config.fees` |
| `net_excess_days` | Paper 每日毛超額、單邊換手（買賣成交額合計，≥0）、Paper 帳戶日報酬（選填，只報告） |
| `allocator_decisions` | DECISIONS 檔的 R13／NEW-L08 定案紀錄 |
| `live_tests` | CI 跑 T1–T7 的結果（release SHA）、Wei 的 T8 收據、T9 收據 |
| `live_config` | KV `trading:live_config` |
| `account_observation` | `live_account_observations_v1` 最新一筆 |
| `slippage_band` | 用 20 日 `paper_broker_reconciliation` expected_slippage 分布算出的帶寬產物 sha |
| `d12_replay_receipts` | 沒有也要給空陣列 |

### 4.1 Collector（`tools/live/r4_gate_collect.py`）
- 只讀：D1 走 `shadow_client_for_domain`（只允許 SELECT），KV 只用 strict GET；唯一的寫入是本機 evidence 檔。不連券商、不讀寫 GCS。
- 自動取得：
  - 交易日曆與 `as_of`：policy 的公告休市日＋逐日讀 holiday KV。KV 有、policy 沒有的休市日一律列入 `ad_hoc_closures`；manual 沒有 Wei 確認（JSON `true`＋原因）就標 `wei_confirmed=false`，G1 會 FAIL。
  - `paper_days[].identity` 的 `l3_identity`＝前一交易日 activated L4 plan 的 `payload.l3_identity` canonical sha256，`allocator_identity`＝該 plan 的 `policy_identity`。當天沒有、或有兩種以上 plan identity，整天不列（G1 連續段在此中斷）。
  - `paper_days[].health`：`pending_buys_after_0845`（非 superseded run 中台灣 08:45 後建立的 item）、`nav_quote_date_mismatch`（沒有 verified `dated_marks_complete` 估值、`pending_valuation`、持股沒有 mark、mark 的 `price_date` 不是當天、報價時間的台灣日期不是當天或無法解析；沒有時區的報價時間視為台灣時間，與 Worker 一致）、`paper_execution_scope_violation`（代理值：當天 stage／ticket 的 `last_error` 含 scope 相關字樣）、`evening_chain_incomplete`（當天最新的 evening-chain root ticket 不是 success）。
  - `net_excess_days`：單邊換手＝當天（台灣日期）Paper 成交額 ÷ 前一交易日 NAV；Paper 帳戶報酬＝NAV 相對前一交易日。
  - `trading_config_fees`（只取 KV `trading:config.fees`，缺就不給，不用 Worker 預設值）、`live_config`、最新一筆 `live_account_observations_v1`（重驗 sha，對不上就中止）。
- 由 manual 檔提供（`--manual`，Wei／parent 填寫並附出處）：`slice_a_identity`、`release_timeline`（每段的 `effective_from`、`grant_key`、`execution_owner_version`、`source_ref`；目前沒有逐日紀錄，來源是 GCS release receipts）、`ad_hoc_closures_confirmed`、`d12_replay_receipts`（沒有就空陣列）、`allocator_decisions`、`live_tests`、`slippage_band`、`net_excess_benchmark`。
- `signal` 由另一份產物提供（`--signal`，要同時有 `oos_days` 和 `oof`）。
- 沒有來源或還沒定義的欄位一律不填，並列在 `collector.gaps`，gate 因此 FAIL。目前固定會出現的 gap：
  - `health_undefined:ledger_cross_write`：T3 交叉寫入的掃描還沒有定義。
  - `net_excess_benchmark_undecided`：毛超額的基準（`benchmark_value`＝0050 或 `twii_value`）待 Wei 決定；決定前不算 `gross_excess`。決定後的算法是 Paper 報酬＋當天實付成本 ÷ 前一交易日 NAV − 基準報酬，也請 Wei 一併確認。
  - `signal_artifact_missing`：z 尾端（z≥1.5／2.0）與「封存校準 blocks 分段」的對應尚未定案，訊號程式在 `sa/native`／`sa/serving`。

## 5. 執行（12/17（四）收盤後，plan §4.7）

推論：以 Paper 第 1 天 11/20（五）起算第 20 個交易日；holiday KV 在 11/20–12/17 沒有休市日（12/25 在窗外）。cutover 若再延，日期跟著順延。
```sh
set -e
# 只讀收集：D1 SELECT 與 KV GET；evidence 寫到本機。
python tools/live/r4_gate_collect.py --calendar-start "2026-11-20"  # K20 cutover 後第 1 個 Paper 交易日；cutover 延期就改 \
  --manual manual.json --signal signal.json --out evidence.json
# 只讀：policy 與 evidence 都是本機檔案；收據寫到本機。
python tools/live/r4_gate_check.py --evidence evidence.json --out live_gate_receipt.json \
  --expected-policy-sha256 "<DECISIONS 記錄的 policy sha>"
```
執行時間：as_of 當天 evening chain 跑完之後、台灣時間午夜之前。evening chain 沒跑完，G2 的 `evening_chain_incomplete` 會讓 gate FAIL；過了午夜到下一個交易日，as_of 就算過期。

臨時休市的 `wei_confirmed` 是 collector 填的，腳本無法驗證。所以 Wei 審收據時，要逐日對照 TWSE 公告或 holiday KV `holiday:YYYY-MM-DD`，核對 G1 的 `ad_hoc_closures_in_window`；任何一天對不上，就不核准這張收據。

G7 的收據會寫入落差帶寬產物的 sha 和實盤帳戶觀測的 sha。收據的 `receipt_sha256` 交給 Wei 審。Wei go 之後，部署為 controller／gateway 的 `LIVE_GATE_RECEIPT_SHA256`，再由 R17 resume 帶入。
