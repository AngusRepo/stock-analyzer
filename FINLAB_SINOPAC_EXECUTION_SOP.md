# FinLab / Shioaji Execution SOP

## 目的

把 StockVision 的下單、報價、五檔深度評估拆成兩層：

- StockVision：決策、風控、5-slot allocation、kill switch、stale quote policy、審計。
- FinLab / Shioaji：券商登入、即時 tick / bid-ask、部位查詢、委託預覽、送單、改價、刪單、成交回報。

目前 repo 內 `finlab_execution_adapter.py` 仍是 preview-only；任何 real order 都必須另外開 live submit gate，不可由 preview 路徑直接送單。

## 你要去哪裡拿資料

### FinLab

- FinLab API token：到 FinLab 帳號 / API token 頁面取得。
- 用途：資料下載、回測、FinLab online module。
- 不要貼在聊天或文件裡；只放 Secret Manager 或本機暫時環境變數。

### 永豐 / Shioaji

官方文件：

- Shioaji 金鑰與憑證申請：https://sinotrade.github.io/zh/tutor/prepare/token/
- FinLab 下單文件：https://finlab.finance/docs/en/details/order_api/

需要準備：

- `SHIOAJI_API_KEY`：永豐 API 管理頁新增 API Key 後取得。
- `SHIOAJI_SECRET_KEY`：新增 API Key 時取得，只會顯示一次。
- `SHIOAJI_PERSON_ID`：身分證字號，用於 proxy 目前帳號選擇。
- `SHIOAJI_ACCOUNT_ID`：證券帳號。
- `SHIOAJI_CERT_PERSON_ID`：憑證身分證字號，FinLab / Shioaji real order 需要。
- `SHIOAJI_CERT_PATH`：憑證檔路徑；Cloud Run 上線時應改成 secret volume 或安全映像內掛載，不要進 git。
- `SHIOAJI_CERT_PASSWORD`：憑證密碼；通常由永豐憑證流程設定。

API Key 權限建議：

- quote-only 測試：只開行情 / 資料。
- preview / account readback：加帳務。
- real order：最後才加交易與正式環境，且要設 IP 限制。

## Secret rotation SOP

### 原則

- 不把 Cloud Run 現有 plaintext env 當作 rotated key。
- rotate 必須先在永豐 / Shioaji 產生新的 API Key / Secret Key。
- 新值只進 Secret Manager；不要寫進 repo、shell script、markdown、聊天。

### 本機設定新值

在 PowerShell 只存在目前 session：

```powershell
$env:GCP_PROJECT_ID="YOUR_PROJECT_ID"
$env:SHIOAJI_API_KEY="NEW_API_KEY"
$env:SHIOAJI_SECRET_KEY="NEW_SECRET_KEY"
$env:SHIOAJI_PERSON_ID="YOUR_PERSON_ID"
$env:SHIOAJI_ACCOUNT_ID="YOUR_ACCOUNT_ID"
```

### Dry-run

```powershell
.\scripts\shioaji_proxy_secret_refs.ps1 -ProjectId $env:GCP_PROJECT_ID
```

### Apply

```powershell
.\scripts\shioaji_proxy_secret_refs.ps1 -ProjectId $env:GCP_PROJECT_ID -Apply
```

### Emergency stopgap: plaintext env 轉 secret reference

如果 Cloud Run 目前已經有 plaintext env，且新 key 還沒產出，可以先把現有值搬到 Secret Manager reference，降低 `gcloud run services describe` 直接看到密鑰的風險。這不是 rotation；完成後仍要回永豐產生新 API Key / Secret Key 並撤銷舊 key。

```powershell
.\scripts\shioaji_proxy_secret_refs.ps1 `
  -ProjectId $env:GCP_PROJECT_ID `
  -ImportCurrentPlaintextFromService `
  -Apply
```

### 驗證 Cloud Run 不再是 plaintext env

```powershell
gcloud run services describe shioaji-proxy `
  --project=$env:GCP_PROJECT_ID `
  --region=asia-east1 `
  --format="json(spec.template.spec.containers[0].env)"
```

合格條件：

- `SHIOAJI_API_KEY` / `SHIOAJI_SECRET_KEY` / `SHIOAJI_PERSON_ID` / `SHIOAJI_ACCOUNT_ID` 都應該是 `valueFrom.secretKeyRef`。
- 不應看到 plaintext `value`。

### Revoke

確認新 secret refs 可登入、報價 probe 正常後，回永豐 API 管理頁撤銷舊 API Key。

## Read-only verification

## FinLab execution lane secrets

拿到新的 FinLab 專用 Shioaji API key 與永豐憑證後，不要貼聊天。先在本機 PowerShell 設定：

```powershell
$env:GCP_PROJECT_ID="YOUR_PROJECT_ID"
$env:FINLAB_EXECUTION_SHIOAJI_API_KEY="NEW_FINLAB_LANE_API_KEY"
$env:FINLAB_EXECUTION_SHIOAJI_SECRET_KEY="NEW_FINLAB_LANE_SECRET_KEY"
$env:FINLAB_EXECUTION_SHIOAJI_CERT_PERSON_ID="YOUR_PERSON_ID"
$env:FINLAB_EXECUTION_SHIOAJI_CERT_PASSWORD="YOUR_CERT_PASSWORD"
$env:FINLAB_EXECUTION_SHIOAJI_ACCOUNT_ID="YOUR_STOCK_ACCOUNT_ID"
$env:FINLAB_EXECUTION_SHIOAJI_CERT_FILE="C:\secure-path\your-cert.pfx"
```

Dry-run：

```powershell
.\scripts\finlab_execution_secret_refs.ps1 -ProjectId $env:GCP_PROJECT_ID
```

只寫入 Secret Manager，不更新 Cloud Run：

```powershell
.\scripts\finlab_execution_secret_refs.ps1 -ProjectId $env:GCP_PROJECT_ID -Apply
```

從 Secret Manager 執行 read-only live smoke：

```powershell
.\scripts\finlab_execution_live_smoke_from_secrets.ps1 -ProjectId $env:GCP_PROJECT_ID
```

合格條件：

- `status=pass`
- `sinopac_account_login=pass`
- `account_position_readback=pass`
- `noop_view_only_preview=pass`
- `can_submit_real_order=false`
- `preview.uses_create_orders=false`
- `preview.cancel_orders=false`

掛到 `ml-controller` shadow lane：

```powershell
.\scripts\finlab_execution_secret_refs.ps1 `
  -ProjectId $env:GCP_PROJECT_ID `
  -Apply `
  -UpdateCloudRunService
```

Cloud Run 會取得：

- `SHIOAJI_API_KEY`
- `SHIOAJI_SECRET_KEY`
- `SHIOAJI_CERT_PERSON_ID`
- `SHIOAJI_CERT_PASSWORD`
- `SHIOAJI_ACCOUNT_ID`
- `SHIOAJI_CERT_PATH=/secrets/shioaji-finlab-cert.pfx`
- secret volume：`/secrets/shioaji-finlab-cert.pfx`
- `FINLAB_EXECUTION_LANE_ENABLED=shadow`

### 環境檢查

```powershell
.\ml-service\.venv\Scripts\python.exe .\tools\finlab_sinopac_realtime_probe.py --env-check-only
```

### FinLab / Sinopac 即時報價 probe

只在明確允許券商登入時執行：

```powershell
.\ml-service\.venv\Scripts\python.exe .\tools\finlab_sinopac_realtime_probe.py `
  --allow-broker-login `
  --duration-seconds 60 `
  --symbols 6126,6271 `
  --output-dir .\.tmp\finlab-sinopac-probe
```

### 與現行 shioaji-proxy 比對

```powershell
.\ml-service\.venv\Scripts\python.exe .\tools\finlab_sinopac_realtime_probe.py `
  --compare-proxy `
  --proxy-url $env:SHIOAJI_PROXY_URL `
  --proxy-token $env:PROXY_SERVICE_TOKEN `
  --duration-seconds 60 `
  --symbols 6126,6271 `
  --output-dir .\.tmp\proxy-quote-probe
```

## 何時可以把報價 / 五檔交給 FinLab

必須同時滿足：

- tick 與 bid-ask 都有 callback evidence。
- 五檔價量欄位完整：bid price / bid volume / ask price / ask volume。
- 活躍股票在盤中 median quote age 小於 1 秒，p95 小於 3 秒。
- snapshot 不可被當成 execution quote；送單前必須用 tick / bid-ask 或 broker-native latest quote。
- read-only probe 連續觀察一個交易時段沒有 callback 中斷。
- quote stale 時 StockVision 必須 fail closed，不可用舊價追單。

## 何時可以把下單交給 FinLab

先只允許這個順序：

1. `view_only=True` 預覽。
2. StockVision 比對預覽結果：現金、五檔、價格限制、5-slot、swap、處置股、注意股、漲跌停、單筆上限、當日黑名單。
3. manual approval 或獨立 live submit gate。
4. 小資金 live submit。
5. 委託回報、成交回報、撤單、改價全部寫回 StockVision audit trail。

禁止：

- preview pass 直接送單。
- quote stale 時送單。
- 無 order callback / fill callback 時啟用 real order。
- 用聊天或 markdown 傳遞密鑰。

## FinLab vs StockVision 防呆比較

| 面向 | FinLab / Shioaji | StockVision |
| --- | --- | --- |
| 券商登入 / 憑證 | 較完整，直接包 broker API 與憑證流程 | 目前 proxy quote-only，憑證與送單閉環不足 |
| 即時 tick / bid-ask | 較完整，支援 broker-native subscribe callback | 目前已有 streaming cache 修補，但仍要實測穩定度 |
| 委託預覽 | 較完整，`view_only=True` 可預覽 | 已有 preview-only adapter，禁止直接 live submit |
| 改價 / 刪單 | FinLab `OrderExecutor` 文件有 `update_order_price` / `cancel_orders` | 目前 paper / pending-buy 流程尚未完整接 broker 回報 |
| 帳務 / 部位 | FinLab / Shioaji 較貼近券商真實帳戶 | StockVision 有策略部位與 5-slot，但不是券商帳務 source of truth |
| 策略風控 | 只提供一般交易安全建議與 broker-level 檢查 | StockVision 較完整：5-slot、swap、model gate、kill switch、quote stale、audit trail |
| 產品級責任 | broker adapter / execution helper | 決策、資金配置、風控治理、審計 |

結論：FinLab 比我們更適合做 broker adapter；StockVision 仍應保留 final decision / risk owner。最佳閉環是 StockVision 決定能不能買，FinLab / Shioaji 負責報價、五檔、預覽、送單與回報，所有結果回寫 StockVision。
