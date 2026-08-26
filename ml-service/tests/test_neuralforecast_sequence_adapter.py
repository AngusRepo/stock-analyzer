from __future__ import annotations

from types import SimpleNamespace

from app.research_benchmarks.neuralforecast_sequence_adapter import _prediction_column


def test_prediction_column_prefers_named_neuralforecast_output_over_reset_index():
    pred_df = SimpleNamespace(columns=["index", "unique_id", "ds", "PatchTST"])

    assert _prediction_column(pred_df, "PatchTST") == "PatchTST"


def test_prediction_column_rejects_ambiguous_non_model_columns():
    pred_df = SimpleNamespace(columns=["index", "unique_id", "ds", "foo", "bar"])

    assert _prediction_column(pred_df, "iTransformer") is None


def test_patchtst_purged_oof_does_not_require_serving_artifact_fields(monkeypatch):
    from app import patchtst_universal

    model_cpcv = {"decision": "FAIL", "passed": False}
    monkeypatch.setattr(
        patchtst_universal,
        "train_neuralforecast_sequence_artifact",
        lambda *_args, **_kwargs: {
            "metadata": {"model_cpcv": model_cpcv},
            "metrics": {"oos_ic": -0.01, "oos_samples": 100},
            "version": "oof-v1",
            "elapsed_s": 1.0,
            "oof_artifact": {"path": "universal/oof/test/patchtst.npz"},
        },
    )

    result = patchtst_universal.train_patchtst(
        sequence_records=[{"symbol": "2330", "close": [1.0], "dates": ["2026-01-01"]}],
        generation_mode="purged_oof",
        promote_to_active=False,
    )

    assert result["oof_artifact"]["path"].endswith("patchtst.npz")
    assert result["model_cpcv"] == model_cpcv
    assert "pool_update" not in result
