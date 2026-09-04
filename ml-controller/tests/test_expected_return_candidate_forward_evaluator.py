from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.expected_return_artifact_identity import (
    attach_expected_return_artifact_identity,
)
from services.expected_return_candidate_forward_evaluator import (
    _candidate_rows,
    _daily_evaluations,
    _l4_evidence_payload,
    _preoutcome_locked_rows,
    _persist_evaluations,
    _promotion_gate,
    _operational_parity_rows,
    evaluate_expected_return_candidates_forward,
)


def test_operational_parity_uses_pit_snapshot_without_future_outcomes() -> None:
    rows = _operational_parity_rows([{
        "snapshot_date": "2026-08-25",
        "score_components": "score",
        "forecast_data": "forecast",
        "alpha_context": "context",
        "l4_executable_return_pct": 0.12,
        "label_known_date": "2026-09-01",
        "target_return": 0.12,
        "target": 0.12,
    }])

    assert rows == [{
        "snapshot_date": "2026-08-25",
        "score_components": "score",
        "forecast_data": "forecast",
        "alpha_context": "context",
    }]


class _Blob:
    def __init__(self, raw: bytes):
        self.raw = raw

    def download_as_bytes(self) -> bytes:
        return self.raw


class _Bucket:
    def __init__(self, payloads: dict[str, bytes]):
        self.payloads = payloads

    def blob(self, path: str) -> _Blob:
        return _Blob(self.payloads[path])


def _candidate(owner: str, source_date: str = "2026-08-30") -> tuple[dict[str, Any], bytes]:
    version = (
        "l4-alpha-ev-ridge-v5-sector-20260830"
        if owner == "l4_alpha_ev"
        else "allocator-ev-fusion-residual-v14-20260830"
    )
    artifact: dict[str, Any] = {
        "expected_return_owner": owner,
        "model_version": version,
        "artifact_contract_version": "test-contract-v1",
        "feature_semantic_version": "formal137-pit-rolling-rank-and-imputation-v2",
        "label_schema_version": "test-label-v1",
        "trained_until": "2026-08-18",
        "horizon_days": 5,
        "cost_model_bps": 18.0,
        "output_is_net_of_costs": True,
        "feature_names": ["x"],
        "training_data": {
            "cohort_id": "cohort-1",
            "generation_mode": "purged_oof",
        },
    }
    if owner == "l4_alpha_ev":
        artifact.update({
            "resolver_method": "ridge",
            "intercept": 0.0,
            "coefficients": {"x": 1.0},
            "output_clip": {"min": -0.08, "max": 0.08},
        })
    else:
        artifact.update({
            "expected_return_semantic": "l4_plus_residual",
            "base_expected_return_owner": "l4_alpha_ev",
            "policy_value_heads": ["residual_adjustment_model"],
            "residual_adjustment_model": {
                "intercept": 0.0,
                "coefficients": {"x": 0.2},
            },
            "residual_output_clip": {"min": -0.02, "max": 0.02},
        })
    attach_expected_return_artifact_identity(artifact)
    packet = {
        "cohort_id": "cohort-1",
        "artifact": artifact,
        "validation_packet": {"decision": "PASS", "failed_gates": []},
        "operational_parity": {
            "schema_version": "ev-operational-parity-v2",
            "owner_decisions": {
                "l4_alpha_ev": {"decision": "PASS", "failed_gates": []},
                "allocator_ev_fusion": {"decision": "PASS", "failed_gates": []},
            },
        },
    }
    raw = json.dumps(packet, sort_keys=True).encode("utf-8")
    checksum = hashlib.sha256(raw).hexdigest()
    row = {
        "artifact_id": f"{owner}:{version}:{checksum}",
        "model_name": owner,
        "version": version,
        "state": "offline_passed",
        "artifact_path": f"candidate/{owner}.json",
        "checksum": checksum,
        "source_run_date": source_date,
        "offline_gate_decision": "PASS",
        "offline_gate_failed_gates": "[]",
        "training_run_id": "active8_oof:cohort-1",
        "updated_at": "2026-08-30T12:00:00Z",
    }
    return row, raw


def test_daily_direction_metrics_treat_higher_prediction_as_higher_return() -> None:
    candidate = {
        "registry": {"artifact_id": "candidate"},
        "identity": {"model_fingerprint": "f" * 64},
    }
    samples = [
        {
            "date": "2026-08-31",
            "target": float(index),
            "source_row": {"label_known_date": "2026-09-07"},
        }
        for index in range(30)
    ]
    positive = _daily_evaluations(
        owner="l4_alpha_ev",
        candidate=candidate,
        samples=samples,
        predictions=[float(index) for index in range(30)],
        baseline_predictions=[float(index) * 0.5 for index in range(30)],
    )[0]
    reversed_direction = _daily_evaluations(
        owner="l4_alpha_ev",
        candidate=candidate,
        samples=samples,
        predictions=[float(-index) for index in range(30)],
        baseline_predictions=[float(index) * 0.5 for index in range(30)],
    )[0]

    assert positive["prediction_corr"] == pytest.approx(1.0)
    assert positive["corr_delta"] == pytest.approx(0.0)
    assert positive["baseline_owner"] == "formal_ml_buy_admission:ensemble_directional_margin"
    assert positive["spread"] > 0.0
    assert positive["quality_decision"] == "PASS"
    assert reversed_direction["prediction_corr"] == pytest.approx(-1.0)
    assert reversed_direction["spread"] < 0.0
    assert reversed_direction["quality_decision"] == "DEGRADED"


def test_exact_l4_candidate_lineage_keeps_real_trained_until() -> None:
    row, raw = _candidate("l4_alpha_ev")
    packet = json.loads(raw)
    candidate = {
        "registry": row,
        "artifact": packet["artifact"],
    }
    sample = {
        "date": "2026-08-31",
        "source_row": {
            "cohort_id": "cohort-1",
            "fold_id": "frozen_forward",
            "source_manifest_checksum": "a" * 64,
        },
    }

    payload = _l4_evidence_payload(sample, candidate, 0.01)

    assert payload["trained_until"] == "2026-08-18"
    assert payload["point_in_time_prediction_lineage"]["trained_until"] == "2026-08-18"
    assert payload["point_in_time_prediction_lineage"]["candidate_source_run_date"] == "2026-08-30"


def test_promotion_gate_requires_preoutcome_locked_dates_and_both_evidence_lanes() -> None:
    row, raw = _candidate("l4_alpha_ev")
    packet = json.loads(raw)
    candidate = {
        "registry": row,
        "packet": packet,
        "artifact": packet["artifact"],
        "identity": {
            "model_fingerprint": packet["artifact"]["model_fingerprint"],
        },
        "checksum": row["checksum"],
        "selection_semantic_floor_date": "2026-08-25",
    }
    rows = [
        {
            "prediction_date": f"2026-09-{day:02d}",
            "label_known_date": f"2026-09-{day + 10:02d}",
            "quality_decision": "PASS",
            "prediction_corr": 0.2,
            "baseline_corr": 0.1,
            "corr_delta": 0.1,
            "spread": 0.01,
            "baseline_spread": 0.005,
            "spread_delta": 0.005,
            "top_return": 0.02,
        }
        for day in range(1, 11)
    ]

    early_gate = _promotion_gate(rows[:5], owner="l4_alpha_ev", candidate=candidate)
    assert early_gate["decision"] == "PENDING"
    assert early_gate["maturity_blockers"] == ["prospective_date_count_below_floor"]

    gate = _promotion_gate(rows, owner="l4_alpha_ev", candidate=candidate)
    assert gate["decision"] == "PASS"
    assert gate["evaluable_date_count"] == 10
    assert gate["baseline_owner"] == "formal_ml_buy_admission:ensemble_directional_margin"
    assert gate["comparison_mode"] == "same_prediction_date_paired_cross_section"

    candidate["registry"] = {
        **row,
        "offline_gate_decision": "FAIL",
        "offline_gate_failed_gates": '["insufficient_dates"]',
    }
    candidate["packet"] = {
        **packet,
        "validation_packet": {"decision": "FAIL", "failed_gates": ["insufficient_dates"]},
    }
    assert "offline_admission_not_pass" in _promotion_gate(
        rows, owner="l4_alpha_ev", candidate=candidate
    )["failed_gates"]

    candidate["registry"] = row
    candidate["packet"] = {
        **packet,
        "validation_packet": {"decision": "FAIL", "failed_gates": ["quality"]},
    }
    assert "offline_admission_not_pass" in _promotion_gate(
        rows, owner="l4_alpha_ev", candidate=candidate
    )["failed_gates"]

    candidate["packet"] = packet
    candidate["operational_parity"] = {
        "schema_version": "ev-operational-parity-v2",
        "owner_decisions": {
            "l4_alpha_ev": {
                "decision": "FAIL",
                "failed_gates": ["training_serving_feature_mismatch"],
            },
        },
    }
    assert "owner_operational_parity_not_pass" in _promotion_gate(
        rows, owner="l4_alpha_ev", candidate=candidate
    )["failed_gates"]
    early_parity_gate = _promotion_gate(
        rows[:5], owner="l4_alpha_ev", candidate=candidate
    )
    assert early_parity_gate["decision"] == "PENDING"
    assert early_parity_gate["deferred_contract_blockers"] == [
        "owner_operational_parity_not_pass"
    ]


def test_promotion_gate_holds_inconclusive_candidate_after_ten_dates() -> None:
    row, raw = _candidate("l4_alpha_ev")
    packet = json.loads(raw)
    candidate = {
        "registry": row,
        "packet": packet,
        "artifact": packet["artifact"],
        "identity": {"model_fingerprint": packet["artifact"]["model_fingerprint"]},
        "checksum": row["checksum"],
        "selection_semantic_floor_date": "2026-08-25",
    }
    rows = [
        {
            "prediction_date": f"2026-09-{day:02d}",
            "label_known_date": f"2026-09-{day + 10:02d}",
            "quality_decision": "DEGRADED",
            "corr_delta": 0.1 if day % 2 else -0.1,
            "spread_delta": 0.01 if day % 2 else -0.01,
            "top_return": 0.02,
        }
        for day in range(1, 11)
    ]
    gate = _promotion_gate(rows, owner="l4_alpha_ev", candidate=candidate)
    assert gate["decision"] == "HOLD"
    assert gate["confidently_harmful"] is False
    assert gate["maximum_window_exhausted"] is False

    exhausted = _promotion_gate(rows * 3, owner="l4_alpha_ev", candidate=candidate)
    assert exhausted["decision"] == "FAIL"
    assert exhausted["maximum_window_exhausted"] is True


def test_candidate_lane_keeps_oldest_shadowing_pair_when_new_weekly_pair_arrives() -> None:
    new_l4, _ = _candidate("l4_alpha_ev", "2026-08-30")
    new_fusion, _ = _candidate("allocator_ev_fusion", "2026-08-30")
    new_l4["training_run_id"] = "active8_oof:cohort-2"
    new_fusion["training_run_id"] = "active8_oof:cohort-2"
    active_l4, _ = _candidate("l4_alpha_ev", "2026-08-29")
    active_fusion, _ = _candidate("allocator_ev_fusion", "2026-08-29")
    active_l4["state"] = "shadowing"
    active_fusion["state"] = "shadowing"

    selected, activate = _candidate_rows(
        lambda _sql, _params: [new_l4, new_fusion, active_l4, active_fusion],
        "cohort-2",
    )

    assert selected["l4_alpha_ev"]["source_run_date"] == "2026-08-29"
    assert selected["allocator_ev_fusion"]["source_run_date"] == "2026-08-29"
    assert activate == {"l4_alpha_ev": False, "allocator_ev_fusion": False}


def test_candidate_lane_starts_oldest_base_bound_pair_not_daily_replay_artifact() -> None:
    causal_l4, _ = _candidate("l4_alpha_ev", "2026-08-30")
    causal_fusion, _ = _candidate("allocator_ev_fusion", "2026-08-30")
    replay_l4, _ = _candidate("l4_alpha_ev", "2026-09-04")
    replay_fusion, _ = _candidate("allocator_ev_fusion", "2026-09-04")
    drift_l4, _ = _candidate("l4_alpha_ev", "2026-08-28")
    drift_fusion, _ = _candidate("allocator_ev_fusion", "2026-08-28")
    for row in (causal_l4, causal_fusion, replay_l4, replay_fusion):
        row["artifact_trained_until"] = "2026-08-18"
    for row in (drift_l4, drift_fusion):
        row["artifact_trained_until"] = "2026-08-28"

    selected, activate = _candidate_rows(
        lambda _sql, _params: [
            replay_l4,
            replay_fusion,
            causal_l4,
            causal_fusion,
            drift_l4,
            drift_fusion,
        ],
        "cohort-1",
        expected_trained_until="2026-08-18",
    )

    assert selected["l4_alpha_ev"]["source_run_date"] == "2026-08-30"
    assert selected["allocator_ev_fusion"]["source_run_date"] == "2026-08-30"
    assert activate == {"l4_alpha_ev": True, "allocator_ev_fusion": True}


def test_candidate_lane_skips_newer_offline_failed_pair() -> None:
    failed_l4, _ = _candidate("l4_alpha_ev", "2026-08-30")
    failed_fusion, _ = _candidate("allocator_ev_fusion", "2026-08-30")
    failed_l4["state"] = "offline_failed"
    failed_l4["offline_gate_decision"] = "FAIL"
    failed_l4["offline_gate_failed_gates"] = '["insufficient_dates"]'
    failed_fusion["state"] = "offline_failed"
    failed_fusion["offline_gate_decision"] = "FAIL"
    failed_fusion["offline_gate_failed_gates"] = '["feature_contract_invalid"]'
    older_l4, _ = _candidate("l4_alpha_ev", "2026-08-29")
    older_fusion, _ = _candidate("allocator_ev_fusion", "2026-08-29")

    selected, activate = _candidate_rows(
        lambda _sql, _params: [failed_l4, failed_fusion, older_l4, older_fusion],
        "cohort-1",
    )

    assert selected["l4_alpha_ev"]["source_run_date"] == "2026-08-29"
    assert selected["allocator_ev_fusion"]["source_run_date"] == "2026-08-29"
    assert activate == {"l4_alpha_ev": True, "allocator_ev_fusion": True}


def test_candidate_lane_observes_complete_offline_failed_pair_without_activation() -> None:
    l4, _ = _candidate("l4_alpha_ev")
    fusion, _ = _candidate("allocator_ev_fusion")
    l4["state"] = "offline_failed"
    l4["offline_gate_decision"] = "FAIL"
    l4["offline_gate_failed_gates"] = '["walk_forward_not_stable"]'
    fusion["state"] = "offline_failed"
    fusion["offline_gate_decision"] = "FAIL"
    fusion["offline_gate_failed_gates"] = '["residual_adjustment:walk_forward_not_stable"]'

    selected, activate = _candidate_rows(
        lambda _sql, _params: [l4, fusion],
        "cohort-1",
    )

    assert set(selected) == {"l4_alpha_ev", "allocator_ev_fusion"}
    assert activate == {"l4_alpha_ev": True, "allocator_ev_fusion": True}


def test_candidate_lane_accumulates_when_offline_history_is_not_yet_evaluable() -> None:
    l4, _ = _candidate("l4_alpha_ev")
    fusion, _ = _candidate("allocator_ev_fusion")
    l4.update({
        "state": "offline_failed",
        "offline_gate_decision": "FAIL",
        "offline_gate_failed_gates": '["walk_forward_no_valid_folds"]',
    })
    fusion.update({
        "state": "offline_failed",
        "offline_gate_decision": "FAIL",
        "offline_gate_failed_gates": (
            '["data_validity:date_count_below_validation_floor", '
            '"residual_adjustment:insufficient_dates", '
            '"residual_champion:residual_adjustment_model_not_validated"]'
        ),
    })

    selected, activate = _candidate_rows(
        lambda _sql, _params: [l4, fusion],
        "cohort-1",
    )

    assert set(selected) == {"l4_alpha_ev", "allocator_ev_fusion"}
    assert activate == {"l4_alpha_ev": True, "allocator_ev_fusion": True}


def test_candidate_lane_admits_l4_without_structurally_invalid_fusion() -> None:
    l4, _ = _candidate("l4_alpha_ev")
    fusion, _ = _candidate("allocator_ev_fusion")
    l4.update({
        "state": "rejected",
        "offline_gate_decision": "FAIL",
        "offline_gate_failed_gates": '["walk_forward_not_stable"]',
    })
    fusion.update({
        "state": "rejected",
        "offline_gate_decision": "FAIL",
        "offline_gate_failed_gates": '["feature_contract_invalid"]',
    })

    selected, activate = _candidate_rows(lambda _sql, _params: [l4, fusion], "cohort-1")

    assert set(selected) == {"l4_alpha_ev"}
    assert activate == {"l4_alpha_ev": True}


def test_candidate_lane_fails_closed_when_offline_failure_has_no_evidence() -> None:
    l4, _ = _candidate("l4_alpha_ev")
    l4.update({
        "state": "rejected",
        "offline_gate_decision": "FAIL",
        "offline_gate_failed_gates": "[]",
    })

    selected, activate = _candidate_rows(lambda _sql, _params: [l4], "cohort-1")

    assert selected == {}
    assert activate == {}


def test_candidate_lane_never_reactivates_production_only_pair() -> None:
    l4, _ = _candidate("l4_alpha_ev")
    fusion, _ = _candidate("allocator_ev_fusion")
    l4["state"] = "production"
    fusion["state"] = "production"

    selected, activate = _candidate_rows(
        lambda _sql, _params: [l4, fusion],
        "cohort-1",
    )

    assert selected == {}
    assert activate == {}


def test_preoutcome_lock_reuses_only_labels_unknown_at_candidate_freeze() -> None:
    row, raw = _candidate("l4_alpha_ev")
    packet = json.loads(raw)
    candidate = {"artifact": packet["artifact"]}
    rows = [
        {"fold_id": "frozen_forward", "snapshot_date": "2026-08-18", "label_known_date": "2026-09-01"},
        {"fold_id": "frozen_forward", "snapshot_date": "2026-08-24", "label_known_date": "2026-08-29"},
        {"fold_id": "frozen_forward", "snapshot_date": "2026-08-25", "label_known_date": "2026-09-01"},
        {"fold_id": "frozen_forward", "snapshot_date": "2026-08-26", "label_known_date": "2026-09-02"},
        {"fold_id": "frozen_forward", "snapshot_date": "2026-08-27", "label_known_date": "2026-09-03"},
        {"fold_id": "frozen_forward", "snapshot_date": "2026-08-28", "label_known_date": "2026-09-04"},
    ]

    eligible = _preoutcome_locked_rows(
        rows,
        candidates={"l4_alpha_ev": candidate},
        source_date=str(row["source_run_date"]),
        business_date="2026-09-03",
        selection_semantic_floor_date="2026-08-25",
    )

    assert [item["snapshot_date"] for item in eligible] == [
        "2026-08-25",
        "2026-08-26",
        "2026-08-27",
    ]


def test_preoutcome_persistence_binds_exact_v2_lineage() -> None:
    row, raw = _candidate("l4_alpha_ev")
    packet = json.loads(raw)
    candidate = {
        "registry": row,
        "artifact": packet["artifact"],
        "identity": {"model_fingerprint": packet["artifact"]["model_fingerprint"]},
        "checksum": row["checksum"],
        "selection_semantic_floor_date": "2026-08-25",
    }
    captured: list[tuple[str, list[Any]]] = []

    def batch_fn(statements: list[tuple[str, list[Any]]], **_kwargs: Any) -> dict[str, Any]:
        captured.extend(statements)
        return {"changes": len(statements)}

    result = _persist_evaluations(
        [{
            "evaluation_id": "evaluation",
            "prediction_date": "2026-08-25",
            "label_known_date": "2026-09-01",
            "sample_count": 30,
            "prediction_corr": 0.2,
            "baseline_corr": 0.1,
            "corr_delta": 0.1,
            "spread": 0.01,
            "baseline_spread": 0.005,
            "spread_delta": 0.005,
            "top_return": 0.02,
            "quality_decision": "PASS",
        }],
        owner="l4_alpha_ev",
        candidate=candidate,
        cohort_id="cohort-1",
        extension_manifest_checksum="e" * 64,
        batch_fn=batch_fn,
    )

    sql, params = captured[0]
    assert result == {"changes": 1}
    assert "expected_return_candidate_preoutcome_evaluations" in sql
    assert "artifact_trained_until" in sql
    assert "selection_semantic_floor_date" in sql
    assert sql.count("?") == len(params)
    assert "2026-08-18" in params
    assert "2026-08-25" in params


def test_evaluator_waits_without_training_when_no_preoutcome_locked_rows() -> None:
    l4_row, l4_raw = _candidate("l4_alpha_ev")
    fusion_row, fusion_raw = _candidate("allocator_ev_fusion")
    bucket = _Bucket({
        l4_row["artifact_path"]: l4_raw,
        fusion_row["artifact_path"]: fusion_raw,
    })
    calls = {"build": 0, "persist": 0}

    def query_fn(sql: str, _params: list[Any]) -> list[dict[str, Any]]:
        if "MIN(signal_date)" in sql:
            return [{"selection_semantic_floor_date": "2026-08-25"}]
        if "FROM model_artifact_registry" in sql:
            return [l4_row, fusion_row]
        return []

    def build_fn(*_args: Any, **_kwargs: Any) -> list[dict[str, Any]]:
        calls["build"] += 1
        return []

    def batch_fn(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        calls["persist"] += 1
        return {"changes": 0}

    result = evaluate_expected_return_candidates_forward(
        bucket=bucket,
        cohort_id="cohort-1",
        business_date="2026-09-01",
        extension_manifest_checksum="e" * 64,
        snapshot_rows=[{
            "fold_id": "frozen_forward",
            "snapshot_date": "2026-08-24",
            "label_known_date": "2026-08-29",
        }],
        build_fusion_rows_fn=build_fn,
        query_fn=query_fn,
        batch_fn=batch_fn,
    )

    assert result["status"] == "waiting_for_preoutcome_locked_mature_dates"
    assert result["candidate_source_run_date"] == "2026-08-30"
    assert result["gates"]["l4_alpha_ev"]["decision"] == "PENDING"
    assert result["gates"]["l4_alpha_ev"]["minimum_evaluable_dates"] == 10
    assert result["promotion_ready"] is False
    assert result["training_dispatched"] is False
    assert calls == {"build": 0, "persist": 1}


def test_evaluator_never_pairs_candidates_from_different_freeze_dates() -> None:
    l4_row, l4_raw = _candidate("l4_alpha_ev")
    fusion_row, fusion_raw = _candidate("allocator_ev_fusion", "2026-08-29")
    bucket = _Bucket({
        l4_row["artifact_path"]: l4_raw,
        fusion_row["artifact_path"]: fusion_raw,
    })

    def query_fn(sql: str, _params: list[Any]) -> list[dict[str, Any]]:
        if "MIN(signal_date)" in sql:
            return [{"selection_semantic_floor_date": "2026-08-25"}]
        if "FROM model_artifact_registry" in sql:
            return [l4_row, fusion_row]
        return []

    result = evaluate_expected_return_candidates_forward(
        bucket=bucket,
        cohort_id="cohort-1",
        business_date="2026-09-10",
        extension_manifest_checksum="e" * 64,
        snapshot_rows=[],
        build_fusion_rows_fn=lambda *_args, **_kwargs: [],
        query_fn=query_fn,
        batch_fn=lambda *_args, **_kwargs: {"changes": 0},
    )
    assert result["status"] == "waiting_for_preoutcome_locked_mature_dates"
    assert set(result["candidate_artifact_ids"]) == {"l4_alpha_ev"}
    assert result["promotion_ready"] is False
    assert result["training_dispatched"] is False
