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
| `pit_certification` | `pit_certification.verify_bound_receipt` (capture binding only; prep is bound by the lifecycle) | the selected capture has no `pit_certification.json`, re-deriving it does not give `point_in_time_vintage_certified=true`, or the capture changed after the receipt (see the PIT runbook below) |

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
  --fundamental-training-fields-only `
  --source-start-date 2020-05-04 --training-capture-start-date 2020-05-04 --source-end-date 2026-10-28
Remove-Item Env:FINLAB_API_KEY
```

### 10/30 full capture（10/30 當天的 FinLab 日資料更新完成後再跑）
```powershell
$env:FINLAB_API_KEY = (gcloud secrets versions access latest --secret=finlab-api-key)
& $py tools\finlab_v4_remote_backfill.py --years 3 --run-id finlab-v4-3y-r33full-20261030 `
  --gcs-bucket stockvision-models --gcs-prefix finlab/v4/backfill `
  --lanes daily_price,chip_diversity,revenue,fundamental_factor_diversity,training_shareholding,broker_flow_diversity `
  --fundamental-training-fields-only `
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
- **`--fundamental-training-fields-only`**：`fundamental_factor_diversity` 只抓 training／serving 實際用到的 6 個欄位（eps、roe、pe、pb、dividend_yield、revenue_growth_yoy）。其餘約 60 個 financial 欄位 training 和 serving 都不讀，不抓也不跑 gate（例如 `營業費用率` 的 vendor ±inf）。其他 5 個 lane 的 key 完全不變（`84551b044` 之前的版本會漏掉其他 lane，trial c 只產出 fundamental，必須重跑）。
- **Fail closed**：training capture（帶 `--training-capture-start-date`）只要有任何一個要求的 lane 沒產出 dataset，就記 `requested_lane_produced_no_dataset` blocker，`backfill_status=partial_failed`，exit 2。
- **revenue required field**：月營收以公布日（約每月 10 日）為 index。training capture 檢查 end date 前 45 天內有公布即可（daily run 仍檢查 end date 當天），避免 `revenue=missing_target_date` 誤報造成 `partial_failed`。
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

## 11/1 月訓：OOF orchestrator 撞到 8 小時上限時
- **上限在哪**：`walk_forward_orchestrator` 的 timeout 是 28800 s（`ml-service/modal_app.py` 的 `@app.function(... timeout=28800)`）。7 個 fold、`concurrent_windows=2`，一共跑 4 波。每個 fold 的時間約等於 TimeXer 的時間，估計 6.4–10.4 h，所以有機會撞到上限。
- **撞到之後會怎樣**（`f155e9d6b` 之後）：
  - Modal 的 probe 會把這個 call 判成 `failed`。
  - controller 把 `walk_forward/oof_cohorts/<cohort>/dispatch.json` 改成 `terminal_failed`（`routers/walk_forward.py`，dispatch 分支）。
  - continuation 都是 `continuation_only`，不會重新 dispatch，只回 `pending`，reason 是 `cohort_manifest_not_ready_for_continuation`，`continuation_limit` 是 12。
  - 跑到這裡時 continuation attempt 大約已經是 18，所以下一次 poll（最多 30 分鐘後）就會丟 `oof_cohort_continuation_exhausted:status=pending:attempt=N`。scheduler ticket 變成 `error`，不會無限循環。
- **要看的訊號**：
  - scheduler ticket `active8-oof-monthly` 的狀態是 `error`，summary 含 `oof_cohort_continuation_exhausted`；
  - `dispatch.json` 的 `status=terminal_failed`，`terminal_probe.error_type=FunctionTimeoutError`。
- **手動步驟**（同一個 business date 內，ticket attempt 少於 3）：
  ```powershell
  gcloud scheduler jobs run active8-oof-monthly --location asia-east1   # scripts/sync_gcp_scheduler.ps1 的 Location 預設
  ```
  非 continuation 的 run 會用同一個 cohort 重新 dispatch。
- **重跑會沿用哪些 fold**（`3936fa47b`）：7 個 family 都有完整 R33 attestation 的 window 會被 recover，其餘 window 整個重跑。
  - attestation 包括：同一個 producer source sha 和 feature semantic、train label-known max 早於 test_start、purge，以及 NF 的 complete-horizon accounting。
  - TimeXer 的 fold evidence 由這個 commit 開始寫入；在這之前跑完的 fold 不能 recover。
  - ⚠️ 撞上限當下還在跑的 window，可能已經寫了部分 family 的 immutable artifact。重跑時同一路徑必須 bit-identical，否則該 family 會報 `oof_prediction_artifact_immutable_conflict`（既有設計），那個 window 就會失敗，需要人工處理。

## PIT vintage 認證（C28-02）
- **是什麼**：月訓的第 4 個 OOF check `pit_vintage` 與 readiness 的 `pit_certification`。沒有收據、收據重新推導後不是 `point_in_time_vintage_certified=true`，或收據沒綁到這個 capture／這些 prep，lifecycle 就不 dispatch full-fit（fail-closed，沿用 A3「暫停、沿用舊模型」）。
- **規則只有一個來源**：`data/feature_registry/pit_availability_contract_v1.json`（lag、等級、門檻、證據 sha256、eps 遮罩 `pit_eps_revision_mask_v1.json` 的 sha256、T1/T2/T4/T5 測試檔 sha256 與 case 數）。旗標只由 `ml-controller/services/pit_certification.py` 推導，`full_fit_scope`／`timexer_cutoff` 只讀收據。
- **環境**（Mac，repo 根目錄）：
  ```bash
  export REPO=/Volumes/FireCuda/CloudCode/stockvision-cloudflare-v12
  export PYTHONPATH="$REPO:$REPO/ml-controller:$REPO/ml-service"
  ```
  `$PY` 是有 polars／pytest 的 Python；T4 要能 import torch 與 neuralforecast。
- **Wei 核准 contract（一次）**：把 `approval_status` 改成 `approved`，填 `approved_by`、`approved_at`（ISO 時間）、`approved_content_sha256`。content sha256 這樣算（approval 4 個欄位不算在內）：
  ```bash
  cd "$REPO/ml-controller" && "$PY" -c "from services.pit_certification import load_contract, contract_content_sha256; print(contract_content_sha256(load_contract()))"
  ```
  contract 任何其他欄位改動（lag、等級、門檻、證據、遮罩、`required_tests`）都會讓 sha 不符，必須重新核准。改了 T1/T2/T4/T5 任一測試檔或 case 數，要先更新 `required_tests` 再核准。
  - 改 `feature_lags` 一定要開新 contract version（新檔、新 `_FILES`／`_FEATURE_LAGS_SHA256` 項目）；同一個 version 下改 lag，ml-service 會拒絕（`pit_contract_feature_lags_changed_without_new_version`），因為 artifact 與 serving 只比對 version 字串。
  - 核准的 commit 要同時部署 controller image 與 Modal image（兩邊都從 `data/feature_registry` 讀 contract），之後才重產收據。只部署一邊時，ml-service 會把 certified 收據判成未推導（`pit_certification_flag_not_derived`）或 prep 拒絕（`pit_contract_sha256_mismatch`），full-fit／prep 失敗（fail-closed，但月訓會卡住）。
- **每個 capture 產生收據（本機，唯讀 GCS）**：
  1. 跑 T1/T2/T4/T5 並輸出 junit（不要用 `-k`：case 數不符就是 `test_not_pinned`；被 skip 視同未通過）：
     ```bash
     cd "$REPO/ml-controller" && "$PY" -m pytest tests/test_pit_truncation_equivalence.py tests/test_pit_revision_fixture.py --junitxml=/tmp/pit_ctl.xml
     cd "$REPO/ml-service" && "$PY" -m pytest tests/test_pit_lag_contract.py tests/test_sequence_scale_invariance.py --junitxml=/tmp/pit_svc.xml
     ```
  2. 產生收據（只寫本機檔，不寫 GCS）：
     ```bash
     cd "$REPO/ml-controller" && "$PY" -m services.pit_certification --sequence-prefix universal/sequence_long/runs/<sequence_run_id> \
       --run-date <capture end date> --junit /tmp/pit_ctl.xml --junit /tmp/pit_svc.xml --output /tmp/pit_certification.json
     ```
     exit 0 才是 true；false 時輸出的 `reasons` 就是原因。用完刪掉 `/tmp/pit_*`。
  3. 上傳到 `gs://stockvision-models/<capture_run_root>/pit_certification.json`（CLI 輸出的 `capture_run_root`，例如 `finlab/v4/backfill/<capture_run_id>`，與 `raw/` 同層；不是 sequence 的 run id）。**第一次上傳要 Wei 另外 go**。
- **綁定**（`verify_bound_receipt`，lifecycle、readiness、retrain trigger 都用）：
  - capture：收據的 sequence manifest checksum 要等於這個 capture 的；lane manifest 路徑必須在這個 capture 的 run root 下（從別的 capture 複製來的收據不算）；auxiliary 欄位 manifest 必須在 `select_field_captures` 搜尋的同一個上層 prefix 下（同 prefix 的其他 run 也算，不保證是這個 capture 自己的 run）；全部重新算 sha256 要和收據一致，prep 綁定再要求 prep 用的就是這幾份 manifest。
  - prep（lifecycle 與 full-fit trigger）：full-fit prep 與每個 window 的 source prep，其 immutable receipt 要記同一個 `pit_contract_version` 與 contract content sha256（`pit_contract_sha256`）、`roster_sidecar`、同一個 `capture_id`、同一組 auxiliary 欄位 capture，以及與收據相同的 eps 遮罩 sha256。readiness 時新 prep 還不存在，只查 capture。
  - prep 時 controller 把 contract 的 version 與 content sha256 一起送給 ml-service；ml-service 用自己 image 裡的 contract 檔算 sha256，不一致就拒絕（`pit_contract_sha256_mismatch`），並在每個 batch 的 cleaning report 記下實際套用的 version 與 sha256。controller 封存 prep receipt 前逐 batch 核對，對不上（例如舊版 ml-service 忽略這兩個欄位）就不封存（`prep_pit_contract_not_applied`／`pipeline_input_prep_pit_contract_not_applied`）。
  - retrain trigger 收到 `pit_certification` 會自己重新綁定，轉給 trainer 的是 GCS 上綁定過的那份收據，不是請求裡的（綁定失敗回 `pit_certification_not_verified:<reasons>`）；同時把 prep manifest 的 `pit_contract_version` 轉給 trainer，ml-service 要求收據的 version 與它相同（`pit_certification_prep_version_mismatch`），artifact 記的是 prep 的 version；沒有 `prebuilt_prep_gcs_prefix` 直接拒絕。R33 prep（canonical manifest 有 `pit_contract_version`）沒帶收據也拒絕（`pit_prep_requires_certification`），否則 artifact 不會記下特徵用的 lag。
  - full-fit receipt 記 `pit_certification_sha256`。同一個 cohort 用不同（或沒有）收據再進來時，不會沿用既有 full-fit，回 `full_fit_pit_certification_mismatch`（blocked）；要重訓由 coordinator 決定。
  - 因此 R33 cohort 的 full-fit 只能經 lifecycle 跑。不帶收據的呼叫端（walk_forward semantic reconciliation、`l4_oof_lifecycle`、`scripts/repair_active8_source_and_evaluation.py`）對 R33 cohort 會回 `full_fit_pit_certification_mismatch`，對 R33 prep 新派工會回 `pit_prep_requires_certification`；這是 fail-closed，不是 bug。
  - 信任邊界：收據沒有簽章。evidence、測試結果與檔案 sha256 是本機 CLI 記錄的，跑 CLI 並上傳收據的人對這些輸入負責（contract limitations 已寫）。
- **fail 時怎麼看**：lifecycle 回傳的 `pit_certification.reasons`（每次重新驗證的結果；`oof_checks.json` 裡的 `pit_vintage.reasons` 是封存當時的，可能已過時），或 readiness 的 `pit_certification.reasons`。常見原因：
  - `receipt_unreadable:<Type>:<message>`（lifecycle）、`pit_certification_unreadable:*`（readiness）、`prep_receipt_unreadable:*`：收據或 prep receipt 讀不了 → 先看 message：`pit_registry_file_missing`／`pit_contract_version_mismatch` 是 controller image 的 contract 檔問題；`pit_capture_root_unresolved`、`training_source_manifest_missing|invalid:*`、`training_source_prefix_invalid`、`KeyError:'sequence_gcs_prefix'` 是 sequence manifest／capture 路徑問題（重產收據沒用，要修 sequence）；JSON 錯誤可能是收據或 sequence manifest 壞掉，先確認是哪個物件再重產。
  - 收據放在 capture run root、只綁一個 sequence manifest。同一個 capture 另建 sequence 時要重產收據（否則 `receipt_capture_mismatch`）。
  - `receipt_missing`：capture 旁沒有收據 → 照上面產生、上傳。
  - `contract_not_approved`／`contract_sha256_mismatch`：contract 未核准或已改 → Wei 核准後重產收據。
  - `receipt_flag_not_derived`：收據記的 flag 和現在重新推導的不同，常見於核准前產的收據 → 核准後重跑 certify CLI 產新收據。
  - `test_not_passed:Tn:*`／`test_not_pinned:Tn`：測試失敗、被 skip、junit 沒涵蓋，或測試檔／case 數與 contract 不符 → 修好重跑。
  - `lane_manifest_unbound:*`、`capture_inventory_not_ready`：capture 不完整 → 重跑 capture。
  - `lane_manifest_changed:*`、`lane_field_changed:*`、`receipt_capture_mismatch`：收據產生後 capture 被改 → 重產收據。
  - `lane_manifest_foreign:*`、`lane_field_foreign:*`：收據描述的是別的 capture → 對這個 capture 重產收據。
  - `evidence_sha256_mismatch:*`、`revision_mask_sha256_mismatch:*`：收據記的證據或遮罩檔不是 contract 指定的那份 → 重產收據。
  - `receipt_malformed`、`receipt_binding_malformed`：收據結構壞掉 → 重產收據。
  - `prep_not_built_under_contract:*`、`prep_roster_sidecar_missing:*`、`prep_capture_mismatch:*`、`prep_revision_mask_mismatch:*`：prep 不是在這個 contract／capture／遮罩下建的（例如 recover 的舊 window，或 contract 改過後的舊 prep）→ 用 R33 prep 重建。
  - `oof_checks.json` 一律 write-once 封存（leakage／inversion／tail-guard 不會被重跑改寫）；裡面的 `pit_vintage` 只是封存當時的結果。每次跑 lifecycle 都重新 `verify_bound_receipt`，補好或重產收據後重跑即可。
  - 回傳與 bundle 的 `oof_checks.status` 是這次實際套用的 gate（封存的非 PIT 檢查＋這次的 PIT 驗證），`sealed_status` 是檔案本身的 status，`pit_certification_sha256` 是這次驗證過的收據。收據讀不了（例如不是 JSON）時 reason 是 `receipt_unreadable:*`。
  - `r33_pit_certification_unbound`（lifecycle）：這次重新驗證收據沒過 → 看回傳的 `pit_certification.reasons`。
  - `r33_full_fit_pit_metadata_missing`（lifecycle）：full-fit 完成，但 `full_fit_dispatch.pit_metadata_missing` 列出的模型 metadata 沒記這次的收據 sha、`point_in_time_vintage_certified=true` 或 contract version（例如 trainer 是舊版 Modal image）→ 不封存 bundle；確認 Modal 版本後由 coordinator 決定重訓。
  - 封存的 oof_checks 缺 leakage／inversion／tail_guard 任一項也視為失敗（`r33_oof_checks_failed`）。
  - bundle 封存後若重產收據，replay 同一 cohort 會因 artifact 綁的是舊收據回 `full_fit_pit_certification_mismatch`（fail-closed）；要用新收據就要重訓。
- **serving**：
  - 訓練時 artifact metadata 記下 prep 的 `pit_contract_version`。`batch_prediction` 會比對 artifact 與這次實際用來建特徵的 version（來自 `PredictRequest.pit_contract_version`），不一致就讓該模型對該股報錯（`pit_contract_version_serving_mismatch`），不會靜默用不同 lag 的特徵。
  - TimeXer 每日 inference 比對 artifact 與特徵 prep receipt 的 `pit_contract_version`（`pit_contract_version_serving_mismatch`）；frozen forward extension 要求 forward prep 與 cohort 訓練 prep 同一個 version，artifact 有記 version 時也必須相同（`forward_extension_pit_contract_mismatch`）。
  - 送 version 時 lagged 欄位（融資融券、月營收、eps、roe、revenue_growth_yoy）一律不用當天 scalar，請求要帶 `per_stock_ts` 歷史；沒有 `per_stock_ts` 這個 key 時 `batch_prediction` 直接拒絕（`pit_lagged_history_missing`）。key 在但該股沒有歷史（例如新上市）時，那些欄位是 0 並在 `_source_missing__*` 記缺口，不拒絕。
  - 每日推論怎麼服務 PIT artifact 見下方「每日推論（C28-02 P2）」。Worker 不轉傳 version（contract 檔 `limitations` 最後一句仍寫「Worker 與 daily inference prep 轉傳 version 是 promotion 工作」，那是 Phase 1 當時的描述；contract 釘了 sha，P2 不改它）。request 不帶 version 時，只有 legacy artifact 的輸出與現行 production 相同（`r33_serving_parity.py` 驗證）。
  - Cloud Run 的 ml-service image 沒有 `data/feature_registry`，帶 version 會 `pit_contract_missing`（fail-closed）；Modal image 有掛載。
- **R33 prep 另外做的事**：
  - label 市場別逐日（`market_since`＝目前市場的上市／上櫃日；之前的列標 `UNKNOWN`，不進 label 排名，約 9,090 symbol-day）。序列模型的 OOF 分群仍用每個 symbol 一個市場別（`symbol_market.json`）；
  - 補回 snapshot 視窗外的下市普通股（`training-roster-capture-sidecar-v1`，記在 prep receipt 的 `roster_sidecar`；沒有 core 身分、價格欄位不齊、還原價缺漏或缺法人欄位的，列在 `excluded`，例如 4947）；
  - eps 依遮罩把有重編的 symbol×quarter 設成缺值（feature 層會沿用當時已知、未重編的上一個值）。

### 每日推論（C28-02 P2）
計畫：`output/herdr-handoff-20261018/sys-cleanup-20261028/plan_C28-02_P2.md`（Wei 10/29 決定 Q1–Q7）。
- **feature 模型（A）**：Modal 依每個 artifact metadata 記的 `pit_contract_version` 取對應的 feature view。request 不帶 version 時，base view 就是現行 legacy view；遇到 v1 artifact 才 lazy 建 v1 view（每檔股票多一次 `build_feature_matrix`，不重跑模型），結果按 version 快取。request 層有帶 version 時維持 Phase 1 的嚴格比對。
  - 錯誤只影響「那個 artifact、那檔股票」，不會讓整個 chunk 變 `batch_override_build_failed`：未知 version／lag digest 不符 → `pit_feature_view_failed:<version>:…`；metadata 裡出現兩個 version → `pit_contract_version_ambiguous`；沒有 `per_stock_ts` → `pit_feature_view_failed:<version>:ValueError:pit_lagged_history_missing`。冠軍出錯時，該股票照舊 `active_feature_model_coverage_incomplete`。
  - chunk／GNN metrics 只在真的用到非 base view 時多一個 `pit_serving.feature_views.<version>`：`built`、`failed`，以及 `eps_revision_mask_current_quarter_stocks`（Q4：當天「當季」落在 eps 遮罩內的股票數；當季以法定申報期限換算：Q1 5/15、Q2 8/14、Q3 11/14、Q4 隔年 3/31；遮罩檔 sha 和 contract 不符時改記 `eps_revision_mask_error`）。只有 legacy 的日子 metrics 不變。
  - 成本：paired-NAV candidate child 是 parent 的 deepcopy，冠軍（legacy）和 candidate（v1）一定混用，child 又是序列執行，所以每個含 v1 的 child 都多一次全市場 feature build。第一個 v1 candidate 進來的首晚，用 `predict_batch_v2` timing 對照 capacity 門檻 900／1800 秒實測。
- **TimeXer（T1）**：`node_build_payloads` 在跑 legacy feature-only prep 之前，先看當天要服務的 TimeXer 有沒有 PIT version（serving manifest 的 `models`、`active8_shadow_candidates`，以及 NAV candidate ensemble，條件同 `prepare_candidate_requests`；逐份讀 metadata JSON）。有的話，**同一份** prep 的每個 batch 在 legacy 做完後，多寫一份 lagged matrix 到 `<legacy prefix>-pit-<version>`，controller 在 legacy receipt 封好後另外封 v1 receipt（`pit_variant_of`＝legacy `receipt_checksum`）。state 新 key `timexer_pit_feature_sources`，request 新 key `timexer_pit_feature_sources`（`{version: source set}`）；`timexer_feature_source` 和 L4 native request 的形狀不變。
  - v1 TimeXer 只讀自己 version 的 source；沒有 ready 的 source → `timexer_pit_feature_source_missing`（只影響該 TimeXer）。
  - v1 失敗不擋 legacy：batch 超過時間預算（已耗時＋legacy 耗時×1.25 超過 function timeout 的 90%）→ `pit_variant_time_budget_exceeded`；prep 沒有 `per_stock_ts_map` → `daily_prep_pit_history_missing`；任一 batch 失敗 → v1 receipt 不封（`pit_variant_batches_incomplete`）；欄位名不同 → `pit_variant_feature_names_mismatch`。讀 source 時：沒有 receipt `pit_variant_receipt_missing`；receipt 不完整 `pit_variant_receipt_invalid`；contract version／sha 不符 `pit_variant_contract_mismatch`；capture 綁定（6 個 `*_capture`、`business_date`、`producer_source_sha`、feature semantic、feature_names checksum、`pit_variant_of`）任一不同 `pit_variant_capture_mismatch`；legacy receipt 對不上 `pit_variant_legacy_receipt_invalid`。這些都記在 `timexer_pit_feature_sources.failures`。
  - 判斷 version 本身出錯（D1／GCS 讀不到、candidate 的 registry 缺 `metadata_path` → `pit_daily_candidate_registry_missing`）→ 記在 `timexer_pit_feature_sources.prediction_error`，當天不產 v1，production 照常。
  - metadata 記的 version 不是這個 controller 的 contract version（例如未來的 v2）→ 不送進 prep request，記在 `failures`（`pit_variant_version_unknown`），legacy prep 照常。
  - 限制：registered NAV pin（`registered_candidate_pins`）不讀。pin 住的 ensemble 已不是 candidate 狀態、又帶 v1 TimeXer 時，該 TimeXer fail closed。
  - 限制：判斷用 `decision_universe_frozen_at` 當 candidate 截止時間；L2 dispatch 在有 KV declarations 時用較晚的 `candidate_frozen_at`。兩者之間才建立的 candidate 若帶 v1 TimeXer，當天沒有 v1 source，fail closed。
  - L4 native observation 也會跑這個判斷（它的 state 沒有 `decision_universe_frozen_at`，有 ensemble manifest 時記成 `prediction_error` 並多一次 log warning）；它的 research request 不帶 PIT key，所以結果不受影響。
  - L4 forward refresh（`l4_forward_refresh.current_price_capture`）挑當天最新的 prep receipt 當價格證據時，略過 `-pit-` variant receipt（兩者 `price_capture` 相同，但 lineage 應指向 legacy receipt）。
  - resume 不重建：pre-L2 saved resume 要求 resumed 的 `timexer_pit_feature_sources` 等於 acceptance report 的 `pit_feature_sources`，且 original 不能有這個 key（`saved_pre_l2_pit_feature_source_mismatch`）；L2 saved resume 直接用 state 裡的值。pin 日（`_registered_feature_source`）的 v1 source 一律從 legacy prefix 推導並驗 receipt，沒有就 fail closed。
  - trigger 只接受 `inference_only` prep 帶 `pit_variant_versions`（`pit_variant_requires_inference_prep`），version 只能是現行 contract（`pit_variant_version_unknown`）；R33 profile 不能帶。
- **只有 legacy 的日子（第一個 v1 模型 serving 之前每一天）**：不新增 state／request key，prep batch payload、stage digest、metrics 都和 base 相同。
- **部署規則**：controller image 和 Modal `stockvision-ml` 必須是同一個 source SHA、同一個時段部署完，避開 evening chain（21:00–23:50）和它的重試時間。SHA 不同時 Modal 會 `pipeline_modal_source_sha_mismatch`，整份 prediction 被拒。Worker 0 檔、native-paper bundle 不變。
- **Modal warmup**：warmup payload 沒有 `per_stock_ts`。v1 冠軍升格後，warmup 裡 v1 view 會 `pit_lagged_history_missing`，warmup 結果變 degraded；這是預期行為，不是故障。
- **`/feature-drift`、`/factor-ic-audit`（Q2，維持不帶 version）**：Worker 直接打 Modal，4 個 margin／short 欄位用的是**沒有 lag 的 legacy 值**（Worker 端 `SELECT * FROM chip_data`），不是 0。drift 結果餵給手動的 `weekly-drift-retrain` gate（要人工 confirm），所以 v1 模型在這 4 個欄位上的 drift 統計和訓練分佈差一個 session 的 lag，只能當人工判斷的參考。
- **EPS（Q4，接受差異）**：訓練用最新 vintage、遮罩 cell 設 null 再 ffill 前一季；serving 用 append-only observation（當天看到什麼就存什麼）。影響只在 `l1_eps`（1,442 cell、101 檔），看 `pit_serving…eps_revision_mask_current_quarter_stocks`。
- **legacy 模型刪除時點（Q3，Wei 10/29）**：legacy XGBoost、R17 四臂影子、挑戰者登錄，在 **R33 升格的同時刪除**；XGBoost 在升格當天改成 `retired`（active／degraded 的 feature 模型都算 coverage 必需，vote weight 0 也一樣，它失敗會讓整列失敗）。過渡期由 A 照常服務兩種 version。P2 本身不刪任何模型；刪除照「砍模型前必問 Wei」另外執行。
- **既有問題（和 P2 無關，未修）**：L4 native observation（`l4_native_observation.prepare`）把 request 的 `timexer_feature_source`（TimeXer 在 contract 時是 `timexer-feature-source-set-v1`）傳給 `l4_risk_history._load_capture_risk_payloads`，後者要 raw、`status=="ready"` 的 capture，所以會 `l4_risk_single_capture_source_required`；base 上已經如此。建議改傳 `state['timexer_feature_source']`，由 L4 owner 決定。
