from __future__ import annotations

from types import SimpleNamespace

from app.research_benchmarks.neuralforecast_sequence_adapter import _prediction_column


def test_prediction_column_prefers_named_neuralforecast_output_over_reset_index():
    pred_df = SimpleNamespace(columns=["index", "unique_id", "ds", "PatchTST"])

    assert _prediction_column(pred_df, "PatchTST") == "PatchTST"


def test_prediction_column_rejects_ambiguous_non_model_columns():
    pred_df = SimpleNamespace(columns=["index", "unique_id", "ds", "foo", "bar"])

    assert _prediction_column(pred_df, "iTransformer") is None
