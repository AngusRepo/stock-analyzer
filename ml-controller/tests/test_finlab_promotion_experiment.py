from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_promotion_experiment import (  # noqa: E402
    build_finlab_promotion_experiment_manifest,
    evaluate_finlab_promotion_lift,
)


def test_finlab_promotion_manifest_keeps_candidate_out_of_production_until_gate_passes():
    manifest = build_finlab_promotion_experiment_manifest(
        canonical_features=[f"f{i}" for i in range(106)],
        sidecar_families=[
            {"asset_key": "finlab/parity/daily_price/feature_lake", "field_count": 10},
            {"asset_key": "finlab/diversity/chip_diversity/feature_lake", "field_count": 53},
        ],
        generated_at="2026-06-06T00:00:00+00:00",
    )

    assert manifest["schema_version"] == "finlab-ml-promotion-experiment-v1"
    assert manifest["baseline_contract"]["feature_count"] == 106
    assert manifest["candidate_contract"]["name"] == "canonical_106_plus_finlab_sidecar"
    assert manifest["candidate_contract"]["production_mutation_allowed"] is False
    assert manifest["candidate_contract"]["sidecar_fields_total"] == 63
    assert "purged_cpcv" in manifest["experiment_design"]["validation"]
    assert manifest["checksum"].startswith("sha256:")


def test_finlab_promotion_lift_requires_ic_hit_rate_and_coverage_lift():
    actual = [-0.4, -0.3, -0.2, 0.1, 0.2, 0.3, 0.4]
    baseline = [0.90, 0.80, 0.70, 0.40, 0.30, 0.20, 0.10]
    candidate = [0.10, 0.20, 0.30, 0.60, 0.70, 0.80, 0.90]

    report = evaluate_finlab_promotion_lift(
        baseline_scores=baseline,
        candidate_scores=candidate,
        actual_returns=actual,
        thresholds={
            "min_ic_lift": 0.001,
            "min_hit_rate_lift": 0.0,
            "min_candidate_ic": 0.5,
            "min_coverage": 1.0,
        },
    )

    assert report["status"] == "pass"
    assert report["candidate_rank_ic"] > report["baseline_rank_ic"]
    assert report["coverage"] == 1.0

    failed = evaluate_finlab_promotion_lift(
        baseline_scores=baseline,
        candidate_scores=candidate,
        actual_returns=actual,
        coverage_mask=[True, True, False, False, True, True, True],
        thresholds={
            "min_ic_lift": 0.001,
            "min_hit_rate_lift": 0.0,
            "min_candidate_ic": 0.5,
            "min_coverage": 0.95,
        },
    )

    assert failed["status"] == "fail"
    assert "coverage_below_threshold" in failed["failed_gates"]
