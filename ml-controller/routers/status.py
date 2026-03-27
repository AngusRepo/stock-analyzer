"""
routers/status.py — GET /model-status

回傳 Controller 版本 + ML Service 連線狀態。
"""
import os
import logging
import httpx
from fastapi import APIRouter

logger = logging.getLogger(__name__)
router = APIRouter()

_VERSION        = "12.2.0"
_ML_SERVICE_URL = os.environ.get("ML_SERVICE_URL", "")
_USE_MODAL      = bool(os.environ.get("MODAL_TOKEN_ID", ""))


@router.get("/model-status")
async def get_model_status():
    backend = "modal" if _USE_MODAL else ("cloud_run" if _ML_SERVICE_URL else "none")
    ml_health = {"status": "unknown"}

    if _ML_SERVICE_URL:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"{_ML_SERVICE_URL}/health")
                ml_health = resp.json() if resp.status_code == 200 else {"status": "error", "http": resp.status_code}
        except Exception as e:
            ml_health = {"status": "error", "message": str(e)}

    return {
        "version":    _VERSION,
        "backend":    backend,
        "ml_service": ml_health,
        "overall":    "ok" if ml_health.get("status") == "ok" else "degraded",
    }
