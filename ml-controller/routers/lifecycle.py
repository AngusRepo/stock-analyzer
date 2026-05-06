"""Compatibility routes for model lifecycle management.

The ML Pool is the lifecycle source of truth. Keep /lifecycle/check only as a
thin adapter for old callers; new callers should use /model_pool/promote_check.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Query

from routers.model_pool import PromoteCheckRequest, promote_check

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/lifecycle", tags=["lifecycle"])


@router.post("/check")
async def trigger_lifecycle_check(
    degrade: float = Query(default=0.45, ge=0.30, le=0.55),
    restore: float = Query(default=0.55, ge=0.45, le=0.70),
):
    """Deprecated adapter that delegates to the model_pool lifecycle owner."""
    logger.info(
        "[Lifecycle] Compatibility route delegated to model_pool; "
        "degrade=%s restore=%s",
        degrade,
        restore,
    )
    try:
        result = await promote_check(PromoteCheckRequest(apply=True, confirm=True))
        result["legacy_route"] = "/lifecycle/check"
        result["delegated_to"] = "/model_pool/promote_check"
        return result
    except Exception as e:
        logger.exception("[Lifecycle] Check failed")
        return {"status": "error", "error": str(e)}
