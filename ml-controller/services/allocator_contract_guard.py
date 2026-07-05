"""Allocator-contract runtime guards for replay and dry-run jobs.

The guard is intentionally separate from the allocator itself. It only blocks
side effects and constrains replay dates when an operator explicitly enables
allocator contract verification.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

ALLOCATOR_CONTRACT_GUARD_ENV = "STOCKVISION_ALLOCATOR_CONTRACT_GUARD"
ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV = "STOCKVISION_ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE"


def env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def allocator_contract_guard_enabled() -> bool:
    return env_truthy(ALLOCATOR_CONTRACT_GUARD_ENV)


def assert_allocator_contract_run_date(run_date: str, *, label: str) -> None:
    """Fail closed so allocator contract runs cannot replay arbitrary dates."""
    if not allocator_contract_guard_enabled():
        return
    allowed = os.environ.get(ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV, "").strip()
    if not allowed:
        raise RuntimeError(
            f"{label}: {ALLOCATOR_CONTRACT_ALLOWED_RUN_DATE_ENV} is required when "
            f"{ALLOCATOR_CONTRACT_GUARD_ENV}=1"
        )
    if not run_date:
        raise RuntimeError(f"{label}: explicit run_date is required for allocator contract guard")
    if run_date != allowed:
        raise RuntimeError(
            f"{label}: allocator contract run_date={run_date} blocked; allowed={allowed}"
        )
    logger.warning(
        "[AllocatorContractGuard] %s enabled for run_date=%s; callbacks and writes must be no-op",
        label,
        run_date,
    )
