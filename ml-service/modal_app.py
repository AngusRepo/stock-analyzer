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
