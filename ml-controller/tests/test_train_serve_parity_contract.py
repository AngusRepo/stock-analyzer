from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.market_segment_policy import policy_for_segment  # noqa: E402
from services.payload_builder import build_stock_meta_with_segment  # noqa: E402
from services.recommendation_service import _enrich_stock_meta_with_segment_policy  # noqa: E402


def test_payload_builder_and_prediction_writer_share_segment_calibration_metadata():
    payload_meta = build_stock_meta_with_segment(
        base_meta={"feature_schema_version": "v2"},
        stock={"market": "ESB"},
        latest_price={"open": None, "avg_price": 101.5},
    )
    writer_meta = _enrich_stock_meta_with_segment_policy(
        {
            "market_segment": payload_meta["market_segment"],
            "recommendation_lane": payload_meta["recommendation_lane"],
        }
    )

    parity_keys = {
        "market_segment",
        "recommendation_lane",
        "segment_model_pool_scope",
        "segment_calibration_scope",
        "segment_calibration_artifact_prefix",
        "train_serve_parity_required",
        "eligible_for_execution",
        "eligible_for_pending_buy",
    }
    assert {key: payload_meta[key] for key in parity_keys} == {key: writer_meta[key] for key in parity_keys}
    assert writer_meta["market_segment"] == "EMERGING"
    assert writer_meta["eligible_for_pending_buy"] is False


def test_segment_policy_declares_independent_calibration_scopes():
    listed = policy_for_segment("LISTED")
    otc = policy_for_segment("OTC")
    emerging = policy_for_segment("EMERGING")

    assert listed.calibration_scope == otc.calibration_scope
    assert emerging.calibration_scope != listed.calibration_scope
    assert emerging.model_pool_scope == "emerging_research_pool"
    assert emerging.eligible_for_execution is False
