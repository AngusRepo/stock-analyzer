from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.active_model_policy import ACTIVE_ALPHA_MODELS  # noqa: E402
from services.active8_score_semantics import (  # noqa: E402
    MODEL_SCORE_SEMANTIC_VERSION,
    MODEL_TARGET_SEMANTIC_VERSION,
    normalize_active8_cross_sectional_scores,
)


def _prediction(value: float, market: str = "TWSE") -> dict:
    return {
        "stock_meta": {"market": market},
        "rank_scores": {
            "LightGBM": value,
            "XGBoost": value,
            "ExtraTrees": value,
            "TabM": value,
            "GNN": value,
        },
        "dlinear": {"forecast_pct": value - 0.5},
        "patchtst": {"forecast_pct": value - 0.5},
        "itransformer": {"forecast_pct": value - 0.5},
    }


def test_active8_scores_are_same_market_percentiles_with_raw_sequence_preserved():
    predictions = {
        "A": _prediction(0.2),
        "B": _prediction(0.5),
        "C": _prediction(0.8),
    }
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-15",
    )

    assert summary["complete_symbols"] == 3
    assert predictions["A"]["rank_scores"]["DLinear"] == 0.0
    assert predictions["B"]["rank_scores"]["DLinear"] == 0.5
    assert predictions["C"]["rank_scores"]["DLinear"] == 1.0
    assert predictions["A"]["dlinear"]["forecast_pct"] == -0.3
    assert predictions["C"]["model_score_lineage"]["semantic_version"] == MODEL_SCORE_SEMANTIC_VERSION
    assert predictions["C"]["model_score_lineage"]["complete"] is True


def test_active8_scores_do_not_rank_across_market_segments():
    predictions = {
        "L1": _prediction(0.1, "TWSE"),
        "L2": _prediction(0.5, "TWSE"),
        "L3": _prediction(0.9, "TWSE"),
        "O1": _prediction(0.2, "OTC"),
        "O2": _prediction(0.4, "OTC"),
    }
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-15",
    )

    assert summary["complete_symbols"] == 3
    assert predictions["L3"]["rank_scores"]["XGBoost"] == 1.0
    assert predictions["O1"]["rank_scores"] == {}
    assert "rank_missing:XGBoost" in predictions["O1"]["model_score_lineage"]["blockers"]


def test_active8_lineage_rejects_unproven_artifact_target_semantic():
    predictions = {"A": _prediction(0.2), "B": _prediction(0.5), "C": _prediction(0.8)}
    versions = {name: f"{name}-v1" for name in ACTIVE_ALPHA_MODELS}
    target_semantics = {name: MODEL_TARGET_SEMANTIC_VERSION for name in ACTIVE_ALPHA_MODELS}
    target_semantics["PatchTST"] = ""

    summary = normalize_active8_cross_sectional_scores(
        predictions,
        artifact_versions=versions,
        artifact_target_semantics=target_semantics,
        run_date="2026-07-15",
    )

    assert summary["complete_symbols"] == 0
    assert predictions["A"]["model_score_lineage"]["complete"] is False
    assert "artifact_target_semantic_mismatch:PatchTST:missing" in (
        predictions["A"]["model_score_lineage"]["blockers"]
    )
