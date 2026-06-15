import numpy as np

from app.model_validation import build_model_cpcv_evidence
from app.neuralforecast_sequence_runtime import _fold_metrics, _make_nf_model, _panel_train_eval_rows, default_seq_len_for_model


def test_neuralforecast_sequence_defaults_follow_model_core_windows():
    assert default_seq_len_for_model("PatchTST") == 512
    assert default_seq_len_for_model("iTransformer") == 1024


def test_panel_train_eval_rows_filters_short_series_before_neuralforecast_fit():
    records = [
        {"symbol": "short", "close": [float(i) for i in range(60)]},
        {"symbol": "long", "close": [float(i) for i in range(140)]},
    ]

    train_rows, eval_rows, stats = _panel_train_eval_rows(
        records,
        seq_len=128,
        pred_len=5,
        max_series=10,
    )

    assert [row["unique_id"] for row in eval_rows] == ["long"]
    assert len(train_rows) == 135
    assert stats["min_history"] == 133
    assert stats["skipped_short_history"] == 1
    assert stats["valid_series"] == 1


def test_panel_train_eval_rows_scans_past_short_records_until_max_series_valid():
    records = [
        {"symbol": "short_a", "close": [float(i) for i in range(60)]},
        {"symbol": "short_b", "close": [float(i) for i in range(80)]},
        {"symbol": "long_a", "close": [float(i) for i in range(140)]},
        {"symbol": "long_b", "close": [float(i) for i in range(150)]},
    ]

    _train_rows, eval_rows, stats = _panel_train_eval_rows(
        records,
        seq_len=128,
        pred_len=5,
        max_series=2,
    )

    assert [row["unique_id"] for row in eval_rows] == ["long_a", "long_b"]
    assert stats["considered_series"] == 4
    assert stats["skipped_short_history"] == 2
    assert stats["valid_series"] == 2


def test_neuralforecast_model_runtime_suppresses_known_trainer_warnings():
    model = _make_nf_model(
        "PatchTST",
        pred_len=5,
        seq_len=128,
        max_steps=7,
        batch_size=16,
        seed=42,
        n_series=20,
    )

    assert model.val_check_steps == 7
    assert model.trainer_kwargs["enable_checkpointing"] is False
    assert model.trainer_kwargs["enable_model_summary"] is False
    assert model.trainer_kwargs["enable_progress_bar"] is False
    assert model.trainer_kwargs["logger"] is False


def test_neuralforecast_fold_metrics_feed_model_cpcv_bundle():
    pred = np.linspace(-0.05, 0.05, 120)
    actual = pred + 0.001

    folds = _fold_metrics("PatchTST", pred, actual)
    evidence = build_model_cpcv_evidence(
        model="PatchTST",
        fold_metrics=folds,
        family="learned_sequence",
        coverage_mode="sequence_window",
    )

    assert evidence["schema_version"] == "model-cpcv-evidence-v1"
    assert evidence["folds"] >= 4
    assert evidence["oos_ic_mean"] > 0
