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
import asyncio
from fastapi import FastAPI, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from services.modal_client import batch_predict_contract
from services.trading_config_loader import DEFAULT_REQUIRED_CONFIG

from routers import predict, retrain, retrain_trigger, retrain_followup, verify, recommend, risk, status, sector_flow, backtest, lifecycle, pipeline, audit, adversarial, obsidian, intraday, regime, walk_forward, debate, model_pool, config_pool, admin, research_benchmark, dataset_snapshots, meta_learning, paper_challenger, breeze2, finlab, strategy_similarity
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
# Modal long-task callbacks use the service-token contract inside the router.
# Do not also require the Worker controller header here; that rejects Modal
# followups before they can release locks and close scheduler status.
app.include_router(retrain_followup.router)
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
# 2026-04-17 #32: Sprint 6b walk-forward ML retrain orchestrator
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
app.include_router(dataset_snapshots.router, dependencies=[Depends(verify_token)])
app.include_router(meta_learning.router, dependencies=[Depends(verify_token)])
app.include_router(paper_challenger.router, dependencies=[Depends(verify_token)])
app.include_router(breeze2.router, dependencies=[Depends(verify_token)])
app.include_router(finlab.router, dependencies=[Depends(verify_token)])
app.include_router(strategy_similarity.router, dependencies=[Depends(verify_token)])
# 2026-04-07 Phase 1.6: optuna routes 從 Modal 移到 Cloud Run
if optuna_router:
    app.include_router(optuna_router.router, dependencies=[Depends(verify_token)])


@app.get("/health")
def health():
    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip()
    pipeline_job_name = os.environ.get("PIPELINE_JOB_NAME", "").strip()
    verify_job_name = os.environ.get("VERIFY_JOB_NAME", "").strip()
    optuna_job_name = os.environ.get("OPTUNA_JOB_NAME", "").strip()
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
        "optunaJobConfigured": all([optuna_job_name, gcp_project_id, gcp_region]),
        "batchPredictContract": batch_predict_contract(),
    }


def _warmup_payload(symbol: str, stock_id: int) -> dict:
    prices = [
        {
            "date": f"2026-01-{(idx % 28) + 1:02d}",
            "open": 99.8 + idx * 0.1,
            "high": 100.5 + idx * 0.1,
            "low": 99.5 + idx * 0.1,
            "close": 100.0 + idx * 0.1,
            "adj_close": 100.0 + idx * 0.1,
            "volume": 1_000_000 + idx * 1000,
        }
        for idx in range(60)
    ]
    return {
        "stock_id": stock_id,
        "symbol": symbol,
        "prices": prices,
        "indicators": [],
        "stock_meta": {"market_segment": "LISTED"},
        "adaptive_params": {
            "provenance": {"fallback": False, "source": "ml_controller_warmup"},
            "threshold_components": {"effective_delta": 0.0},
        },
        "trading_config": DEFAULT_REQUIRED_CONFIG,
        "runtime_options": {"owner": "ml_controller_warmup"},
    }


def _strategy_similarity_warmup_payload() -> dict:
    return {
        "edge_threshold": 0.1,
        "strategies": [
            {"strategy_id": "warmup_strategy_a", "family_id": "warmup", "symbols": ["2330", "2317", "2454"]},
            {"strategy_id": "warmup_strategy_b", "family_id": "warmup", "symbols": ["2330", "2317", "2308"]},
            {"strategy_id": "warmup_strategy_c", "family_id": "warmup", "symbols": ["3037", "2344", "2408"]},
        ],
    }


def _summarize_strategy_similarity_warmup_result(result) -> dict:
    if not isinstance(result, dict):
        return {
            "status": "degraded",
            "error": "invalid_strategy_similarity_evidence_result",
        }

    preflight = result.get("kmedoids_pam_preflight")
    preflight_status = result.get("kmedoids_pam_preflight_status")
    if isinstance(preflight, dict) and preflight.get("status"):
        preflight_status = preflight.get("status")

    is_official_modal = result.get("algorithm_owner") == "ml-service-modal-python"
    is_computed = result.get("status") == "computed"
    is_pam_ready = preflight_status == "pass"
    return {
        "status": "ok" if is_computed and is_official_modal and is_pam_ready else "degraded",
        "n_input": result.get("strategy_count"),
        "component_count": result.get("component_count"),
        "edge_count": result.get("edge_count"),
        "algorithm_owner": result.get("algorithm_owner"),
        "medoid_algorithm": result.get("medoid_algorithm"),
        "kmedoids_pam_preflight_status": preflight_status,
        "error": result.get("reason") or result.get("error"),
    }


@app.post("/warmup", dependencies=[Depends(verify_token)])
async def warmup():
    """Prewarm Modal hot-path inference functions before the daily pipeline."""
    from services import modal_client
    from services.state_space_series import build_state_space_series_from_payloads

    payloads = [_warmup_payload("2330", 2330), _warmup_payload("2317", 2317)]
    series = build_state_space_series_from_payloads(payloads)
    targets = {
        "predict_batch_v2": modal_client.batch_predict(payloads),
        "gnn_graphsage_universal_predict": modal_client.gnn_graphsage_batch_predict(payloads),
        "timesfm_universal_predict": modal_client.timesfm_batch_predict(series),
        "strategy_similarity_evidence": modal_client.strategy_similarity_evidence(_strategy_similarity_warmup_payload()),
    }
    results = {}
    for name, awaitable in targets.items():
        try:
            started = asyncio.get_running_loop().time()
            result = await asyncio.wait_for(awaitable, timeout=90.0)
            if name == "strategy_similarity_evidence":
                summary = _summarize_strategy_similarity_warmup_result(result)
                summary["elapsed_sec"] = round(asyncio.get_running_loop().time() - started, 3)
                results[name] = summary
                continue
            if isinstance(result, list):
                n_error = sum(1 for item in result if isinstance(item, dict) and item.get("error"))
                results[name] = {
                    "status": "ok" if n_error == 0 else "degraded",
                    "elapsed_sec": round(asyncio.get_running_loop().time() - started, 3),
                    "n_input": len(result),
                    "n_success": len(result) - n_error,
                    "n_error": n_error,
                    "error": next((item.get("error") for item in result if isinstance(item, dict) and item.get("error")), None),
                }
                continue
            results[name] = {
                "status": "ok" if not (isinstance(result, dict) and result.get("error")) else "degraded",
                "elapsed_sec": round(asyncio.get_running_loop().time() - started, 3),
                "n_input": result.get("n_input") if isinstance(result, dict) else None,
                "n_success": result.get("n_success") if isinstance(result, dict) else None,
                "error": result.get("error") if isinstance(result, dict) else None,
            }
        except Exception as exc:  # noqa: BLE001 - warmup must never be a production gate.
            results[name] = {"status": "error", "error": f"{type(exc).__name__}: {exc}"}
    return {"status": "warmup_complete", "targets": results}
