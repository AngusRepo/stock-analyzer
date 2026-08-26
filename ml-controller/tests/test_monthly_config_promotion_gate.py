from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import model_artifact_registry as registry  # noqa: E402
from services.active8_release_model_profiles import model_profile  # noqa: E402
from services.active8_release_training_contract import (  # noqa: E402
    build_model_training_config_attestation,
    build_release_training_contract,
)


def _promotion_row(*, attestation: dict | None, pbo: dict | None = None) -> dict:
    metadata = {
        "target_semantic_version": registry.ACTIVE8_TARGET_SEMANTIC_VERSION,
        "model_training_config_attestation": attestation,
    }
    offline = {
        "registration": {"metadata": metadata},
        "model_cpcv": {
            "decision": "PASS",
            "folds": 6,
            "min_test_rows": 180,
            "oos_ic_mean": 0.08,
            "oos_ic_std": 0.04,
            "positive_fold_ratio": 0.83,
            "coverage_mean": 0.92,
        },
        "deflated_sharpe": {"decision": "PASS", "value": 1.2},
        "monte_carlo": {"decision": "PASS", "mdd_95th": 0.12},
    }
    if pbo is not None:
        offline["pbo"] = pbo
    return {
        "artifact_id": "LightGBM:vMonthly:monthly_release",
        "model_name": "LightGBM",
        "candidate_type": "monthly_release",
        "state": "live_gate_passed",
        "offline_gate_decision": "STRONG_PASS",
        "live_gate_status": "passed",
        "source_run_date": "2026-08-24",
        "trained_from_snapshot": json.dumps({"snapshot_id": "snapshot-2026-08-24"}),
        "offline_evidence_json": json.dumps(offline),
        "live_evidence_json": json.dumps({
            "decision": {"metrics": {"shadow_samples": 250, "production_samples": 250, "min_samples": 50}}
        }),
    }


def _valid_attestation() -> dict:
    contract = build_release_training_contract(
        run_date="2026-08-24",
        dataset_snapshot={"business_date": "2026-08-24", "snapshot_id": "snapshot-2026-08-24"},
        producer_source_sha="0123456789abcdef0123456789abcdef01234567",
    )
    return build_model_training_config_attestation(
        contract=contract,
        model_name="LightGBM",
        effective_config=model_profile("LightGBM")["required_effective_config"],
    )


def _retired_valid_monthly_fixed_config_attestation_makes_model_selection_pbo_not_applicable():
    codes = {
        blocker["code"]
        for blocker in registry.artifact_promotion_blockers(
            _promotion_row(attestation=_valid_attestation()),
            champion_version="vOld",
        )
    }

    assert "monthly_training_config_attestation_missing_or_invalid" not in codes
    assert "pbo_threshold_missing" not in codes


def _retired_missing_or_tampered_monthly_attestation_cannot_bypass_pbo():
    attestation = _valid_attestation()
    attestation["effective_config"]["estimator_params"]["n_estimators"] = 801
    codes = {
        blocker["code"]
        for blocker in registry.artifact_promotion_blockers(
            _promotion_row(attestation=attestation),
            champion_version="vOld",
        )
    }

    assert "monthly_training_config_attestation_missing_or_invalid" in codes
    assert "pbo_threshold_missing" in codes


def _retired_multi_trial_pbo_must_be_model_specific_not_cohort_owned():
    row = _promotion_row(
        attestation=None,
        pbo={
            "pbo": 0.20,
            "method": "cscv_rank_logit",
            "search_trials": 8,
            "selection_scope": "cohort_model_selection_process",
            "model_name": "Active8",
        },
    )
    row["candidate_type"] = "weekly_drift"
    codes = {
        blocker["code"]
        for blocker in registry.artifact_promotion_blockers(row, champion_version="vOld")
    }

    assert "pbo_model_selection_lineage_invalid" in codes
