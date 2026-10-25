# R33 monthly lifecycle: deploy, serving parity, readiness

## Deploy settings

- Worker: `R33_MONTHLY_PROFILE = "1"` in `worker/wrangler.toml` [vars]. The Worker deploy has no `keep_vars`, so the value must live in the file. With the flag set, only the monthly OOF lifecycle uses the R33 profile.
- Scheduler: `active8-oof-weekly` is `"desiredState": "PAUSED"` in `infra/gcp-scheduler-jobs.json`, matching the live job.
- Challengers: nothing has to be set. The Modal orchestrator reads `app.challenger_models.LIFECYCLE_SLOTS` (PR #71). Until that module is deployed, R33 runs no challenger; after it is deployed, the `linear_neutral` slot runs automatically. `R33_OOF_CHALLENGER_MODELS` on the controller is an optional override and takes slot names.

## Serving parity (base 201cb5594 vs this branch)

```
python ml-service/scripts/r33_serving_parity.py --base 201cb5594 \
  --manifest gs://stockvision-models/walk_forward/oof_cohorts/<cohort>/manifest.json --json out.json
```

The script is read-only (local CPU, GCS read only for `--manifest`) and runs in two parts.

1. Static. It lists every top-level symbol of `ml-service/app/*.py` and `modal_app.py` that differs from the base. It then intersects that list with an import-resolved `(module, symbol)` call graph, which is the union of the base and branch edges. The graph is rooted at the serving entrypoints:
   - the daily predict functions, `pipeline_prediction_bundle` and `l4_native_prediction`;
   - daily `inference_only` prep and canonical adjusted prep;
   - the frozen forward-extension shadow;
   - the ASGI app.
2. Dynamic. It runs the shared code that is reachable from those roots, once in the base tree and once in the branch tree, in two isolated interpreters with the same frozen inputs:
   - the production rosters, run through `model_order` / `validate_order`;
   - `PROFILES131` membership and the `FEATURES131` hash;
   - `assess_fold_forward_sources` on every window of a production OOF manifest;
   - the `UniversalPrepRequest` defaults.

Result on 2026-10-25 with cohort `active8-oof-r32-plan-a-2026-03-18-2026-09-22-known-2026-10-01`:

- `status: pass`.
- 25 dynamic checks over 7 windows, with no differences. The base and branch output sha256 are both `14af252a…720c6e`.
- The same result holds for the r128 core16 split-r135 cohort.
- Of the 44 changed symbols, 8 are reachable from serving:
  - 7 are covered by the dynamic run: `model_order`, `validate_order`, `R33_MODELS`, `PROFILES131`, `R33_PROFILE`, `assess_fold_forward_sources` and `UniversalPrepRequest`.
  - 1 is proven inert for serving by code: `prep_universal_batch`. Its row slice at `universal_training.py:767-769` runs only when `feature_warmup_rows` is set. The default is 0 (`:87`), and the controller sets it only for R33 training prep (`r33_prep`, `retrain_trigger.py:1470, :2022, :2051`).

Every other changed line is training-only (new-file line numbers):

| File | Lines | Owner (training only) |
|---|---|---|
| `app/gnn_training.py` | 395-396, 452-454 | `train_graphsage_universal` |
| `app/tabm_training.py` | 262-264, 328-329 | `train_tabm_universal` |
| `app/neuralforecast_sequence_runtime.py` | 130, 579, 873-908, 935-959, 1311-1610 | `_resolve_nf_training_options`, `_train_dense_purged_oof`, `_make_nf_model`, `_train_nf`, `train_neuralforecast_sequence_artifact` |
| `app/purged_cv.py` | 342-371 | `purged_explicit_walk_forward_indices` |
| `app/timexer_job.py` | 29-32, 123-161 | `materialize_inputs` / `run` (reached only from `train_timexer_universal`; `timexer_universal_predict` uses `app.timexer_inference`) |
| `app/timexer_training.py` | 38, 110-111, 221-222 | `load_windows`, `train` |
| `app/training_finalizer.py` | 203, 273, 275 | `reduce_tree_model_child_results` |
| `app/training_policy.py` | 675-679, 705-710, 967-968 | `build_group_train_payload`, `build_tree_model_child_payloads`, `UniversalTrainingPolicy` |
| `app/universal_training.py` | 120-121, 187-276, 632, 687, 1008-1108, 1529, 1614-1616 | `UniversalTrainRequest`, `validate_immutable_oof_snapshot_for_registration`, `_save_oos_rank_artifact`, `train_universal_from_gcs` |
| `app/full_fit_scope.py`, `app/timexer_cutoff.py`, `app/oof_challengers.py` | new | imported only by the training owners above |
| `modal_app.py` | 735-964, 2577, 2622, 2658, 2908-2927, 3016-3440, 4012-4054 | `retrain_orchestrator`, `train_tree_models_split_parent`, `train_tree_models`, `train_wf_tree_window`, `_oof_challenger_*`, `walk_forward_orchestrator`, `train_patchtst_universal` |

## Readiness preflight

```
POST {ML_CONTROLLER_URL}/walk_forward/oof/r33-readiness
Authorization: Bearer <controller token>
Content-Type: application/json

{"end_date": "2026-10-30"}
```

`end_date` is optional and defaults to today in Taipei time. The endpoint dispatches no Modal, Cloud Run or prep work and writes no GCS, D1 or KV object. It only reads GCS and runs D1 SELECTs (market and ops).

It returns `{"verdict": "ready" | "not_ready", "blocking_checks", "warnings", "checks": [...]}` with these checks:

| Check | Owner reused | Blocks when |
|---|---|---|
| `profile_roster` | `model_profiles` + `model_order` | the roster is not the 7 R33 models, the profile is outside `PROFILES131`, or the test window is not 21 |
| `sequence_selection` | `ensure_active8_daily_prep(dry_run=True)` → `_r33_sequence_selection` | the freshest vintage has fewer than `_r33_required_price_sessions()` (1532) price sessions; the selection receipt is returned |
| `prep_plan` | `_verified_prep_only_receipt`, `_latest_canonical_prep_prefix` | the sealed source receipt is invalid. Otherwise it reports `reuse_sealed`/`build` and `reuse_latest`/`build` |
| `capture_inventory` | `inspect_capture_inventory(per_field_auxiliary, require_aligned_history)` | the inventory is not ready and a new source prep must be built (only a warning when a sealed prep is reused) |
| `l2_pool` | `r33_calibration_job.load_l2_pool` over the planned 21×7 mature sessions | there is no pool at all. Missing days are a warning, because they silently drop out of calibration |
| `tabpack_closure_skipped` | source of `run_walk_forward_oof_lifecycle` / `r33_monthly_lifecycle` | the R33 branch does not return before native L4/TabPack, P3 or closure, or the R33 owner references them |
| `challenger_slots` | `_r33_challenger_models` | an override name overlaps the release roster |

## Runbook：10/28 trial 與 10/30 full capture（本機 CLI，Wei 執行）

這兩次 run 由 Wei 本人執行。若 Wei 對某一次 run 明確說 go，也可以由 parent session 代跑。每次 run 都要單獨取得 go。

### Run 會做什麼、不會做什麼
- 只做 FinLab SDK 讀取、TWSE/TPEX 官方 GET（`official_json_get`，`tools/finlab_v4_remote_backfill.py:1438-1450`），以及 Yahoo quote GET（`ml-controller/services/training_us_capture.py:33-34`）。
- 只寫兩個地方：
  - GCS capture：`upload_dir_to_gcs` → `tools/finlab_gcs_upload.py:71`，在 `:4063`、`:4121`；
  - official-history cache：`write_cached`，在 `:1375`、`:1405`。
- 不送 Worker callback，也不送 controller callback。tool 裡沒有任何 callback 程式碼；Modal 版的 callback（`ml-service/modal_app.py` `_post_worker_scheduler_callback`）只有 Modal wrapper 會呼叫。
- 不寫 D1：
  - D1 寫入只在帶 `--write-d1`（`:4072`、`:4113`）或 `--apply-canonical-d1`（`:4086`）時發生，兩個 flag 都不要帶。
  - controller D1 proxy 的 POST（`:470`、`:523`）只在 `FINLAB_CONTROLLER_*` 或 `ML_CONTROLLER_*` 環境變數存在時啟用。下面的設定步驟會先把它們清掉。
  - 沒有 D1 credentials 時，唯讀的 D1 步驟（`d1_counts`、source_key_report reuse）會直接 skip，並在 manifest 記一筆 `d1_unavailable`。此時 diff report 的 `stockvision_rows` 是 `null`，不是 0。
- 不帶 `--daily-refresh`，所以不會產生或發布 inference composition（`:4049`、`:4131`）。

### 前置準備（PowerShell）
```powershell
Set-Location C:\Users\Wei\Desktop\CloudCode\sv-w1
git fetch origin; git checkout r33/monthly-lifecycle; git pull --ff-only
gcloud auth application-default login          # GCS read/write 用 ADC
$py = 'C:\Users\Wei\Desktop\CloudCode\stockvision-cloudflare-v12\ml-service\.venv\Scripts\python.exe'
$env:PYTHONUTF8 = '1'
$env:GCS_BUCKET_NAME = 'stockvision-models'
$env:FINLAB_OFFICIAL_HISTORY_CACHE_PREFIX = 'finlab/v4/official-history-cache/v1'
# 不能有 bootstrap ref；也不能有 D1 / controller credentials（確保零 D1、零 controller 呼叫）
'FINLAB_DAILY_HISTORY_BOOTSTRAP_REF','CF_API_TOKEN','CF_ACCOUNT_ID','CF_D1_DB_ID',
'FINLAB_CONTROLLER_TOKEN','ML_CONTROLLER_TOKEN','ML_CONTROLLER_SECRET',
'FINLAB_CONTROLLER_D1_QUERY_URL','ML_CONTROLLER_D1_QUERY_URL',
'FINLAB_CONTROLLER_D1_BATCH_URL','ML_CONTROLLER_D1_BATCH_URL' |
  ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
# FinLab key 只放進這個 process，不要印出來；run 結束後清掉
$env:FINLAB_API_KEY = (gcloud secrets versions access latest --secret=finlab-api-key)
```
- 這個 shell 不能開 transcript（`Start-Transcript`），也不要 `echo $env:FINLAB_API_KEY`。
- 機器需求：建議至少 16 GB 可用 RAM。broker archive 約 111M rows，全部讀進 pandas。run dir 所在磁碟至少留 10 GB。

### 10/28 trial（只在 10/28 跑）
目的有兩個：先把 2020-05-04..2023-10-11 的官方 breadth/calendar 寫進 cache；同時驗證整條 pipeline 和 history 起點。
```powershell
& $py tools\finlab_v4_remote_backfill.py --years 3 --run-id finlab-v4-3y-r33trial-20261028 `
  --gcs-bucket stockvision-models --gcs-prefix finlab/v4/backfill `
  --lanes daily_price,chip_diversity,revenue,fundamental_factor_diversity,training_shareholding,broker_flow_diversity `
  --source-start-date 2020-05-04 --training-capture-start-date 2020-05-04 --source-end-date 2026-10-28
Remove-Item Env:FINLAB_API_KEY
```

### 10/30 full capture（10/30 當天的 FinLab 日資料更新完成後再跑）
```powershell
$env:FINLAB_API_KEY = (gcloud secrets versions access latest --secret=finlab-api-key)
& $py tools\finlab_v4_remote_backfill.py --years 3 --run-id finlab-v4-3y-r33full-20261030 `
  --gcs-bucket stockvision-models --gcs-prefix finlab/v4/backfill `
  --lanes daily_price,chip_diversity,revenue,fundamental_factor_diversity,training_shareholding,broker_flow_diversity `
  --source-start-date 2020-05-04 --training-capture-start-date 2020-05-04 --source-end-date 2026-10-30
Remove-Item Env:FINLAB_API_KEY
```

**參數說明（Why）**
- **兩個起日都設 2020-05-04**：
  - 不帶 `--daily-refresh` 時，aux daily 欄位的起點跟 `--source-start-date` 走；
  - price、institutional、broker 的起點跟 `--training-capture-start-date` 走；
  - tool 規定 `--training-capture-start-date` 不能晚於 `--source-start-date`；
  - inventory 的 aligned-history guard 要求 aux/broker 不能比 price 晚開始。
  - 2020-05-04 到 2026-10-30 大約是 1576 個 sessions，高於 1532。
- **run-id 必須包含 `-3y-`**：controller 的 sequence-refresh 只接受 run-id 含 `-3y-` 或 `-daily-` 的 run（`ml-controller/routers/finlab.py:282-283`）。
- **`--gcs-prefix finlab/v4/backfill`**：capture 會落在 `gs://stockvision-models/finlab/v4/backfill/<run_id>/`，正是 sequence-refresh 讀取的位置（`routers/finlab.py:242-243`、`:320`）。
- **`--years 3`**：只影響 holding 和 canonical broker 的 window。training 不需要這兩者的長歷史。
- **financial 日期 gate（live SDK + `--training-capture-start-date`）**：
  - financial 欄位只檢查 window 內有收盤價的 symbol（price universe）。2013–2018 已下市、window 內沒有價格的 symbol 不進 gate。
  - 舊季度缺日期，但同 symbol 在起日前已有更新季度可用時才 omit（`scope_financial_history` 既有規則）。
  - deadline owner 缺、disclosure 落在起日（含）之後的 cell（例如新上市股 7947 2026-Q2）：值不採用、不推導日期，逐筆記在 `raw/financial_availability/*.json` 的 `request_scope.deadline_owner_absent_cells_withheld`。
  - 其餘缺日期 cell 一律 fail：`financial_request_unresolved_cells:<key>:<n>:<sample>`。不帶 `--training-capture-start-date` 時維持原本全歷史 gate。

### 預估時間、磁碟、輸出位置
- **10/28**：約 100–110 分鐘。其中約 76 分鐘是官方 history 補抓：breadth 約 868 天 × (sleep 4 s + fetch)，calendar 約 82 個月 × (sleep 2 s + fetch)。本機跑沒有 7200 s 上限。
- **10/30**：cache 已經填好，約 30–40 分鐘。
- **磁碟**：run dir 是 `data\finlab_remote_backfill\<run_id>\`（repo 相對路徑）。以 3 年 run 約 365 MB 估算，6.5 年 history 約 1–2 GB。
- **GCS**：`gs://stockvision-models/finlab/v4/backfill/<run_id>/`，裡面有 `manifest.json` 和 `raw/...`。另外 cache 會寫到 `gs://stockvision-models/finlab/v4/official-history-cache/v1/`。

### 驗證是否成功
先把下面這段存成 `$env:TEMP\r33_capture_check.py`（只讀本機 run dir），再執行：
```python
import json, sys
from pathlib import Path
import polars as pl
sys.path.insert(0, "ml-controller")
from services.training_session_calendar import price_session_dates
run = Path(sys.argv[1]); raw = run / "raw"
m = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
print("backfill_status", m["backfill_status"], "| blockers", len(m["source_key_blockers"]),
      "| gcs_upload", bool(m.get("gcs_upload")), "| d1_unavailable", m.get("d1_unavailable"))
def start(path): return pl.read_parquet(path, columns=["date"])["date"].cast(pl.String).min()[:10]
p = raw / "daily_price_full_vintage"
cal = json.loads((p / "training_calendar.json").read_text(encoding="utf-8"))
print("price", start(p / "close.parquet"), "| market_value", start(p / "market_value.parquet"),
      "| calendar", cal["start"], "->", cal["end"], "| sessions", len(price_session_dates((p / "close.parquet").read_bytes())))
print("institutional", start(raw / "chip_diversity_full_vintage" / "foreign_net.parquet"))
aux = json.loads((raw / "training_auxiliary_full_vintage" / "manifest.json").read_text(encoding="utf-8"))
for name, field in sorted(aux["fields"].items()): print("aux", name, field["start_date"], "->", field["end_date"])
for name in ("broker", "holding"):
    receipt = json.loads((raw / "training_long_full_vintage" / f"{name}.json").read_text(encoding="utf-8"))
    print(name, receipt["start"], "->", receipt["end"], "| rows", receipt["rows"])
```
```powershell
& $py "$env:TEMP\r33_capture_check.py" data\finlab_remote_backfill\finlab-v4-3y-r33full-20261030   # 10/28 改 trial run-id
```
**合格條件**
- `backfill_status` 為 `ready`、`blockers` 為 0、`gcs_upload` 為 True。
- `d1_unavailable` 列出 `d1_counts` 是預期中的。
- `sessions` ≥ 1532，`calendar` 的結尾是 2026-10-30（trial 則是 10-28）。
- price、market_value、institutional、broker 的起點都 ≤ 2020-05-04 之後的第一個交易日。
- aux daily 欄位（margin/short、pe/pb/dividend_yield）的起點不晚於 price。eps/roe/revenue* 屬於 persistent 欄位，起點會更早，這是正常的。
- holding 只有約 3 年，是預期中的。

### 10/30 之後：sequence refresh 與 readiness
sequence-refresh 會 dispatch Modal `build_finlab_long_sequence_prep`，需要 Wei 的 go。
```powershell
$ctrl = '<ML_CONTROLLER_URL>'
$headers = @{ Authorization = 'Bearer <controller token>' }
Invoke-RestMethod -Method Post -Uri "$ctrl/finlab/backfill/sequence-refresh" -Headers $headers `
  -ContentType 'application/json' `
  -Body '{"status":"success","run_id":"finlab-v4-3y-r33full-20261030","run_date":"2026-10-30"}'
```
- 輸出位置：`gs://stockvision-models/universal/sequence_long/runs/finlab-v4-3y-r33full-20261030/prep/sequence_manifest.json`。R33 selector 掃描的就是 `universal/sequence_long/runs/`（`ml-controller/services/active8_prep_lifecycle.py:18`）。
- 若回傳 `skipped`，看 `reason`：
  - `not_daily_tail_backfill`：run-id 不含 `-3y-`；
  - `tail_daily_price_adjusted_ohlc_label_contract_missing`：capture 缺 `adj_close`/`adj_open`/manifest。
- sequence 的 manifest 變成 ready 之後，跑唯讀的 readiness 檢查：
  ```powershell
  Invoke-RestMethod -Method Post -Uri "$ctrl/walk_forward/oof/r33-readiness" -Headers $headers `
    -ContentType 'application/json' -Body '{"end_date":"2026-11-01"}'
  ```
  `sequence_selection` 要是 `pass`，且 `selected_price_sessions` ≥ 1532。

### FinLab history 起點晚於 2020-05-04 時
- 不要補資料，也不要降低 1532。
- 用驗證輸出裡的 `sessions` 判斷：
  - **sessions 仍 ≥ 1532**：只要 aux/broker 的起點不晚於 price，就可以照常繼續。
  - **某個 aux daily 欄位或 broker 起點晚於 price**：inventory 會回 `r33_source_history_starts_after_price` 或 `daily_history_starts_after_price_capture`。處理方式：把兩個起日 flag 都改成各來源起點中最晚的那一天，重跑一次。重跑後 sessions 必須仍 ≥ 1532。
  - **sessions < 1532**：R33 selector 會 fail closed（`r33_sequence_history_insufficient`）。這時停下來，把各來源的起點回報 coordinator，由 Wei 決定。
