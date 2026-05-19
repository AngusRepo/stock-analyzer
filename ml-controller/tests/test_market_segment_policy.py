from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.market_segment_policy import (  # noqa: E402
    governance_snapshot,
    normalize_segment,
    policy_for_segment,
)


def test_emerging_policy_is_research_only_but_ml_eligible():
    policy = policy_for_segment("EMERGING")

    assert policy.eligible_for_ml is True
    assert policy.eligible_for_execution is False
    assert policy.recommendation_lane == "emerging_watchlist"
    assert policy.serving_mode == "research_only_shadow"
    assert policy.model_pool_scope == "emerging_research_pool"
    assert policy.calibration_scope == "emerging_research"
    assert policy.calibration_artifact_prefix == "calibration/emerging_research"
    assert policy.train_serve_parity_required is True
    assert policy.min_ic_samples > policy_for_segment("LISTED").min_ic_samples


def test_segment_aliases_are_normalized():
    assert normalize_segment("TWSE") == "LISTED"
    assert normalize_segment("sii") == "LISTED"
    assert normalize_segment("TPEX") == "OTC"
    assert normalize_segment("ESB") == "EMERGING"
    assert normalize_segment("rotc") == "EMERGING"
    assert normalize_segment("pub") == "UNKNOWN"
    assert normalize_segment("") == "UNKNOWN"


def test_governance_snapshot_is_explicit_for_ui_and_ops():
    snapshot = governance_snapshot()

    assert snapshot["LISTED"]["serving_mode"] == "production_vote"
    assert snapshot["LISTED"]["calibration_scope"] == "core_tw_equity"
    assert snapshot["OTC"]["model_pool_scope"] == "core_tw_equity_pool"
    assert snapshot["EMERGING"]["eligible_for_execution"] is False
    assert snapshot["EMERGING"]["calibration_scope"] != snapshot["LISTED"]["calibration_scope"]
    assert snapshot["UNKNOWN"]["eligible_for_ml"] is False
