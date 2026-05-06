"""
ml-controller/main.py — StockVision ML Controller (Cloud Run)

ML Brain: orchestrates Modal parallel inference + recommendation scoring + adaptive params.

Architecture:
  Worker (cron dispatcher) → POST /batch-predict → Modal predict_single_stock.map()
                           → POST /recommend     → scoring + LLM
                           → POST /risk-assess   → adaptive params
                           → POST /verify        → ARF reward update via Modal
                           → POST /batch-retrain → Modal retrain_single_stock.map()
                           → GET  /model-status  → model health

Auth: X-Controller-Token header (set ML_CONTROLLER_SECRET env var)
"""
import os
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from services.modal_client import batch_predict_contract

from routers import predict, retrain, retrain_trigger, retrain_followup, verify, recommend, risk, status, sector_flow, backtest, lifecycle, pipeline, audit, adversarial, obsidian, intraday, regime, walk_forward, debate, model_pool, config_pool, admin, research_benchmark
# 2026-04-07 Phase 1.6: Optuna routes 從 Modal 移到 Cloud Run
try:
    from routers import optuna as optuna_router
except ImportError as _e:
    optuna_router = None
    import logging
    logging.getLogger(__name__).warning(f"[main] optuna router not loaded: {_e}")

VERSION = "12.3.0"
RUNTIME_VERSION = "ml-controller-mvc-refactor-2026-04-25"
CONTROL_PLANE_VERSION = "control-plane-cutover-2026-04-25"

app = FastAPI(title="StockVision ML Controller", version=VERSION)


def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ALLOW_ORIGINS", "").strip()
    if raw:
        return [origin.strip() for origin in raw.split(",") if origin.strip()]

    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip().rstrip("/")
    defaults = [
        worker_url,
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8787",
        "http://127.0.0.1:8787",
    ]
    return list(dict.fromkeys(origin for origin in defaults if origin))

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_methods=["POST", "GET"],
    allow_headers=["*"],
)

_CONTROLLER_TOKEN = os.environ.get("ML_CONTROLLER_SECRET", "")
_ENVIRONMENT = os.environ.get("ENVIRONMENT", "development")


async def verify_token(request: Request) -> None:
    """Worker → Controller 服務間驗證。ML_CONTROLLER_SECRET 未設定時跳過（開發環境）。"""
    if not _CONTROLLER_TOKEN:
        if _ENVIRONMENT == "production":
            raise HTTPException(status_code=500, detail="ML_CONTROLLER_SECRET not configured")
        return  # dev mode: skip auth
    token = request.headers.get("X-Controller-Token", "")
    if token != _CONTROLLER_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid controller token")


# ── 注入 auth dependency 到所有 router ────────────────────────────────────────
app.include_router(predict.router,  dependencies=[Depends(verify_token)])
app.include_router(retrain.router,  dependencies=[Depends(verify_token)])
app.include_router(retrain_trigger.router, dependencies=[Depends(verify_token)])
# 2026-04-20 #10 Phase 1: Webhook receiver for long-task completion (Pattern 1)
app.include_router(retrain_followup.router, dependencies=[Depends(verify_token)])
app.include_router(verify.router,   dependencies=[Depends(verify_token)])
app.include_router(recommend.router, dependencies=[Depends(verify_token)])
app.include_router(risk.router,     dependencies=[Depends(verify_token)])
app.include_router(status.router,      dependencies=[Depends(verify_token)])
app.include_router(sector_flow.router, dependencies=[Depends(verify_token)])
app.include_router(backtest.router,    dependencies=[Depends(verify_token)])
app.include_router(lifecycle.router,   dependencies=[Depends(verify_token)])
app.include_router(pipeline.router,    dependencies=[Depends(verify_token)])
app.include_router(audit.router,       dependencies=[Depends(verify_token)])
app.include_router(adversarial.router, dependencies=[Depends(verify_token)])
app.include_router(obsidian.router, prefix="/obsidian", dependencies=[Depends(verify_token)])
app.include_router(intraday.router, dependencies=[Depends(verify_token)])
# 2026-04-17 #30: HMM regime → ml:regime KV (Sprint 4-2 revisit)
app.include_router(regime.router,   dependencies=[Depends(verify_token)])
# 2026-04-17 #32: Sprint 6b walk-forward ML retrain orchestrator (scaffold)
app.include_router(walk_forward.router, dependencies=[Depends(verify_token)])
# 2026-04-18 #39: Morning Debate full port — runBuyDebate migrated from Worker
app.include_router(debate.router,       dependencies=[Depends(verify_token)])
# 2026-04-19 ML_POOL Plan A: model pool management (Stage 0.x bootstrap, Stage 1+ full lifecycle)
app.include_router(model_pool.router,   dependencies=[Depends(verify_token)])
# 2026-04-20 #28b T3.4/T3.5: Config pool challenger weekly eval
app.include_router(config_pool.router,  dependencies=[Depends(verify_token)])
# 2026-04-21 #28b T1.0: admin endpoints (modal deploy)
app.include_router(admin.router,        dependencies=[Depends(verify_token)])
app.include_router(research_benchmark.router, dependencies=[Depends(verify_token)])
# 2026-04-07 Phase 1.6: optuna routes 從 Modal 移到 Cloud Run
if optuna_router:
    app.include_router(optuna_router.router, dependencies=[Depends(verify_token)])


@app.get("/health")
def health():
    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
    pipeline_job_name = os.environ.get("PIPELINE_JOB_NAME", "").strip()
    verify_job_name = os.environ.get("VERIFY_JOB_NAME", "").strip()
    gcp_project_id = os.environ.get("GCP_PROJECT_ID", "").strip()
    gcp_region = os.environ.get("GCP_REGION", "").strip()
    return {
        "status": "ok",
        "version": VERSION,
        "service": "ml-controller",
        "runtimeVersion": RUNTIME_VERSION,
        "controlPlaneVersion": CONTROL_PLANE_VERSION,
        "callbackConfigured": bool(worker_url),
        "pipelineJobConfigured": all([pipeline_job_name, gcp_project_id, gcp_region]),
        "verifyJobConfigured": all([verify_job_name, gcp_project_id, gcp_region]),
        "batchPredictContract": batch_predict_contract(),
    }
