from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-service"))
sys.path.insert(0, str(ROOT / "ml-controller"))

from graphs import daily_pipeline_v2 as pipeline
from services import recommendation_service


def _authority() -> dict:
    return {
        "schema_version": pipeline.ACTIVE8_ACTION_AUTHORITY_SCHEMA,
        "mode": pipeline.ACTIVE8_ACTION_MODE_EVIDENCE_ONLY,
        "buy_authorized": False,
        "production_effect": False,
        "reason": "no_promoted_active8_ensemble_pointer",
    }


def _frozen_manifest_state(authority: dict) -> dict:
    manifest = {
        "schema_version": pipeline.PIPELINE_MODAL_SERVING_MANIFEST_SCHEMA,
        "active8_action_authority": authority,
    }
    return {
        "pipeline_modal_serving_context": {
            "schema_version": "pipeline-modal-serving-context-v1",
            "serving_manifest": manifest,
            "serving_manifest_digest": pipeline._pipeline_modal_canonical_digest(manifest),
        }
    }


def test_evidence_only_recommendation_closes_every_seed_without_action(monkeypatch) -> None:
    authority = _authority()
    predictions = {"2330": {}, "2317": {}}
    monkeypatch.setattr(
        pipeline,
        "build_formal_model_input_contract",
        lambda _pred: {
            "complete": True,
            "full_active8_coverage": True,
            "available_models": list(pipeline.ACTIVE_ALPHA_MODELS),
            "missing_models": [],
            "model_availability": {},
        },
    )
    state = {
        **_frozen_manifest_state(authority),
        "run_date": "2026-08-26",
        "predictions": predictions,
    }
    result = pipeline._build_active8_evidence_only_recommendation_result(
        state,
        [{"symbol": "2330"}, {"symbol": "2317"}],
        {"schema_version": "expected-return-serving-preflight-v1"},
    )

    assert result is not None
    assert result["final_recommendations"] == []
    assert result["sell_filtered_symbols"] == ["2330", "2317"]
    assert result["expected_return_owner_coverage"]["owner_counts"] == {"risk_abstention": 2}
    assert result["active8_action_authority"]["production_effect"] is False
    assert all(
        row["core_family_evidence"]["formal_base_model_contract_passed"] is True
        for row in predictions.values()
    )


def test_evidence_only_recommendation_accepts_optional_sequence_missingness(monkeypatch) -> None:
    missing = list(pipeline.SEQUENCE_ALPHA_MODELS)
    available = [model for model in pipeline.ACTIVE_ALPHA_MODELS if model not in missing]
    monkeypatch.setattr(
        pipeline,
        "build_formal_model_input_contract",
        lambda _pred: {
            "complete": True,
            "full_active8_coverage": False,
            "available_models": available,
            "missing_models": missing,
            "model_availability": {model: model in available for model in pipeline.ACTIVE_ALPHA_MODELS},
        },
    )
    state = {
        **_frozen_manifest_state(_authority()),
        "run_date": "2026-08-26",
        "predictions": {"2330": {}},
    }

    result = pipeline._build_active8_evidence_only_recommendation_result(
        state,
        [{"symbol": "2330"}],
        {"schema_version": "expected-return-serving-preflight-v1"},
    )

    assert result is not None
    assert result["final_recommendations"] == []
    evidence = state["predictions"]["2330"]["core_family_evidence"]
    assert evidence["formal_base_model_contract_passed"] is True
    assert evidence["missing_active_models"] == missing
    assert evidence["active8_action_authority"]["buy_authorized"] is False


def test_evidence_only_recommendation_rejects_missing_core_or_lineage(monkeypatch) -> None:
    monkeypatch.setattr(
        pipeline,
        "build_formal_model_input_contract",
        lambda _pred: {
            "complete": False,
            "full_active8_coverage": False,
            "available_models": ["LightGBM", "XGBoost"],
            "missing_models": [
                "ExtraTrees", "TabM", "GNN", "DLinear", "PatchTST", "iTransformer"
            ],
            "model_availability": {},
            "lineage_blockers": ["rank_missing:ExtraTrees"],
        },
    )
    state = {
        **_frozen_manifest_state(_authority()),
        "run_date": "2026-08-26",
        "predictions": {"2330": {}},
    }

    try:
        pipeline._build_active8_evidence_only_recommendation_result(
            state,
            [{"symbol": "2330"}],
            {"schema_version": "expected-return-serving-preflight-v1"},
        )
    except RuntimeError as exc:
        assert "active8_evidence_only_base_model_closure_failed:2330" in str(exc)
    else:
        raise AssertionError("missing core or score lineage must fail closed")


def test_evidence_only_prediction_writer_never_inserts_ensemble(monkeypatch) -> None:
    statements: list[tuple[str, list]] = []
    monkeypatch.setattr(
        recommendation_service,
        "_predictions_batch_execute",
        lambda rows: statements.extend(rows) or {"ok": True},
    )
    rank_scores = {
        model: 0.5
        for model in recommendation_service.ACTIVE_ALPHA_MODELS
    }
    challenger_rank_scores = dict(rank_scores)
    challenger_lineage = {
        model: {
            "artifact_id": f"observation-{model.lower()}",
            "artifact_version": "v20260826225443",
            "checksum": f"sha256:{model.lower()}",
            "candidate_type": "oof_full_fit_release",
            "raw_score": 0.5,
        }
        for model in recommendation_service.ACTIVE_ALPHA_MODELS
    }
    written = recommendation_service.write_predictions_to_d1(
        {
            "2330": {
                "feature_version": "formal137:test",
                "rank_scores": rank_scores,
                "challenger_rank_scores": challenger_rank_scores,
                "challenger_model_score_lineage": challenger_lineage,
                "active8_action_authority": _authority(),
                "ensemble_v2": None,
            }
        },
        {"2330": 1},
        "2026-08-26",
    )

    inserts = [(sql, params) for sql, params in statements if sql.lstrip().startswith("INSERT INTO predictions")]
    assert written == len(rank_scores)
    assert len(inserts) == len(rank_scores)
    assert all("'ensemble'" not in sql for sql, _params in inserts)
    assert {params[1] for _sql, params in inserts} == {
        f"{model}::challenger" for model in rank_scores
    }
    assert all(params[10] is None and params[12] == "NO_SIGNAL" for _sql, params in inserts)


def test_evidence_only_writer_persists_optional_sequence_missingness_without_fake_score(monkeypatch) -> None:
    statements: list[tuple[str, list]] = []
    monkeypatch.setattr(
        recommendation_service,
        "_predictions_batch_execute",
        lambda rows: statements.extend(rows) or {"ok": True},
    )
    core_models = list(recommendation_service.ACTIVE_ALPHA_MODELS[:5])
    optional_models = list(recommendation_service.OPTIONAL_SEQUENCE_ALPHA_MODELS)
    candidate_versions = {model: "v20260826225443" for model in recommendation_service.ACTIVE_ALPHA_MODELS}
    candidate_ids = {model: f"{model}:v20260826225443:oof_full_fit_release" for model in recommendation_service.ACTIVE_ALPHA_MODELS}
    candidate_checksums = {model: f"sha256:{model.lower()}" for model in recommendation_service.ACTIVE_ALPHA_MODELS}
    written = recommendation_service.write_predictions_to_d1(
        {
            "2330": {
                "feature_version": "formal137:test",
                "rank_scores": {model: 0.5 for model in core_models},
                "challenger_rank_scores": {model: 0.5 for model in core_models},
                "challenger_model_score_lineage": {
                    "semantic_version": "active8-daily-market-cross-sectional-percentile-v1",
                    "target_semantic_version": "prediction-target-close-to-close-5d-pit-v1",
                    "candidate_artifact_versions": candidate_versions,
                    "candidate_artifact_ids": candidate_ids,
                    "candidate_artifact_checksums": candidate_checksums,
                    "candidate_types_all": {model: "oof_full_fit_release" for model in candidate_versions},
                },
                "l3_model_eligibility": {
                    "sequence_models": {
                        model: {
                            "eligible": False,
                            "reason": "active8_sequence_history_contract_unmet_optional_masked",
                            "required_sequence_points": 512,
                            "available_sequence_points": 416,
                        }
                        for model in optional_models
                    }
                },
                "active8_action_authority": _authority(),
                "ensemble_v2": None,
            }
        },
        {"2330": 1},
        "2026-08-26",
    )

    inserts = [(sql, params) for sql, params in statements if sql.lstrip().startswith("INSERT INTO predictions")]
    assert written == len(recommendation_service.ACTIVE_ALPHA_MODELS)
    assert {params[1] for _sql, params in inserts} == {
        f"{model}::challenger" for model in recommendation_service.ACTIVE_ALPHA_MODELS
    }
    missing_rows = [params for _sql, params in inserts if params[4] is None]
    assert len(missing_rows) == len(optional_models)
    for params in missing_rows:
        payload = recommendation_service.json.loads(params[5])
        assert payload["rank_score"] is None
        assert payload["availability_status"] == "unavailable"
        assert payload["missingness"]["reason"] == "active8_sequence_history_contract_unmet_optional_masked"
        assert payload["model_signal"]["artifact_id"] == candidate_ids[params[1].removesuffix("::challenger")]


def test_evidence_only_prediction_writer_rejects_hidden_ensemble(monkeypatch) -> None:
    monkeypatch.setattr(
        recommendation_service,
        "_predictions_batch_execute",
        lambda _rows: {"ok": True},
    )
    try:
        recommendation_service.write_predictions_to_d1(
            {
                "2330": {
                    "feature_version": "formal137:test",
                    "rank_scores": {"XGBoost": 0.5},
                    "active8_action_authority": _authority(),
                    "ensemble_v2": {"signal": "BUY"},
                }
            },
            {"2330": 1},
            "2026-08-26",
        )
    except ValueError as exc:
        assert "evidence_only_ensemble_must_be_absent" in str(exc)
    else:
        raise AssertionError("evidence-only writer must reject a hidden ensemble payload")
