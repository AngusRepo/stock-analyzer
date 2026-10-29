# R19 Execution Gateway 部署清單

> 依據：`ml-controller/EXECUTION_GATEWAY_RUNTIME.md`、`infra/gcp-runtime-scaling.json`、`infra/gcp-runtime-identities.json`。
> 每一步都由 parent 或 Wei 執行，**每一個 env、IAM、min/max 變更都要先有 Wei go**。agent 不執行任何指令。
> 指令只用來讀取或比對設定；不要把 secret 值印到終端機或 log。

## 0. 三道鎖與對應的開關（全部預設關）

| 鎖 | 位置 | 開關 | 關閉時的行為 |
|---|---|---|---|
| Worker | Worker vars／KV | `LIVE_EXECUTION_CLIENT_ENABLED=0`、`LIVE_EXECUTION_SUBMIT_GUARD_ENABLED=0`、KV `trading:live_config.mode='paper'` | 不觸發 live intake |
| Controller | ml-controller env＋execution D1 | `EXECUTION_GATEWAY_LIVE_RELAY_ENABLED=0`；R17 鏈（migration seed 預設 paused）；`LIVE_TRADING_APPROVAL_SCOPE`／`_EXPIRES_AT`／`LIVE_GATE_RECEIPT_SHA256` | relay 在 IAM 之前就回 blocked |
| Gateway | gateway env＋execution D1 | `FINLAB_LIVE_SUBMIT_ENABLED=0`；同一條 R17 鏈；同樣三個核准值；min instances | 每條 leg 在登入券商前就回 blocked |

controller 和 gateway 都會讀同一條 R17 鏈，所以兩邊都需要 execution D1 的唯讀憑證，還有同一組核准值。缺少任何一項就一律讀成 paused。

## 1. 停用狀態（現在到 Live 啟用前）

- [ ] Cloud Run `stockvision-execution-gateway`（asia-east1）的設定：
  - min instances = **0**，max = **1**，concurrency = 1；
  - CPU always allocated（`cpu_allocation=continuous`），timeout 10s；
  - ingress = internal，**不得**有 `allUsers` invoker。
  ```sh
  set -e
  # 唯讀比對 service 設定
  gcloud run services describe stockvision-execution-gateway --region asia-east1 \
    --format='yaml(spec.template.metadata.annotations,spec.template.spec.containerConcurrency,spec.template.spec.timeoutSeconds,metadata.annotations)'
  gcloud run services get-iam-policy stockvision-execution-gateway --region asia-east1
  ```
- [ ] invoker 只能是 controller 的 service account（`stockvision-ml-controller@…`）。
  - **待決**：`infra/gcp-runtime-identities.json` 的 `service_invokers` 目前另外列了 `pipeline`。這和 RUNTIME 文件寫的「只給 ml-controller」不一致。要移除的話是 IAM 變更，必須先有 Wei go。
- [ ] 下面這些 env 都是 0 或未設：
  - gateway：`FINLAB_LIVE_SUBMIT_ENABLED=0`、`LIVE_EXECUTION_SHADOW_BROKER_READ_ENABLED=0`；
  - controller：`EXECUTION_GATEWAY_LIVE_RELAY_ENABLED=0`。
- [ ] execution D1 已套用 0005–0008（`live_submission_control_v1` 只有 1 筆 `initial_seed` pause）。
  - 0005–0008 目前**還沒有**套用到任何 execution D1（含 staging）。
  - 第一次套用時，表的定義就是 repo 裡的版本（含日期 GLOB、整數金額 CHECK）。
  - 因為用的是 `CREATE TABLE IF NOT EXISTS`，如果先套了舊草稿，之後重套**不會**補上新的 CHECK。所以只能套 repo 現在的版本。

## 2. 啟用前準備（12/1–12/8，每一項都要 go）

- [ ] gateway 和 controller 都加上 `LIVE_GATE_RECEIPT_SHA256`、`LIVE_TRADING_APPROVAL_SCOPE`、`LIVE_TRADING_APPROVAL_EXPIRES_AT`，兩邊的值必須完全相同。
  - expiry 要短，而且必須是帶時區的 ISO 時間。
  - 三個值都是 env／Secret（D-5），改值就要重新部署。
- [ ] gateway 和 controller 都掛上 execution D1 憑證。
  - 驗證方式：呼叫 gateway 的 `GET /v1/control/submission-state`（需要 service token，只讀，不登入券商）。應回傳：
    - `status=live_submission_paused`
    - `durable_pause=true`
    - `approval_values_present` 三項都是 true
    - `finlab_live_submit_enabled=false`
- [ ] KV `trading:live_config` 已寫入，值和 `docs/live/trading_live_config_v1.seed.json` 相同（`mode='paper'`）。欄位說明見 `docs/live/TRADING_LIVE_CONFIG.md`。
  - KV 缺這個 key 或格式錯時，gateway 會一律擋下（`live_config_unavailable`）。
  - env `LIVE_EXECUTION_MAX_*` 只當上限用。要設的話必須是正整數，否則同樣會擋下。
- [ ] 唯讀確認 KV `trading:config` 有 `fees.commission` 和 `fees.minCommission`。
  - Worker 會用程式預設值補齊 fees，但 controller／gateway 不會，缺任何一個欄位，買單一律擋下（`trading_fees_unavailable`）。
  - 確認時只看這兩個欄位，不要把整份 config 印出來。
  - 缺欄位時要先有 Wei go 才能寫入，寫入後再由 merge/deploy owner 更新 E-7 manifest。
- [ ] （選用）`LIVE_EXECUTION_CONTROL_READ_TIMEOUT_SECONDS`：預設 1.0 秒，程式會限制在 0.25–2 秒之間。
  - 原因：每條 leg 讀 R17 鏈的時間，必須落在 relay 的 POST 預算（`EXECUTION_GATEWAY_LIVE_TIMEOUT_SECONDS`，3.5–4.5 秒）之內。
  - 讀取逾時一律視為鎖住。
- [ ] T9（R17 實地演練）：gateway 維持 `FINLAB_LIVE_SUBMIT_ENABLED=0`，在 prod 執行一次 resume，再執行 pause。
  - 確認委託數 = 0，`submission-state` 前後變化是 paused → open → paused。
  - 收據 sha 放進 R4-gate evidence 的 `live_tests.T9`。

## 3. 啟用（12/9 收盤後，plan §4.7；依序執行，每一步都要 go）

1. gateway：先把 min instances 改成 **1**（max 維持 1），等 `/health` 正常後，再設 `FINLAB_LIVE_SUBMIT_ENABLED=1`。
2. controller：設 `EXECUTION_GATEWAY_LIVE_RELAY_ENABLED=1`。
3. Worker：部署 vars `LIVE_EXECUTION_CLIENT_ENABLED=1`、`LIVE_EXECUTION_SUBMIT_GUARD_ENABLED=1`。
4. KV：`trading:live_config.mode` 改成 `'live'`。
5. R17 resume：在 Pages 或 `POST /api/admin/execution/resume` 執行，帶入 scope、expiry 和 R4-gate 收據 sha，三者都必須等於部署值。

## 4. 退回與回滾

- **退回紙上**（D-7，不需要 go）：Pages 按一次「停止 Live 新委託，退回 Paper」，或 `POST /api/admin/execution/return-to-paper`。
  - 新的買單和賣單都會停止，已送出的委託照常對帳。
  - 確認畫面顯示「已停止」（durable pause）。
- **完全回滾**（每一步都要 go）：
  - KV mode 改回 `'paper'`；
  - controller 的 relay flag 設 0；
  - gateway 的 `FINLAB_LIVE_SUBMIT_ENABLED=0`；
  - 確認沒有未對帳的 leg 之後，gateway 的 min 才改回 0。
- 核准過期或 env 被拿掉時，系統會讀成「暫時關閉」，但這不算 durable pause。env 一恢復，系統就會重新開放。所以要停止就必須按 pause。
