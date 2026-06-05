"""Controller-side screener sizing policy shared by daily pipeline nodes."""

from __future__ import annotations

from typing import Any


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        n = float(value)
        if n == n and n not in (float("inf"), float("-inf")):
            return n
    return None


def _clamp(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def _positive_int(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    n = _finite_number(value)
    if n is None:
        return fallback
    return _clamp(round(n), minimum, maximum)


def _ratio(value: Any, fallback: float, minimum: float, maximum: float) -> float:
    n = _finite_number(value)
    if n is None:
        return fallback
    return max(minimum, min(maximum, float(n)))


def _adaptive_delta(base: int, delta: Any, minimum: int, maximum: int) -> int:
    n = _finite_number(delta)
    if n is None:
        return _positive_int(base, base, minimum, maximum)
    return _positive_int(base + n, base, minimum, maximum)


def _first_present(raw: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in raw:
            return raw[key]
    return None


def resolve_controller_screener_sizing(
    trading_config: dict[str, Any] | None,
    adaptive_params: dict[str, Any] | None = None,
) -> dict[str, int | float]:
    """Mirror Worker screener sizing semantics for controller-side ML gates."""
    config = trading_config if isinstance(trading_config, dict) else {}
    raw = config.get("screener") if isinstance(config.get("screener"), dict) else {}
    adaptive = adaptive_params if isinstance(adaptive_params, dict) else {}
    adaptive_screener = adaptive.get("screener") if isinstance(adaptive.get("screener"), dict) else {}

    candidate_pool_base = _positive_int(
        _first_present(raw, "candidatePoolSize", "candidate_pool_size"),
        200,
        180,
        240,
    )
    coarse_ml_queue_base = _positive_int(
        _first_present(raw, "coarseMlQueueSize", "coarse_ml_queue_size"),
        80,
        30,
        160,
    )
    coarse_ml_keep_ratio = _ratio(
        _first_present(raw, "coarseMlKeepRatio", "coarse_ml_keep_ratio"),
        0.75,
        0.25,
        1.0,
    )
    ml_shortlist_base = _positive_int(
        _first_present(
            raw,
            "mlShortlistSize",
            "ml_shortlist_size",
            "maxCandidates",
            "max_candidates",
        ),
        35,
        15,
        80,
    )
    emerging_research_base = _positive_int(
        _first_present(
            raw,
            "emergingResearchSize",
            "emerging_research_size",
            "emergingMaxCandidates",
            "emerging_max_candidates",
        ),
        24,
        0,
        80,
    )

    candidate_pool_size = _adaptive_delta(
        candidate_pool_base,
        adaptive_screener.get("candidate_pool_delta"),
        180,
        240,
    )
    coarse_ml_queue_size = min(
        _adaptive_delta(
            coarse_ml_queue_base,
            adaptive_screener.get("coarse_ml_queue_delta"),
            30,
            160,
        ),
        candidate_pool_size,
    )
    ml_shortlist_size = min(
        _adaptive_delta(
            ml_shortlist_base,
            adaptive_screener.get("ml_shortlist_delta"),
            15,
            80,
        ),
        coarse_ml_queue_size,
    )
    emerging_research_size = _adaptive_delta(
        emerging_research_base,
        adaptive_screener.get("emerging_research_delta"),
        0,
        80,
    )

    explicit_core_family_raw = _first_present(raw, "coreFamilyRankSize", "core_family_rank_size")
    if explicit_core_family_raw is None:
        core_family_rank_size = ml_shortlist_size
    else:
        core_family_rank_size = min(
            _positive_int(explicit_core_family_raw, ml_shortlist_size, 15, 80),
            coarse_ml_queue_size,
        )

    return {
        "candidate_pool_size": candidate_pool_size,
        "coarse_ml_queue_size": coarse_ml_queue_size,
        "coarse_ml_keep_ratio": coarse_ml_keep_ratio,
        "ml_shortlist_size": ml_shortlist_size,
        "core_family_rank_size": core_family_rank_size,
        "emerging_research_size": emerging_research_size,
    }
