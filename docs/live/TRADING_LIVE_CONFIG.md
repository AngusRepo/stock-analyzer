# KV `trading:live_config`（live-config-v1）

> 依據：plan §4.5、D-5（交易決策數值放 KV，一個概念只有一個 owner key）、Wei 10/29（納入 E-7 manifest，`mode` 是 runtime-owned）。
> 驗證程式：`ml-controller/services/live_config.py`。種子值：`docs/live/trading_live_config_v1.seed.json`。
> 寫入 KV 需要 Wei go。agent 不寫入。

## 1. 欄位與 owner
| 欄位 | 內容 | 誰用 |
|---|---|---|
| `schema_version` | 固定 `live-config-v1` | 全部 |
| `mode` | `paper`／`live`。Worker 鎖讀它；gateway 實送路徑也要求 `live`，否則擋下（`live_config_mode_not_live`） | Worker、gateway |
| `capital_source` | 只接受 `broker_nav_authoritative_marks`（3a：券商現金＋持股市值（權威報價）−未交割） | R21 換算 |
| `session.timezone` | 只接受 `Asia/Taipei` | 全部 |
| `session.continuous_open`／`continuous_close` | `HH:MM`，含兩端。取代原本寫死的 09:00–13:30。假日另由 packet 的 `trading_day_confirmed`（holiday KV）判斷 | contract、shadow |
| `session.deferred_sell_release` | `HH:MM`，必須在 `[open, close)` 之間。DEFERRED 賣單最早的重驗時間（3c） | R21 |
| `freshness.max_packet_age_seconds`／`max_snapshot_age_ms`／`max_broker_truth_age_seconds` | 正整數。實際使用值 ＝ min(KV, env)。env `LIVE_EXECUTION_MAX_*` 只是絕對上限：沒設就用 KV；有設但不是正整數，一律擋下 | contract、shadow、hub 重驗 |
| `pause.enabled` | 布林，預設 `false`（R_PLAN §3） | R21 |
| `pause.daily_loss_pct`／`cumulative_drawdown_pct` | `null`，或 −1 到 0 之間（不含兩端）。`enabled=true` 時兩個都必須有值 | R21 |

- 不接受未知欄位，也不補預設值。KV 缺值或格式錯時，loader 回 `None`，validator 回 `live_config_unavailable`，一律不送單。
- 現金緩衝不在這裡。買進所需現金 ＝ 金額＋整股、零股兩條 leg 各自的 max(leg 金額 × `trading:config.fees.commission`, `fees.minCommission`)，不低於 Worker 的逐 leg 手續費，取代原本寫死的 `1.005`。fees 的 owner 是 `trading:config`；Python 端**沒有**預設值，缺了就擋下（`trading_fees_unavailable`）。

## 2. 給 parent：E-7 manifest 要加的內容（manifest 檔本身先不改）
在 `config/kv/manifest.json` 的 `keys` 加一個 entry：
```json
"trading:live_config": {
  "digest": "<merge/deploy owner 上傳 GCS 後算出的 HMAC digest>",
  "runtime_owned": ["mode"]
}
```
- **受 manifest＋drift 管的欄位**：`schema_version`、`capital_source`、`session.*`、`freshness.*`、`pause.*`。
- **runtime-owned**：只有 `mode`，由 R17 的 pause／resume 和 Wei go 管。依 §4.7 啟用步驟，`mode` 會在 12/9 收盤後從 `paper` 改成 `live`，這是預期的變化，不算 drift。
- schema 檢查：manifest 的 drift task 只比 digest。欄位格式由 `validate_live_config` 負責；上傳前請用它驗過種子檔（指令見 §3）。
- digest 金鑰（KV `kv-config:digest-key`）由 merge/deploy owner 處理，不放進 repo，也不印到 log。

## 3. 寫入步驟（每一步都要 Wei go）
```sh
set -e
# 只驗本機種子檔，不連 KV
cd ml-controller && python -c 'import json; from services.live_config import validate_live_config; print(validate_live_config(json.load(open("../docs/live/trading_live_config_v1.seed.json")))["mode"])'
```
1. Wei go 後，把種子值寫入 KV `trading:live_config`（`mode='paper'`、`pause.enabled=false`）。
2. merge/deploy owner 把同一份值上傳 GCS，更新 manifest 的 digest。
3. 唯讀確認 KV `trading:config` 有 `fees.commission` 和 `fees.minCommission`（見 R19 清單 §2）。
