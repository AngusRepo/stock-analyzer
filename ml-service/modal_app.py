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
import modal
from pathlib import Path

# ── 本機路徑（deploy 時 Modal 會自動上傳到 container）───────────────────────
_LOCAL_APP_DIR     = Path(__file__).parent / "app"
_LOCAL_SCRIPTS_DIR = Path(__file__).parent / "scripts"  # 2026-04-07: optuna_routes 需要 import scripts/optuna_*.py
_LOCAL_REQ         = Path(__file__).parent / "requirements.txt"

# ── Image 定義（Modal v1.x API）──────────────────────────────────────────────
image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("libgomp1")  # OpenMP runtime; LightGBM GPU deferred to future (needs CUDA toolkit in image)
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
    """單股推論 — Pure Compute。"""
    _setup_env()
    from app.main import predict_stock, PredictRequest
    try:
        req = PredictRequest(**payload)
        return predict_stock(req)
    except Exception as e:
        return {
            "stock_id": payload.get("stock_id", 0),
            "symbol": payload.get("symbol", "?"),
            "error": str(e),
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
    """GPU L4: FT-Transformer only."""
    _setup_env()
    from app.main import train_universal_from_gcs as _train, UniversalTrainRequest
    try:
        payload["models_filter"] = ["FT-Transformer"]
        req = UniversalTrainRequest(**payload)
        return _train(req)
    except Exception as e:
        return {"error": str(e), "type": "ftt_model"}


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


@app.function(
    gpu="L4",                    # LightGBM GPU mode for Target Permutation
    memory=4096,
    timeout=3600,                # 60 min — 100 permutations × ~30-60s each, K-S auto-stop ~30-50 rounds
    scaledown_window=60,
    max_containers=1,
)
def feature_selection_pipeline(payload: dict) -> dict:
    """2.0 Feature Selection: Silhouette → Target Permutation (Y-shuffle) → IC/ICIR → Elbow → Diversity Guard."""
    _setup_env()
    from app.feature_selection import run_feature_selection_pipeline
    try:
        return run_feature_selection_pipeline(
            max_rounds=payload.get("max_rounds", 100),
            alpha=payload.get("alpha", 0.01),
            required_power=payload.get("required_power", 0.99),
            dry_run=payload.get("dry_run", False),
        )
    except Exception as e:
        return {"error": str(e), "type": "feature_selection"}


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
