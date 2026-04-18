"""
modal_app.py — StockVision ML Service（Modal 部署入口）

Phase 1 MVC 重構：
  - @modal.function() 定義（predict_single_stock, retrain_single_stock, update_arf_reward）
  - @modal.asgi_app() 保留向後相容（Worker legacy 路徑）
  - Cloud Run Controller 透過 .map() / .remote() 呼叫 Modal Functions

使用方式：
  部署：cd ml-service && python3 -m modal deploy modal_app.py
  本地測試：python3 -m modal serve modal_app.py
"""
import os
import modal
from pathlib import Path

# ── 本機路徑（deploy 時 Modal 會自動上傳到 container）───────────────────────
_LOCAL_APP_DIR     = Path(__file__).parent / "app"
_LOCAL_SCRIPTS_DIR = Path(__file__).parent / "scripts"  # 2026-04-07: optuna_routes 需要 import scripts/optuna_*.py
_LOCAL_REQ         = Path(__file__).parent / "requirements.txt"

# ── Image 定義（Modal v1.x API）──────────────────────────────────────────────
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgomp1", "ocl-icd-libopencl1")  # OpenMP + OpenCL ICD loader (NVIDIA driver provides libOpenCL at runtime)
    .pip_install_from_requirements(str(_LOCAL_REQ))
    .run_commands(
        "python -c \""
        "from chronos import ChronosPipeline; "
        "ChronosPipeline.from_pretrained('amazon/chronos-t5-tiny', device_map='cpu')"
        "\" || echo 'Chronos pre-download skipped (not installed)'",
    )
    .add_local_dir(str(_LOCAL_SCRIPTS_DIR), remote_path="/root/scripts")
    .add_local_dir(str(_LOCAL_APP_DIR), remote_path="/root/app")  # must be last
)

# ── Secret：GCS 憑證 + Cloudflare API（D1+KV，2026-04-07 Phase 1）─────────
gcs_secret = modal.Secret.from_name("gcs-credentials")

# stockvision-cf 必須先 manual 建立：
#   modal secret create stockvision-cf \
#     CF_API_TOKEN=cfut_DzJ8hr6iRf4Sapft9EhfC9fgMNpUaS22PWrGm2Yw780682bf \
#     CF_ACCOUNT_ID=619a83ac9f20847d9e2f2920823b727d \
#     CF_D1_DB_ID=6401a5f6-5767-4fa8-a1a7-ec8d4739ac79 \
#     STOCKVISION_AUTH_TOKEN=sv-stockvision-2026-prod \
#     STOCKVISION_WORKER_URL=https://stockvision-worker.angus-solo-dev.workers.dev
# 若 secret 不存在，from_name 會報錯 → fallback 用空 secret
try:
    cf_secret = modal.Secret.from_name("stockvision-cf")
except Exception:
    print("[modal_app] stockvision-cf secret not found, Optuna routes will fail")
    cf_secret = modal.Secret.from_dict({})

# ── App 定義 ──────────────────────────────────────────────────────────────────
app = modal.App(
    name="stockvision-ml",
    image=image,
    secrets=[gcs_secret, cf_secret],
)

# ── 共用：GCS 憑證注入 + sys.path 設定 ───────────────────────────────────────
def _setup_env():
    """在 Modal container 內設定 GCS 憑證和 import path。"""
    import os, sys
    creds_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON", "")
    if creds_json:
        creds_path = "/tmp/gcs-credentials.json"
        with open(creds_path, "w") as f:
            f.write(creds_json)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = creds_path
    if "/root" not in sys.path:
        sys.path.insert(0, "/root")


# ══════════════════════════════════════════════════════════════════════════════
# Modal Functions（Cloud Run Controller 透過 .map() 呼叫）
# ══════════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════════════════
# 2.0 Flow B Orchestrator — Modal 內部 chain
# Cloud Run 只觸發此函數，後續 selection → train → SHAP 全在 Modal 內完成
# ══════════════════════════════════════════════════════════════════════════════

@app.function(
    cpu=1,
    memory=1024,
    timeout=18000,              # 300 min — selection (~70min) + train (~140min) + SHAP (~30min) + buffer (regime 900d worst case)
    scaledown_window=60,
    max_containers=1,
)
def retrain_orchestrator(payload: dict) -> dict:
    """2.0 Flow B: prep 已完成 → [月度: await selection] → await train → await SHAP.

    Cloud Run 呼叫此函數（一次），整條 chain 在 Modal 內完成。
    Cloud Run 不需要等（fire-and-forget 或 await 都可以）。

    payload:
        batch_count: int — prep 產生的 batch 數量
        is_monthly: bool — 是否月度（day 1-7）
        selection_params: dict — {max_rounds, alpha, required_power}（月度才用）
    """
    _setup_env()
    import time
    t0 = time.time()

    batch_count = payload.get("batch_count", 5)
    is_monthly = payload.get("is_monthly", False)
    selection_params = payload.get("selection_params", {
        "max_rounds": 100, "alpha": 0.01, "required_power": 0.99,
    })

    # ── P0-3: Defensive GCS batch count validation ────────────────────────────
    # Cloud Run may pass stale/wrong batch_count (e.g. "1" when actual prep wrote 5).
    # Check actual .npz files in GCS and use the larger value.
    try:
        from google.cloud import storage as _gcs_chk
        _bucket_chk = _gcs_chk.Client().bucket("stockvision-models")
        actual_batch_count = sum(
            1 for i in range(20)  # cap at 20 to avoid excessive API calls
            if _bucket_chk.blob(f"universal/prep/batch_{i}.npz").exists()
        )
        if actual_batch_count > 0 and actual_batch_count != batch_count:
            print(
                f"[Orchestrator] ⚠️ P0-3 batch_count mismatch: "
                f"payload={batch_count} vs GCS={actual_batch_count} → using max"
            )
            batch_count = max(batch_count, actual_batch_count)
        else:
            print(f"[Orchestrator] GCS batch count verified: {actual_batch_count} batches")
    except Exception as _e:
        print(f"[Orchestrator] GCS batch count check failed (using payload value {batch_count}): {_e}")

    result = {"stages": {}}

    # ── Stage 1: Feature Selection (月度 only) ────────────────────────────────
    if is_monthly:
        print(f"[Orchestrator] Monthly → running feature selection (max {selection_params.get('max_rounds', 100)} rounds)")
        try:
            fs_result = feature_selection_pipeline.remote(selection_params)
            result["stages"]["feature_selection"] = {
                "status": "ok" if "error" not in fs_result else "error",
                "active_count": len(fs_result.get("feature_pool", {}).get("active", [])),
                "elapsed_s": fs_result.get("elapsed_s", 0),
            }
            if "error" in fs_result:
                print(f"[Orchestrator] Feature selection error: {fs_result['error']}")
        except Exception as e:
            print(f"[Orchestrator] Feature selection failed: {e}")
            result["stages"]["feature_selection"] = {"status": "error", "error": str(e)}
    else:
        print("[Orchestrator] Non-monthly → skip feature selection")
        result["stages"]["feature_selection"] = {"status": "skipped"}

    # ── Stage 2: Train — 2-container parallel (tree CPU + FT-T GPU) ──────────
    print(f"[Orchestrator] Training from {batch_count} GCS batches (2-container parallel)...")
    train_payload = {"batch_count": batch_count}
    try:
        # Spawn both containers in parallel
        tree_handle = train_tree_models.spawn(train_payload)
        ftt_handle = train_ftt_model.spawn(train_payload)
        print("[Orchestrator] Spawned: tree_models (CPU) + ftt_model (L4 GPU)")

        # Wait for both
        tree_result = tree_handle.get()
        ftt_result = ftt_handle.get()
        print(f"[Orchestrator] Tree done: {tree_result.get('elapsed_s', '?')}s / FTT done: {ftt_result.get('elapsed_s', '?')}s")

        # Merge results + IC tracking from both containers
        merged_results = {}
        merged_ic = {}
        circuit_breaker = False
        total_samples = 0

        for partial in [tree_result, ftt_result]:
            if partial.get("error"):
                print(f"[Orchestrator] ⚠️ Partial train error: {partial['error']}")
                continue
            total_samples = max(total_samples, partial.get("total_samples", 0))
            for name, r in partial.get("results", {}).items():
                if not r.get("skipped"):
                    merged_results[name] = r
            for name, ic in partial.get("ic_tracking", {}).items():
                merged_ic[name] = ic
                if not ic.get("passed", True):
                    circuit_breaker = True

        result["stages"]["train"] = {
            "status": "ok",
            "total_samples": total_samples,
            "ic_tracking": merged_ic,
            "circuit_breaker": circuit_breaker,
            "tree_elapsed_s": tree_result.get("elapsed_s"),
            "ftt_elapsed_s": ftt_result.get("elapsed_s"),
        }
        if circuit_breaker:
            print("[Orchestrator] ⚠️ Circuit breaker: some models IC≤0 — ensemble will auto-zero-weight them")

        # Write merged ic_tracking.json to GCS (both containers skip GCS write when models_filter set)
        try:
            from google.cloud import storage as _gcs
            import json as _json
            from datetime import datetime as _dt
            _bucket = _gcs.Client().bucket("stockvision-models")
            _ic_record = {
                "computed_at": _dt.utcnow().isoformat() + "Z",
                "models": merged_ic,
                "circuit_breaker": circuit_breaker,
                "total_samples": total_samples,
                "source": "orchestrator_merged",
            }
            _ic_json = _json.dumps(_ic_record, indent=2)
            _bucket.blob("universal/ic_tracking.json").upload_from_string(
                _ic_json, content_type="application/json"
            )
            _month = _dt.utcnow().strftime("%Y-%m")
            _bucket.blob(f"universal/ic_history/{_month}.json").upload_from_string(
                _ic_json, content_type="application/json"
            )
            print(f"[Orchestrator] IC tracking saved (breaker={'ON' if circuit_breaker else 'OFF'}, {len(merged_ic)} models)")
        except Exception as e:
            print(f"[Orchestrator] IC tracking GCS save failed: {e}")

        # SHAP (runs after both containers done)
        try:
            print("[Orchestrator] Auto-triggering SHAP audit...")
            shap_result = shap_feature_audit.remote({"shap_samples": 10000})
            result["stages"]["shap"] = {"status": "ok"}
        except Exception as e:
            print(f"[Orchestrator] SHAP failed (non-blocking): {e}")
            result["stages"]["shap"] = {"status": "error", "error": str(e)}

    except Exception as e:
        print(f"[Orchestrator] Train failed: {e}")
        result["stages"]["train"] = {"status": "error", "error": str(e)}

    elapsed = round(time.time() - t0, 1)
    result["total_elapsed_s"] = elapsed
    print(f"[Orchestrator] Flow B complete in {elapsed}s")
    return result


@app.function(
    cpu=1,                       # 1 CPU 足夠（10 models 已用 ThreadPoolExecutor 內部並行）
    memory=2048,                 # 2GB 足夠（torch CPU 模式不需 4GB）
    timeout=300,                 # 2026-04-08 P0-b: 180→300 buffer for tail inference + cold start
    min_containers=0,            # Starter Plan 省 idle 成本（靠 Worker 17:15 warmup 預熱）
    scaledown_window=900,        # 2026-04-08: 300→900 so 17:15 warmup keeps containers alive until 17:30 pipeline
    max_containers=20,           # Starter 100 上限 → 限制最多 20 並發（77 stocks 分 4 波）
)
def predict_single_stock(payload: dict) -> dict:
    """單股推論 — 2.0: regression models + IC-weighted rank_to_signal.
    Fallback to 1.0 predict_stock if v2 fails (e.g. universal model not yet trained).
    """
    _setup_env()
    from app.main import predict_stock_v2, predict_stock, PredictRequest
    try:
        req = PredictRequest(**payload)
        return predict_stock_v2(req)
    except Exception as e_v2:
        # Fallback to 1.0 if v2 fails (e.g. model not found)
        try:
            req = PredictRequest(**payload)
            result = predict_stock(req)
            result["_fallback"] = f"v2 failed: {e_v2}"
            return result
        except Exception as e_v1:
            return {
                "stock_id": payload.get("stock_id", 0),
                "symbol": payload.get("symbol", "?"),
                "error": f"v2: {e_v2} | v1: {e_v1}",
                "signal": "NO_SIGNAL",
                "direction": "neutral",
                "confidence": 0.0,
            }


@app.function(
    cpu=1,
    memory=2048,
    timeout=300,
    scaledown_window=60,
    max_containers=10,
)
def retrain_single_stock(payload: dict) -> dict:
    """單股重訓 — Pure Compute。"""
    _setup_env()
    from app.main import retrain_stock, PredictRequest
    try:
        req = PredictRequest(**payload)
        return retrain_stock(req)
    except Exception as e:
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": str(e),
        }


@app.function(
    cpu=1,
    memory=2048,                 # prep: build_feature_matrix × ~500 stocks ≈ 1GB peak
    timeout=600,                 # 10 min per batch
    scaledown_window=60,
    max_containers=3,            # 可並行 prep 多批
)
def prep_universal_batch(payload: dict) -> dict:
    """單批 feature engineering → 存 GCS npz。"""
    _setup_env()
    from app.main import prep_universal_batch as _prep, UniversalPrepRequest
    try:
        req = UniversalPrepRequest(**payload)
        return _prep(req)
    except Exception as e:
        return {"error": str(e), "batch_index": payload.get("batch_index", -1)}


@app.function(
    gpu="L4",                    # FT-Transformer needs GPU; L4 24GB for 631K full samples
    memory=4096,                 # 631K samples × 106 features ≈ 500MB + tree training overhead
    timeout=7200,                # 120 min — tree models ~5 min + FT-T GPU 631K ~90 min
    scaledown_window=60,
    max_containers=1,
)
def train_universal_from_gcs(payload: dict) -> dict:
    """從 GCS 讀 prep npz → concat → 訓練 5 models → 自動觸發 SHAP + Permutation。
    Legacy single-container path. Kept for backwards compat.
    """
    _setup_env()
    from app.main import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        req = UniversalTrainRequest(**payload)
        train_result = _train(req)
    except Exception as e:
        return {"error": str(e), "type": "universal"}

    # Auto-trigger SHAP dashboard (Modal internal, no Cloud Run dependency)
    auto_audit = payload.get("auto_audit", True)
    if auto_audit and "error" not in train_result:
        try:
            print("[TrainUniversal] Auto-triggering SHAP dashboard audit...")
            shap_result = shap_feature_audit.remote({"shap_samples": 10000})
            train_result["shap_result"] = shap_result
            print(f"[TrainUniversal] SHAP done: {shap_result.get('keep_count', '?')} features kept")
        except Exception as e:
            print(f"[TrainUniversal] SHAP auto-trigger failed (non-blocking): {e}")
            train_result["shap_error"] = str(e)

    return train_result


# ── 2-container split: tree models (CPU) + FT-T (GPU) ─────────────────────
# Saves ~30 min GPU idle time + enables parallel training.
# Orchestrator spawns both, waits for both, then merges results for IC gate.

@app.function(
    cpu=2,
    memory=4096,
    timeout=5400,                # 90 min — 4 tree models sequential on CPU
    scaledown_window=60,
    max_containers=1,
)
def train_tree_models(payload: dict) -> dict:
    """CPU-only: XGBoost + CatBoost + ExtraTrees + LightGBM."""
    _setup_env()
    from app.main import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        payload["models_filter"] = ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"]
        req = UniversalTrainRequest(**payload)
        return _train(req)
    except Exception as e:
        return {"error": str(e), "type": "tree_models"}


@app.function(
    gpu="L4",
    memory=4096,
    timeout=10800,               # 180 min — FT-T on 1.3M samples
    scaledown_window=60,
    max_containers=1,
)
def train_ftt_model(payload: dict) -> dict:
    """GPU L4: FT-Transformer only (uses all features, skip_feature_pool=True)."""
    _setup_env()
    from app.main import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        payload["models_filter"] = ["FT-Transformer"]
        payload["skip_feature_pool"] = True  # FT-T benefits from full 106 features
        req = UniversalTrainRequest(**payload)
        return _train(req)
    except Exception as e:
        return {"error": str(e), "type": "ftt_model"}


# ══════════════════════════════════════════════════════════════════════════════
# Sprint 6b Walk-Forward Modal functions (2026-04-18 #32)
# ══════════════════════════════════════════════════════════════════════════════

@app.function(
    cpu=2,
    memory=4096,
    timeout=3600,   # 60 min per window — tree models on ~60d train data
    scaledown_window=60,
    max_containers=3,   # allow 3 windows in parallel for tree path
)
def train_wf_tree_window(payload: dict) -> dict:
    """CPU-only walk-forward: XGBoost + CatBoost + ExtraTrees + LightGBM for one window.

    payload: window_id, train_start, train_end, test_start, test_end, batch_count
    """
    _setup_env()
    from app.main import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        gcs_prefix = f"walk_forward/w{payload['window_id']}"
        req = UniversalTrainRequest(
            batch_count=payload.get("batch_count", 5),
            models_filter=["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"],
            skip_feature_pool=payload.get("skip_feature_pool", False),
            train_start=payload["train_start"],
            train_end=payload["train_end"],
            test_start=payload["test_start"],
            test_end=payload["test_end"],
            gcs_prefix=gcs_prefix,
            window_id=payload["window_id"],
            skip_weekly_backup=True,
        )
        return _train(req)
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:2000],
            "window_id": payload.get("window_id"),
            "type": "wf_tree",
        }


@app.function(
    gpu="L4",
    memory=4096,
    timeout=3600,  # 60 min per window — FT-T on ~60d train data (smaller than universal)
    scaledown_window=60,
    max_containers=2,   # allow 2 windows on GPU in parallel
)
def train_wf_ftt_window(payload: dict) -> dict:
    """GPU walk-forward: FT-Transformer for one window."""
    _setup_env()
    from app.main import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        gcs_prefix = f"walk_forward/w{payload['window_id']}"
        req = UniversalTrainRequest(
            batch_count=payload.get("batch_count", 5),
            models_filter=["FT-Transformer"],
            skip_feature_pool=True,   # FT-T benefits from full features
            train_start=payload["train_start"],
            train_end=payload["train_end"],
            test_start=payload["test_start"],
            test_end=payload["test_end"],
            gcs_prefix=gcs_prefix,
            window_id=payload["window_id"],
            skip_weekly_backup=True,
        )
        return _train(req)
    except Exception as e:
        import traceback
        return {
            "error": str(e),
            "trace": traceback.format_exc()[:2000],
            "window_id": payload.get("window_id"),
            "type": "wf_ftt",
        }


@app.function(
    cpu=1,
    memory=2048,
    timeout=300,   # 5 min — HMM is small (market-level, ~500 days max)
    scaledown_window=60,
    max_containers=3,
)
def train_wf_hmm_window(payload: dict) -> dict:
    """Train HMM on historical window and save snapshot to walk_forward/w{id}/."""
    _setup_env()
    from app.regime import RegimeDetector, build_market_feature_matrix
    try:
        window_id = payload["window_id"]
        train_end = payload["train_end"]
        market_env = payload["market_env"]

        feat_mat = build_market_feature_matrix(market_env)
        if feat_mat is None or len(feat_mat) < 30:
            return {
                "error": f"insufficient history: got {len(feat_mat) if feat_mat is not None else 0}, need >=30",
                "window_id": window_id,
            }

        detector = RegimeDetector().fit(feat_mat)
        if not detector._trained:
            return {"error": "HMM fit did not converge", "window_id": window_id}

        gcs_prefix = f"walk_forward/w{window_id}"
        saved = detector.save_to_gcs(
            gcs_prefix=gcs_prefix,
            extra_metadata={
                "window_id": window_id,
                "train_end": train_end,
                "history_days": len(feat_mat),
            },
        )
        return {
            "window_id": window_id,
            "gcs_prefix": gcs_prefix,
            "n_components": detector.n_components,
            "history_days": len(feat_mat),
            "saved": saved,
        }
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc()[:2000], "window_id": payload.get("window_id")}


@app.function(
    cpu=1,
    memory=2048,
    timeout=14400,   # 4 hour cap — 14 windows × ~15 min sequential = ~3.5 hr
    scaledown_window=60,
    max_containers=1,   # only one orchestrator at a time
)
def walk_forward_orchestrator(payload: dict) -> dict:
    """Walk-forward orchestrator (Modal-resident) — runs full pipeline across
    all windows, calling train_wf_tree_window / train_wf_ftt_window / train_wf_hmm_window
    internally. Persists aggregate result to GCS walk_forward/runs/{start}_{end}.json.

    payload:
        windows: list of {window_id, train_start, train_end, test_start, test_end}
        market_env: dict (full history — each window filters locally)
        batch_count: int
        models: list[str]
        concurrent_windows: int (default 2)
        start_date: str (for GCS path)
        end_date: str

    Returns: {gcs_path, aggregate}
    Fire-and-forget: ml-controller calls .spawn() and returns immediately.
    """
    _setup_env()
    import time
    import json
    import asyncio

    t0 = time.time()
    windows = payload["windows"]
    market_env = payload["market_env"]
    batch_count = payload.get("batch_count", 5)
    models = payload.get("models") or ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM", "FT-Transformer"]
    concurrent = int(payload.get("concurrent_windows", 2))
    start_date = payload["start_date"]
    end_date = payload["end_date"]

    def _filter_env(end_str: str) -> dict:
        hist = market_env.get("history", {})
        filtered = {d: v for d, v in hist.items() if d <= end_str}
        if not filtered:
            return market_env
        latest_date = max(filtered.keys())
        return {"history": filtered, **filtered[latest_date]}

    async def _run_one(window: dict) -> dict:
        """HMM → tree+ftt in parallel for one window."""
        wid = window["window_id"]
        result = {
            "window_id": wid,
            "train_range": [window["train_start"], window["train_end"]],
            "test_range": [window["test_start"], window["test_end"]],
            "model_metrics": {},
        }
        # Step 1: HMM
        try:
            hmm_payload = {
                "window_id": wid,
                "train_end": window["train_end"],
                "market_env": _filter_env(window["train_end"]),
            }
            result["hmm_result"] = await train_wf_hmm_window.remote.aio(hmm_payload)
        except Exception as e:
            print(f"[WF-Orchestrator] w{wid} HMM crashed: {e}")
            result["hmm_result"] = {"error": str(e)}

        # Step 2+3: tree + ftt in parallel
        train_payload = {
            "window_id": wid,
            "train_start": window["train_start"],
            "train_end": window["train_end"],
            "test_start": window["test_start"],
            "test_end": window["test_end"],
            "batch_count": batch_count,
            "skip_feature_pool": False,
        }

        need_tree = any(m in models for m in ["XGBoost", "CatBoost", "ExtraTrees", "LightGBM"])
        need_ftt = "FT-Transformer" in models
        tasks = []
        if need_tree:
            tasks.append(("tree", train_wf_tree_window.remote.aio(dict(train_payload))))
        if need_ftt:
            ftt_payload = dict(train_payload)
            ftt_payload["skip_feature_pool"] = True
            tasks.append(("ftt", train_wf_ftt_window.remote.aio(ftt_payload)))

        if tasks:
            raw = await asyncio.gather(*[t[1] for t in tasks], return_exceptions=True)
            for (kind, _), r in zip(tasks, raw):
                if isinstance(r, BaseException):
                    print(f"[WF-Orchestrator] w{wid} {kind} crashed: {r}")
                    result[f"{kind}_result"] = {"error": str(r)}
                else:
                    result[f"{kind}_result"] = r

        # Consolidate per-model metrics
        for partial in [result.get("tree_result") or {}, result.get("ftt_result") or {}]:
            if not partial or partial.get("error"):
                continue
            for model_name, m in (partial.get("results") or {}).items():
                if m.get("skipped") or m.get("error"):
                    continue
                result["model_metrics"][model_name] = {
                    "oos_ic": m.get("oos_ic"),
                    "train_samples": m.get("train"),
                    "test_samples": m.get("test"),
                }
        return result

    async def _orchestrate() -> list[dict]:
        sem = asyncio.Semaphore(concurrent)

        async def _bounded(w):
            async with sem:
                print(f"[WF-Orchestrator] Starting window {w['window_id']}")
                r = await _run_one(w)
                print(f"[WF-Orchestrator] Finished window {w['window_id']} "
                      f"(ic={[(k, v.get('oos_ic')) for k, v in r.get('model_metrics',{}).items()]})")
                return r

        return await asyncio.gather(*[_bounded(w) for w in windows])

    all_results = asyncio.run(_orchestrate())

    # Aggregate
    per_model = {}
    n_err = 0
    for wr in all_results:
        if not wr.get("model_metrics"):
            n_err += 1
            continue
        for mname, m in wr["model_metrics"].items():
            if m.get("oos_ic") is None:
                continue
            per_model.setdefault(mname, []).append(float(m["oos_ic"]))

    summary = {}
    for mname, ics in per_model.items():
        import statistics
        if not ics:
            continue
        summary[mname] = {
            "n_windows": len(ics),
            "mean_ic": sum(ics) / len(ics),
            "std_ic": statistics.stdev(ics) if len(ics) >= 2 else 0.0,
            "min_ic": min(ics),
            "max_ic": max(ics),
            "positive_share": sum(1 for ic in ics if ic > 0) / len(ics),
            "ic_per_window": ics,
        }

    aggregate = {
        "n_windows_total": len(all_results),
        "n_windows_errored": n_err,
        "per_model": summary,
        "elapsed_s": round(time.time() - t0, 1),
    }

    # Persist to GCS
    try:
        from google.cloud import storage
        bucket = storage.Client().bucket(os.environ.get("GCS_BUCKET_NAME", "stockvision-models"))
        gcs_path = f"walk_forward/runs/{start_date}_{end_date}.json"
        bucket.blob(gcs_path).upload_from_string(
            json.dumps({
                "start_date": start_date,
                "end_date": end_date,
                "train_window_days": payload.get("train_window_days", 60),
                "test_window_days": payload.get("test_window_days", 30),
                "windows": all_results,
                "aggregate": aggregate,
            }, indent=2, default=str),
            content_type="application/json",
        )
        print(f"[WF-Orchestrator] Persisted → gs://{bucket.name}/{gcs_path}")
    except Exception as e:
        print(f"[WF-Orchestrator] Persist failed: {e}")
        gcs_path = None

    return {
        "gcs_path": gcs_path,
        "aggregate": aggregate,
        "elapsed_s": round(time.time() - t0, 1),
    }


@app.function(
    gpu="L4",
    memory=4096,
    timeout=1800,                # 30 min — SHAP on 5 models × 5K samples
    scaledown_window=60,
    max_containers=1,
)
def shap_feature_audit(payload: dict) -> dict:
    """SHAP Feature Importance Audit — 跨 5 個 model 評估 feature 重要性。"""
    _setup_env()
    from app.main import run_shap_audit
    try:
        shap_samples = payload.get("shap_samples", 5000)
        return run_shap_audit(shap_samples=shap_samples)
    except Exception as e:
        return {"error": str(e), "type": "shap_audit"}


# ══════════════════════════════════════════════════════════════════════════════
# P0-8: Feature Selection Pipeline (Modal Function wrapper)
# 月度 retrain_orchestrator 透過 .remote() 呼叫此 function (orchestrator scope name)
# ══════════════════════════════════════════════════════════════════════════════

@app.function(
    cpu=4,                       # Target Permutation × N rounds CPU-bound
    memory=8192,                 # Spearman corr + LightGBM on full 960K samples
    timeout=7200,                # 120 min — signal gate (~5min) + clustering + TP (~30min) + Optuna K sweep (~30min) + diversity guard
    scaledown_window=60,
    max_containers=1,
)
def feature_selection_pipeline(payload: dict) -> dict:
    """月度 Feature Selection: Signal Gate → Silhouette → Target Permutation →
    IC/ICIR → Optuna K Pareto sweep → Diversity Guard → 雙 Pool 輸出 (tree_active + ft_active)。

    Reads prep .npz from GCS, writes feature_pool.json to GCS.
    """
    _setup_env()
    from app.feature_selection import run_feature_selection_pipeline
    try:
        return run_feature_selection_pipeline(
            max_rounds=payload.get("max_rounds", 100),
            alpha=payload.get("alpha", 0.01),
            dry_run=payload.get("dry_run", False),
        )
    except Exception as e:
        import traceback
        return {"error": str(e), "trace": traceback.format_exc(), "type": "feature_selection"}


@app.function(
    cpu=1,
    memory=1024,
    timeout=60,
    scaledown_window=60,
    max_containers=5,
)
def update_arf_reward(payload: dict) -> dict:
    """ARF/LinUCB 驗證更新 — 輕量計算。"""
    _setup_env()
    from app.main import update_arf, ARFUpdateRequest
    try:
        req = ARFUpdateRequest(**payload)
        return update_arf(req)
    except Exception as e:
        return {"error": str(e)}


# ══════════════════════════════════════════════════════════════════════════════
# ASGI Web Endpoint（warmup + /health + IC audit 仍需要）
# ══════════════════════════════════════════════════════════════════════════════

@app.function(
    cpu=2,            # 2026-04-07 bumped: Optuna 200 trials needs CPU
    memory=4096,      # 2026-04-07 bumped: Optuna 載入 paper_orders + predictions 較大
    timeout=1800,     # 2026-04-07 bumped 300→1800: optuna_signal/sltp 200 trials 可達 5-15 min
    scaledown_window=60,
    max_containers=2,
)
@modal.concurrent(max_inputs=4)
@modal.asgi_app()
def fastapi_app():
    """ASGI endpoint — Worker warmup cron + IC audit + Optuna routes。"""
    _setup_env()
    from app.main import app as fastapi_application
    return fastapi_application
