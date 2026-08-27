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
        "run_date": "2026-08-26",
        "serving_manifest": {"active8_action_authority": authority},
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


def test_evidence_only_recommendation_requires_all_eight_models(monkeypatch) -> None:
    monkeypatch.setattr(
        pipeline,
        "build_formal_model_input_contract",
        lambda _pred: {
            "complete": True,
            "full_active8_coverage": False,
            "available_models": list(pipeline.ACTIVE_ALPHA_MODELS[:-1]),
            "missing_models": [pipeline.ACTIVE_ALPHA_MODELS[-1]],
            "model_availability": {},
        },
    )
    state = {
        "run_date": "2026-08-26",
        "serving_manifest": {"active8_action_authority": _authority()},
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
        raise AssertionError("evidence-only lane must require all eight model scores")


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
    written = recommendation_service.write_predictions_to_d1(
        {
            "2330": {
                "feature_version": "formal137:test",
                "rank_scores": rank_scores,
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
    assert {params[1] for _sql, params in inserts} == set(rank_scores)
    assert all(params[10] is None and params[12] == "NO_SIGNAL" for _sql, params in inserts)


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
