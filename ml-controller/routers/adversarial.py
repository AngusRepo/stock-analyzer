"""
adversarial.py — Red-Blue Army Testing endpoints (P2#17-18)

POST /adversarial/run → Run crisis replay + synthetic stress tests
"""
import logging
from fastapi import APIRouter, Query

from graphs.adversarial_graph import run_adversarial_test

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/adversarial", tags=["adversarial"])


@router.post("/run")
def trigger_adversarial(
    scenarios: str = Query(default="all", pattern="^(historical|synthetic|all)$"),
):
    """Run Red-Blue Army adversarial tests. Returns per-scenario robustness scores."""
    logger.info(f"[Adversarial] Running {scenarios} scenarios...")
    try:
        return run_adversarial_test(scenarios)
    except Exception as e:
        logger.exception("[Adversarial] Failed")
        return {"status": "error", "error": str(e)}
