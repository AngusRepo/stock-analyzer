# Live 帳本操作規定（R18／NEW-H1g）

> 對象：Wei。依據：`ml-controller/services/live_ledger.py`、migration `0007_live_ledger.sql`（Wei 10/29 核准規則）。
> 實盤帳本和 Paper 帳本完全分開。實盤報酬用「扣掉出入金後」的 return index 計算，所以出入金一定要照下面的規定記錄。

## 1. 出入金一定要在當天的 snapshot 之前記錄
- 每個交易日收盤後，系統寫一筆 `live_daily_snapshots_v1`（當天的 NAV 和 return）。寫入後，那一天就**關帳**。
- 出入金（`live_cash_flows_v1`）要記在**入帳日（flow_date）當天收盤後、snapshot 寫入之前**。
- 已經關帳的日期不能補記。系統會拒絕，錯誤是 `live_cash_flow_date_already_closed`。
  - 原因：那一天的報酬已經固定，補進去的金額不會進任何一天的 return index，報酬就會被高估或低估。
- 週末或假日入帳的金額，也記在實際的入帳日，算進下一個 snapshot。snapshot 會加總「上一個 snapshot 日之後、到這一天為止」的所有出入金。

## 2. 每筆出入金的欄位
| 欄位 | 規定 |
|---|---|
| `flow_id` | 自己取的唯一編號，最長 128 字。同一個編號重送，內容一樣就是同一筆（冪等）；內容不一樣會被拒絕（`live_cash_flow_conflict`）。 |
| `flow_date` | `YYYY-MM-DD`，券商實際入帳日。 |
| `kind`／`amount` | 入金是 `deposit`、正數；出金是 `withdrawal`、負數。單位是新台幣**整數元**，不可以是 0 或有小數。 |
| `source` | `wei_manual` 或 `broker_statement`。 |
| `evidence_sha256` | 對帳單或轉帳憑證檔案的 sha256（64 位 hex）。原始檔自己保存，不放進 repo。 |

## 3. 記錯或漏記
- 已經寫入的出入金和 snapshot 都**不能改、不能刪**（append-only）。
- 當天還沒關帳就發現記錯：不要再送一筆同 `flow_id` 的不同內容，先停下來回報，由 parent 判斷。
- 已關帳的日期漏記：系統不會接受補記。先按 pause（D-7）停止 Live 新委託，再回報 parent。這需要 Wei 決定怎麼處理，可能要開新的帳本 scope。

## 4. snapshot 被拒絕的情況
snapshot 寫入時會檢查下面幾件事，任何一件不成立就不寫入：
- 這段期間出入金的加總，等於 snapshot 記的 `net_external_flow`；不一致時回 `live_snapshot_flow_changed`。
- 沒有比它更晚的 snapshot；有的話回 `live_snapshot_out_of_order`。
- 它指向的上一筆 snapshot 的 sha 和帳本裡的一致；不一致時回 `live_snapshot_previous_mismatch`。

出現上面任何一個錯誤時，不要重送，也不要手動改 D1。請回報 parent。

## 5. 目前狀態
- migration 0005–0008 還**沒有**套用到任何 execution D1。
- 記錄出入金的操作入口和每日 snapshot 的排程，隨 Live-2 交付。上線之前，本規定只是預先登記。
