from __future__ import annotations

import json
import sys
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.ev_lineage_contract import (  # noqa: E402
    attach_next_session_open_evidence,
    attach_same_run_model_version_evidence,
    canonical_ev_feature_values,
    ensemble_lineage_blockers,
    reconstruct_point_in_time_ev_lineage,
)


def _legacy_row() -> dict:
    return {
        "symbol": "2330",
        "prediction_date": "2026-06-18",
        "prediction_generated_at": "2026-06-18T13:00:00+00:00",
        "score_components": json.dumps({
            "version": "score_v2",
            "components": {
                "mlEdge": 18,
                "fundamentalQuality": 19,
                "chipFlow": 20,
                "technicalStructure": 21,
                "newsTheme": 0,
            },
            "total": 78,
            "finalScore": 80,
            "alphaAdjustment": 2,
        }),
        "forecast_data": json.dumps({
            "ensemble_v2": {
                "avg_rank": 0.71,
                "contributing_models": ["LightGBM", "XGBoost"],
                "weights": {"LightGBM": 0.6, "XGBoost": 0.4},
            },
        }),
    }


def _events(*, grade: str = "exact") -> list[dict]:
    return [
        {
            "model_name": model,
            "version": version,
            "artifact_id": f"{model}:{version}",
            "effective_at": "2026-06-10T00:00:00Z",
            "retired_at": "2026-06-25T00:00:00Z",
            "source": "model_champion_history",
            "evidence_grade": grade,
        }
        for model, version in (("LightGBM", "lgb-v3"), ("XGBoost", "xgb-v4"))
    ]


def _row_version_evidence(model_name: str, version: str, generated_at: str) -> dict:
    return {
        "version": version,
        "generated_at": generated_at,
        "prediction_date": "2026-06-18",
        "source": "predictions.model_signal",
        "artifact_registry": {
            "artifact_id": f"{model_name}:{version}",
            "model_name": model_name,
            "version": version,
            "artifact_path": f"universal/{model_name.lower()}/{version}.zip",
            "metadata_path": f"universal/{model_name.lower()}/metadata_{version}.json",
            "checksum": f"sha256:{'a' * 64}",
            "created_at": "2026-06-10T00:00:00Z",
            "source": "model_artifact_registry",
        },
    }


def test_unknown_model_version_cannot_form_valid_lineage_signature():
    blockers = ensemble_lineage_blockers({
        "semantic_version": "active8-ic-weighted-rank-v3",
        "contributing_models": ["LightGBM"],
        "artifact_versions": {"LightGBM": "unknown"},
        "model_set_signature": "LightGBM@unknown",
    })

    assert "artifact_version_missing:LightGBM" in blockers
    assert "model_set_signature_invalid" in blockers


def test_historical_row_is_recomputed_only_with_exact_asof_champion_history():
    result = reconstruct_point_in_time_ev_lineage(_legacy_row(), champion_events=_events())

    assert result["status"] == "reconstructed"
    rebuilt = result["row"]
    score = json.loads(rebuilt["score_components"])
    ensemble = json.loads(rebuilt["forecast_data"])["ensemble_v2"]
    assert score["semanticVersion"] == "score-v2-active8-components-v3"
    assert score["total"] == 78.0
    assert score["finalScore"] == 80.0
    assert ensemble["model_set_signature"] == "LightGBM@lgb-v3|XGBoost@xgb-v4"
    assert ensemble["lineage_evidence"]["counterfactual"] is True
    assert ensemble["lineage_evidence"]["as_of_guard"].startswith(
        "prediction_generated_at<next_executable_session_open_when_delayed"
    )
    assert canonical_ev_feature_values(rebuilt) == ensemble["lineage_evidence"]["feature_values"]


def test_bounded_or_future_artifact_evidence_fails_closed():
    bounded = reconstruct_point_in_time_ev_lineage(_legacy_row(), champion_events=_events(grade="bounded"))
    assert bounded["status"] == "rejected"
    assert "point_in_time_artifact_version_missing:LightGBM" in bounded["blockers"]

    future_events = [
        {**event, "effective_at": "2026-06-19T00:00:00Z"}
        for event in _events()
    ]
    future = reconstruct_point_in_time_ev_lineage(_legacy_row(), champion_events=future_events)
    assert future["status"] == "rejected"
    assert "point_in_time_artifact_version_missing:XGBoost" in future["blockers"]


def test_score_reconstruction_rejects_inconsistent_final_score():
    row = _legacy_row()
    score = json.loads(row["score_components"])
    score["finalScore"] = 95
    row["score_components"] = json.dumps(score)

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=_events())

    assert result["status"] == "rejected"
    assert "score_final_reconstruction_mismatch" in result["blockers"]


def test_non_active8_contributor_is_rejected_even_with_a_signature():
    row = _legacy_row()
    forecast = json.loads(row["forecast_data"])
    forecast["ensemble_v2"]["contributing_models"] = ["LightGBM", "TimesFM"]
    forecast["ensemble_v2"]["weights"] = {"LightGBM": 0.5, "TimesFM": 0.5}
    row["forecast_data"] = json.dumps(forecast)

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=_events())

    assert result["status"] == "rejected"
    assert "contributor_not_active8:TimesFM" in result["blockers"]


def test_delayed_prediction_requires_actual_next_session_cutoff():
    row = _legacy_row()
    row["prediction_date"] = "2026-06-22"
    row["prediction_generated_at"] = "2026-06-23T11:34:05Z"
    row["next_session_open_at"] = "2026-06-23T01:00:00Z"

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=_events())

    assert result["status"] == "rejected"
    assert "prediction_generated_at_not_before_next_session_open" in result["blockers"]


def test_weekend_rerun_before_next_session_open_is_valid():
    row = _legacy_row()
    row["prediction_generated_at"] = "2026-06-21T15:02:54Z"
    row["next_session_open_at"] = "2026-06-22T01:00:00Z"
    events = [
        {**event, "retired_at": None}
        for event in _events()
    ]

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=events)

    assert result["status"] == "reconstructed"


def test_same_run_model_signal_version_can_fill_missing_champion():
    row = _legacy_row()
    row["row_model_version_evidence"] = json.dumps({
        "LightGBM": _row_version_evidence("LightGBM", "lgb-v3", "2026-06-18T12:55:00Z"),
        "XGBoost": _row_version_evidence("XGBoost", "xgb-v4", "2026-06-18T12:56:00Z"),
    })

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=[])

    assert result["status"] == "reconstructed"
    sources = result["audit"]["artifact_version_sources"]
    assert set(sources.values()) == {"predictions.model_signal"}


def test_registry_verified_same_run_version_overrides_stale_champion_with_warning():
    row = _legacy_row()
    row["row_model_version_evidence"] = json.dumps({
        "LightGBM": _row_version_evidence(
            "LightGBM", "different-version", "2026-06-18T12:55:00Z"
        ),
    })

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=_events())

    assert result["status"] == "reconstructed"
    ensemble = json.loads(result["row"]["forecast_data"])["ensemble_v2"]
    assert ensemble["artifact_versions"]["LightGBM"] == "different-version"
    assert "champion_history_mismatch:LightGBM" in result["audit"]["warnings"]


def test_same_run_version_without_point_in_time_registry_proof_fails_closed():
    row = _legacy_row()
    evidence = _row_version_evidence("LightGBM", "different-version", "2026-06-18T12:55:00Z")
    evidence["artifact_registry"] = None
    row["row_model_version_evidence"] = json.dumps({"LightGBM": evidence})

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=_events())

    assert result["status"] == "rejected"
    assert "row_model_version_registry_missing:LightGBM" in result["blockers"]


def test_same_run_version_without_registry_checksum_fails_closed():
    row = _legacy_row()
    evidence = _row_version_evidence("LightGBM", "different-version", "2026-06-18T12:55:00Z")
    evidence["artifact_registry"]["checksum"] = None
    row["row_model_version_evidence"] = json.dumps({"LightGBM": evidence})

    result = reconstruct_point_in_time_ev_lineage(row, champion_events=_events())

    assert result["status"] == "rejected"
    assert "row_model_version_registry_checksum_invalid:LightGBM" in result["blockers"]


def test_native_lineage_cannot_bypass_point_in_time_artifact_provenance():
    reconstructed = reconstruct_point_in_time_ev_lineage(_legacy_row(), champion_events=_events())
    native_row = reconstructed["row"]
    forecast = json.loads(native_row["forecast_data"])
    forecast["ensemble_v2"]["artifact_versions"]["LightGBM"] = "internally-consistent-but-wrong"
    forecast["ensemble_v2"]["model_set_signature"] = (
        "LightGBM@internally-consistent-but-wrong|XGBoost@xgb-v4"
    )
    native_row["forecast_data"] = json.dumps(forecast)

    result = reconstruct_point_in_time_ev_lineage(native_row, champion_events=_events())

    assert result["status"] == "rejected"
    assert "native_artifact_version_not_point_in_time:LightGBM" in result["blockers"]


def test_same_run_versions_are_loaded_once_per_signal_date_and_matched_in_memory():
    calls = []

    def query_fn(sql, params):
        calls.append((sql, params))
        if "FROM model_artifact_registry" in sql:
            return [{
                "artifact_id": "DLinear:v1",
                "model_name": "DLinear",
                "version": "v1",
                "artifact_path": "universal/dlinear/v1.zip",
                "metadata_path": "universal/dlinear/metadata_v1.json",
                "checksum": f"sha256:{'b' * 64}",
                "created_at": "2026-06-10T00:00:00Z",
            }]
        return [{
            "stock_id": 1,
            "prediction_date": "2026-06-16",
            "model_name": "DLinear",
            "generated_at": "2026-06-16T14:47:00Z",
            "model_version": "v1",
        }]

    enriched, audit = attach_same_run_model_version_evidence(query_fn, [{
        "stock_id": 1,
        "prediction_date": "2026-06-16",
        "prediction_generated_at": "2026-06-16T14:48:50Z",
    }])

    assert len(calls) == 2
    assert calls[0][1] == ["2026-06-16", "2026-06-17"]
    assert "date(prediction_date)" not in calls[0][0]
    assert enriched[0]["row_model_version_evidence"]["DLinear"]["version"] == "v1"
    assert enriched[0]["row_model_version_evidence"]["DLinear"]["artifact_registry"]["artifact_id"] == "DLinear:v1"
    assert audit["query_count"] == 2
    assert audit["matched_versions"] == 1
    assert audit["registry_verified_versions"] == 1


def test_delayed_rows_load_next_actual_session_once_for_all_candidates():
    calls = []

    def query_fn(sql, params):
        calls.append((sql, params))
        return [{"signal_date": "2026-06-18", "next_session_date": "2026-06-22"}]

    rows = [
        {
            "stock_id": stock_id,
            "prediction_date": "2026-06-18",
            "prediction_generated_at": "2026-06-21T15:02:54Z",
        }
        for stock_id in (1, 2)
    ]
    enriched, audit = attach_next_session_open_evidence(query_fn, rows)

    assert len(calls) == 1
    assert calls[0][1] == ["2026-06-18"]
    assert {row["next_session_open_at"] for row in enriched} == {"2026-06-22T01:00:00Z"}
    assert audit["unresolved_signal_dates"] == []
