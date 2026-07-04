"""Sizing-canary runtime guards for Cloud Run Job replay tests."""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)


def env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def sizing_canary_enabled() -> bool:
    return env_truthy("STOCKVISION_SIZING_CANARY")


def assert_allowed_run_date(run_date: str, *, label: str) -> None:
    """Fail closed so canary jobs cannot accidentally replay arbitrary dates."""
    if not sizing_canary_enabled():
        return
    allowed = os.environ.get("STOCKVISION_CANARY_ALLOWED_RUN_DATE", "").strip()
    if not allowed:
        raise RuntimeError(
            f"{label}: STOCKVISION_CANARY_ALLOWED_RUN_DATE is required when "
            "STOCKVISION_SIZING_CANARY=1"
        )
    if not run_date:
        raise RuntimeError(f"{label}: explicit run_date is required for sizing canary")
    if run_date != allowed:
        raise RuntimeError(
            f"{label}: sizing canary run_date={run_date} blocked; allowed={allowed}"
        )
    logger.warning(
        "[SizingCanary] %s enabled for run_date=%s; callbacks and writes must be no-op",
        label,
        run_date,
    )
