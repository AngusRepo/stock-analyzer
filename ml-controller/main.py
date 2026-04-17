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

from routers import predict, retrain, retrain_trigger, verify, recommend, risk, status, sector_flow, backtest, lifecycle, pipeline, audit, adversarial, obsidian, intraday, regime, walk_forward
# 2026-04-07 Phase 1.6: Optuna routes 從 Modal 移到 Cloud Run
try:
    from routers import optuna as optuna_router
except ImportError as _e:
    optuna_router = None
    import logging
    logging.getLogger(__name__).warning(f"[main] optuna router not loaded: {_e}")

VERSION = "12.3.0"

app = FastAPI(title="StockVision ML Controller", version=VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://stockvision-worker.angus-solo-dev.workers.dev"],
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
# 2026-04-07 Phase 1.6: optuna routes 從 Modal 移到 Cloud Run
if optuna_router:
    app.include_router(optuna_router.router, dependencies=[Depends(verify_token)])


@app.get("/health")
def health():
    return {
        "status": "ok",
        "version": VERSION,
        "service": "ml-controller",
    }
