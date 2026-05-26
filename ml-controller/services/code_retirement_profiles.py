"""Known baseline profiles for code retirement review."""

from __future__ import annotations

from typing import Any


SCHEMA_VERSION = "code-retirement-profile-v1"


RETIREMENT_PROFILES: dict[str, dict[str, Any]] = {
    "predict_then_optimize": {
        "owner_tokens": ["predict_then_optimize", "eligible_to_replace_predict_then_optimize"],
        "rollback_path": "ml-controller/services/direct_allocation_benchmark.py",
    },
    "rank_topk": {
        "owner_tokens": ["rank_topk", "rank_topk_equal_weight", "allocate_rank_topk_equal_weight"],
        "rollback_path": "ml-controller/services/portfolio_allocation.py",
    },
    "rank_topk_equal_weight": {
        "owner_tokens": ["rank_topk", "rank_topk_equal_weight", "allocate_rank_topk_equal_weight"],
        "rollback_path": "ml-controller/services/portfolio_allocation.py",
    },
    "market_regime_state": {
        "owner_tokens": ["market_regime_state", "current_market_regime_state"],
        "rollback_path": "ml-controller/services/market_state_benchmark.py",
    },
}


def _as_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _clean_text(value: object, default: str = "") -> str:
    text = str(value or "").strip()
    return text or default


def _baseline_id(packet: dict[str, Any]) -> str:
    retirement = _as_dict(packet.get("baseline_retirement"))
    return _clean_text(retirement.get("target"), _clean_text(packet.get("baseline_id"), "unknown"))


def _candidate_id(packet: dict[str, Any]) -> str:
    return _clean_text(packet.get("candidate_id"), "unknown")


def resolve_code_retirement_profile(
    *,
    adoption_decision_packet: dict[str, Any],
    candidate_paths: list[str] | None = None,
    owner_tokens: list[str] | None = None,
    replacement_owner: str | None = None,
    rollback_path: str = "",
) -> dict[str, Any]:
    packet = _as_dict(adoption_decision_packet)
    baseline = _baseline_id(packet)
    profile = RETIREMENT_PROFILES.get(baseline, {})
    source = "registry" if profile else "fallback"
    overrides: list[str] = []
    blockers: list[str] = []

    resolved_candidate_paths = candidate_paths if candidate_paths is not None else profile.get("candidate_paths")
    if candidate_paths is not None:
        overrides.append("candidate_paths")

    resolved_owner_tokens = owner_tokens if owner_tokens is not None else profile.get("owner_tokens", [baseline])
    if owner_tokens is not None:
        overrides.append("owner_tokens")

    resolved_replacement_owner = _clean_text(
        replacement_owner,
        _clean_text(profile.get("replacement_owner"), _candidate_id(packet)),
    )
    if replacement_owner is not None:
        overrides.append("replacement_owner")

    resolved_rollback_path = _clean_text(rollback_path, _clean_text(profile.get("rollback_path")))
    if rollback_path:
        overrides.append("rollback_path")
    if source == "fallback":
        if owner_tokens is None:
            blockers.append("profile_registry_missing")
        if not resolved_rollback_path:
            blockers.append("rollback_path_missing_for_fallback_profile")

    return {
        "schema_version": SCHEMA_VERSION,
        "profile_id": baseline,
        "source": source,
        "baseline_id": baseline,
        "candidate_id": _candidate_id(packet),
        "candidate_paths": resolved_candidate_paths,
        "owner_tokens": list(resolved_owner_tokens or [baseline]),
        "replacement_owner": resolved_replacement_owner,
        "rollback_path": resolved_rollback_path,
        "overrides": overrides,
        "blockers": blockers,
    }
