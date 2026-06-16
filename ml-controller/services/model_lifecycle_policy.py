"""Shared runtime policy for model lifecycle status handling."""

from __future__ import annotations

from typing import Any


DEFAULT_DEGRADED_DAMPENING = 0.1


def resolve_degraded_dampening(trading_cfg: dict[str, Any] | None) -> float:
    """Return degraded model dampening from trading config, defaulting low."""
    ml_pool = (trading_cfg or {}).get("mlPool")
    raw = ml_pool.get("degradedDampening") if isinstance(ml_pool, dict) else None
    try:
        return float(raw if raw is not None else DEFAULT_DEGRADED_DAMPENING)
    except (TypeError, ValueError):
        return DEFAULT_DEGRADED_DAMPENING
