# StockVision Agent Baseline

本檔是接手 `stockvision-cloudflare-v12` 的跨 session baseline。
新 session 進來時，先讀這份，再讀 handoff docs 與 repo 架構文件。

## User Defaults

- 一律使用繁體中文回覆。
- 先找 root cause，再動手修。
- 不要自作主張做以下動作，除非 Wei 明確批准：
  - `retrain`
  - `deploy`
  - `commit`
  - `push`
  - 任何真實下單相關操作

## Authoritative Docs

先讀這些，再碰 production 路徑：

1. [C:/Users/Wei/Desktop/CloudCode/handoff_docs/01_HANDOFF_2026_04_22.pdf](C:/Users/Wei/Desktop/CloudCode/handoff_docs/01_HANDOFF_2026_04_22.pdf)
2. [C:/Users/Wei/Desktop/CloudCode/handoff_docs/02_SYSTEM_ARCHITECTURE.pdf](C:/Users/Wei/Desktop/CloudCode/handoff_docs/02_SYSTEM_ARCHITECTURE.pdf)
3. [C:/Users/Wei/Desktop/CloudCode/handoff_docs/03_V1_V2_REFACTOR.pdf](C:/Users/Wei/Desktop/CloudCode/handoff_docs/03_V1_V2_REFACTOR.pdf)
4. [C:/Users/Wei/Desktop/CloudCode/handoff_docs/04_OPERATIONS.pdf](C:/Users/Wei/Desktop/CloudCode/handoff_docs/04_OPERATIONS.pdf)
5. [ARCHITECTURE.md](C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/ARCHITECTURE.md)
6. [RISK_FRAMEWORK_ARCHITECTURE.md](C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/RISK_FRAMEWORK_ARCHITECTURE.md)
7. [ML_POOL_ARCHITECTURE.md](C:/Users/Wei/Desktop/CloudCode/stockvision-cloudflare-v12/ML_POOL_ARCHITECTURE.md)

## Runtime Baseline

這台機器已驗證可用的路徑如下。

### Cloudflare

- 不要優先用 repo 內舊版 `wrangler 3` 做 remote D1 驗證。
- 這個環境下，`wrangler 3` 會出現：
  - `whoami` 可用
  - `d1 execute --remote` 在非互動環境失敗
- 改用 `wrangler 4` 可正常工作。

標準用法：

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npx wrangler@4 whoami
npx wrangler@4 d1 execute stockvision-db --remote --command "SELECT 1 AS ok;"
```

已驗證：

- OAuth account: `wayne60619@gmail.com`
- account id: `619a83ac9f20847d9e2f2920823b727d`

### GCP

`gcloud` 可正常使用並能 describe `ml-controller`。

標準用法：

```powershell
gcloud auth list --filter=status:ACTIVE --format="value(account)"
gcloud run services describe ml-controller --region=asia-east1 --format="value(status.url)"
```

### Modal

- 不要用全域 `python` 或系統 PATH 找 `modal`。
- 要用專案 venv 內的 Python。

標準用法：

```powershell
C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe -m modal profile current
C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe -m modal app list
```

已驗證：

- profile: `wayne60619`
- 可列出已部署 apps

## Current High-Signal Caveats

- `predict_stock_v2` 的單股 predict crash 主因已定位在 `allow_missing_target=True` 路徑；後續做 ML review 時要記得這是已知核心修補點。
- `chips` 缺資料時，feature schema 仍可能漂移；看到 `5/46`、`9/106` missing features warning，不要當成單純 log noise。
- `Plan A` paper precision 相關文件把 `Shioaji /snapshots` 當前提，但實際 repo 內 `shioaji-proxy` 是否完整對上文件，必須以 code 為準，不要只信 runbook。

## Session Startup Quick Check

如果要快速確認環境，不用重想，直接先跑：

```powershell
cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\worker
npx wrangler@4 whoami
npx wrangler@4 d1 execute stockvision-db --remote --command "SELECT 1 AS ok;"

cd C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12
gcloud auth list --filter=status:ACTIVE --format="value(account)"
gcloud run services describe ml-controller --region=asia-east1 --format="value(status.url)"

C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe -m modal profile current
C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe -m modal app list
```

## Editing Discipline

- 先讀再改，不要猜架構。
- 看 production / cron / ML / risk 相關邏輯時，優先查最近 commit 與實際 call path。
- 如果 handoff docs、runbook、實際 code 不一致：
  - 以 `repo code + 已驗證 runtime 行為` 為準
  - 再把差異明確指出
