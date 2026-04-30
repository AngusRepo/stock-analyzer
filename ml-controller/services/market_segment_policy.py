"""Market-segment ML governance policy.

This module is the contract for P6 screener/ML segmentation. Emerging-board
stocks are allowed to collect ML predictions and IC evidence, but they are not
allowed to vote into execution until an explicit future promotion decision
creates a separate production policy.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any


@dataclass(frozen=True)
class SegmentMlPolicy:
    segment: str
    eligible_for_ml: bool
    eligible_for_execution: bool
    recommendation_lane: str
    serving_mode: str
    model_pool_scope: str
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
        min_ic_samples=50,
        min_active_days=20,
        notes="上市股票可進 production voting 與 pending-buy execution。",
    ),
    "OTC": SegmentMlPolicy(
        segment="OTC",
        eligible_for_ml=True,
        eligible_for_execution=True,
        recommendation_lane="tradable",
        serving_mode="production_vote",
        model_pool_scope="core_tw_equity_pool",
        min_ic_samples=50,
        min_active_days=20,
        notes="上櫃股票與上市共用核心台股 pool，但保留 segment IC 診斷。",
    ),
    "EMERGING": SegmentMlPolicy(
        segment="EMERGING",
        eligible_for_ml=True,
        eligible_for_execution=False,
        recommendation_lane="emerging_watchlist",
        serving_mode="research_only_shadow",
        model_pool_scope="emerging_research_pool",
        min_ic_samples=120,
        min_active_days=60,
        notes="興櫃只收集 prediction/IC/calibration evidence，不進 pending buy 或自動交易。",
    ),
    "UNKNOWN": SegmentMlPolicy(
        segment="UNKNOWN",
        eligible_for_ml=False,
        eligible_for_execution=False,
        recommendation_lane="research_only",
        serving_mode="blocked_until_classified",
        model_pool_scope="none",
        min_ic_samples=0,
        min_active_days=0,
        notes="未知市場別不進 ML，也不進 execution。",
    ),
}


def normalize_segment(segment: Any) -> str:
    value = str(segment or "").strip().upper()
    if value in {"TWSE", "TSE", "LISTED"}:
        return "LISTED"
    if value in {"TPEX", "OTC"}:
        return "OTC"
    if value in {"ESB", "EMERGING"}:
        return "EMERGING"
    return "UNKNOWN"


def policy_for_segment(segment: Any) -> SegmentMlPolicy:
    return SEGMENT_POLICIES[normalize_segment(segment)]


def governance_snapshot() -> dict[str, dict[str, Any]]:
    return {key: policy.to_dict() for key, policy in SEGMENT_POLICIES.items()}
