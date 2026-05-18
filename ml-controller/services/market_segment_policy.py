"""Market-segment ML governance policy.

This module is the P6 contract for screener/ML segmentation. Emerging-board
stocks may collect ML predictions, IC evidence, and calibration evidence, but
they must not vote into execution or create pending buys.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class SegmentMlPolicy:
    segment: str
    eligible_for_ml: bool
    eligible_for_execution: bool
    recommendation_lane: str
    serving_mode: str
    model_pool_scope: str
    calibration_scope: str
    calibration_artifact_prefix: str
    train_serve_parity_required: bool
    min_ic_samples: int
    min_active_days: int
    notes: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


SEGMENT_POLICIES: dict[str, SegmentMlPolicy] = {
    "LISTED": SegmentMlPolicy(
        segment="LISTED",
        eligible_for_ml=True,
        eligible_for_execution=True,
        recommendation_lane="tradable",
        serving_mode="production_vote",
        model_pool_scope="core_tw_equity_pool",
        calibration_scope="core_tw_equity",
        calibration_artifact_prefix="calibration/core_tw_equity",
        train_serve_parity_required=True,
        min_ic_samples=50,
        min_active_days=20,
        notes="Listed stocks use the core Taiwan equity production pool.",
    ),
    "OTC": SegmentMlPolicy(
        segment="OTC",
        eligible_for_ml=True,
        eligible_for_execution=True,
        recommendation_lane="tradable",
        serving_mode="production_vote",
        model_pool_scope="core_tw_equity_pool",
        calibration_scope="core_tw_equity",
        calibration_artifact_prefix="calibration/core_tw_equity",
        train_serve_parity_required=True,
        min_ic_samples=50,
        min_active_days=20,
        notes="OTC stocks share the production pool but keep segment IC diagnostics.",
    ),
    "EMERGING": SegmentMlPolicy(
        segment="EMERGING",
        eligible_for_ml=True,
        eligible_for_execution=False,
        recommendation_lane="emerging_watchlist",
        serving_mode="research_only_shadow",
        model_pool_scope="emerging_research_pool",
        calibration_scope="emerging_research",
        calibration_artifact_prefix="calibration/emerging_research",
        train_serve_parity_required=True,
        min_ic_samples=120,
        min_active_days=60,
        notes="Emerging stocks collect prediction, IC, and calibration evidence but never enter pending buys.",
    ),
    "UNKNOWN": SegmentMlPolicy(
        segment="UNKNOWN",
        eligible_for_ml=False,
        eligible_for_execution=False,
        recommendation_lane="research_only",
        serving_mode="blocked_until_classified",
        model_pool_scope="none",
        calibration_scope="none",
        calibration_artifact_prefix="",
        train_serve_parity_required=False,
        min_ic_samples=0,
        min_active_days=0,
        notes="Unclassified stocks are blocked from ML and execution until classified.",
    ),
}


def normalize_segment(segment: Any) -> str:
    value = str(segment or "").strip().upper()
    if value in {"TWSE", "TSE", "LISTED", "SII"}:
        return "LISTED"
    if value in {"TPEX", "OTC"}:
        return "OTC"
    if value in {"ESB", "EMERGING", "ROTC"}:
        return "EMERGING"
    return "UNKNOWN"


def policy_for_segment(segment: Any) -> SegmentMlPolicy:
    return SEGMENT_POLICIES[normalize_segment(segment)]


def governance_snapshot() -> dict[str, dict[str, Any]]:
    return {key: policy.to_dict() for key, policy in SEGMENT_POLICIES.items()}
