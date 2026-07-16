import numpy as np
import pandas as pd

from app.model_validation import build_model_cpcv_evidence
from app.neuralforecast_sequence_runtime import (
    _build_fixed_oof_panel,
    _dense_oof_eval_panel,
    _fold_metrics,
    _filter_panel_to_eval_rows,
    _make_nf_model,
    _panel_full_train_rows,
    _panel_train_eval_rows,
    _predict_horizon_by_id_with_column,
    _prediction_column,
    default_seq_len_for_model,
)


def test_neuralforecast_sequence_defaults_follow_model_core_windows():
    assert default_seq_len_for_model("PatchTST") == 512
    assert default_seq_len_for_model("iTransformer") == 512


def test_itransformer_panel_builder_aligns_ragged_series_to_fixed_context():
    records = []
    for idx, length in enumerate((30, 35, 40)):
        records.append({
            "symbol": f"S{idx}",
            "market_type": "TWSE",
            "close": [100.0 + day for day in range(length)],
            "open": [99.5 + day for day in range(length)],
            "dates": [f"d{day:03d}" for day in range(length)],
        })

    rows, eval_rows, report = _panel_train_eval_rows(
        records,
        seq_len=20,
        pred_len=5,
        max_series=10,
        fixed_panel_history=True,
    )

    counts = {}
    for row in rows:
        counts[row["unique_id"]] = counts.get(row["unique_id"], 0) + 1
    assert counts == {"S0": 25, "S1": 25, "S2": 25}
    assert len(eval_rows) == 3
    assert report["fixed_panel_history"] is True


def test_panel_train_eval_rows_filters_short_series_before_neuralforecast_fit():
    records = [
        {"symbol": "short", "close": [float(i) for i in range(60)]},
        {
            "symbol": "long",
            "close": [float(i) for i in range(140)],
            "open": [float(i + 1) for i in range(140)],
            "dates": [f"d{i:03d}" for i in range(140)],
        },
    ]

    train_rows, eval_rows, stats = _panel_train_eval_rows(
        records,
        seq_len=128,
        pred_len=5,
        max_series=10,
    )

    assert [row["unique_id"] for row in eval_rows] == ["long"]
    assert len(train_rows) == 135
    assert stats["min_history"] == 138
    assert stats["skipped_short_history"] == 1
    assert stats["valid_series"] == 1
    assert eval_rows[0]["entry_open"] == 136.0
    assert eval_rows[0]["target_semantic_version"].endswith("canonical-adjusted-close-net-v4")


def test_itransformer_full_refit_keeps_context_plus_training_horizon():
    records = [
        {"symbol": "short", "close": [float(i) for i in range(24)]},
        {"symbol": "valid", "close": [float(i) for i in range(40)]},
    ]

    rows, valid_series = _panel_full_train_rows(
        records,
        seq_len=20,
        pred_len=5,
        max_series=10,
        fixed_panel_history=True,
    )

    assert valid_series == 1
    assert len(rows) == 25
    assert {row["unique_id"] for row in rows} == {"valid"}


def test_purged_oof_filter_keeps_training_and_eval_series_atomic():
    train_rows = [
        {"unique_id": "A", "ds": 0, "y": 1.0},
        {"unique_id": "A", "ds": 1, "y": 2.0},
        {"unique_id": "B", "ds": 0, "y": 3.0},
    ]
    eval_rows = [{"unique_id": "A", "signal_date": "2026-05-01"}]

    filtered = _filter_panel_to_eval_rows(train_rows, eval_rows)

    assert filtered == train_rows[:2]


def test_dense_oof_panel_fits_at_train_end_and_labels_each_signal_date():
    calendar = [f"2026-01-{day:02d}" for day in range(1, 11)]
    records = [
        {
            "symbol": f"S{idx:02d}",
            "market_type": "LISTED",
            "dates": calendar,
            "close": [100.0 + idx + day for day in range(10)],
            "open": [99.5 + idx + day for day in range(10)],
        }
        for idx in range(12)
    ]

    train_rows, selected, report = _build_fixed_oof_panel(
        records,
        calendar=calendar,
        train_end="2026-01-06",
        seq_len=4,
        pred_len=2,
        max_series=20,
    )
    context_rows, labels = _dense_oof_eval_panel(
        selected,
        calendar=calendar,
        signal_date="2026-01-06",
        seq_len=4,
        pred_len=2,
    )

    assert len(train_rows) == 12 * 6
    assert report["calendar_end"] == "2026-01-06"
    assert len(context_rows) == 12 * 4
    assert len(labels) == 12
    assert {row["outcome_date"] for row in labels} == {"2026-01-08"}
    assert labels[0]["entry_open"] == 105.5


def test_panel_train_eval_rows_scans_past_short_records_until_max_series_valid():
    records = [
        {"symbol": "short_a", "close": [float(i) for i in range(60)]},
        {"symbol": "short_b", "close": [float(i) for i in range(80)]},
        {
            "symbol": "long_a",
            "close": [float(i) for i in range(140)],
            "open": [float(i + 1) for i in range(140)],
            "dates": [f"a{i:03d}" for i in range(140)],
        },
        {
            "symbol": "long_b",
            "close": [float(i) for i in range(150)],
            "open": [float(i + 1) for i in range(150)],
            "dates": [f"b{i:03d}" for i in range(150)],
        },
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


def test_panel_train_eval_rows_rejects_legacy_close_only_label_contract():
    records = [{
        "symbol": "legacy",
        "close": [float(i) for i in range(140)],
        "dates": [f"d{i:03d}" for i in range(140)],
    }]

    train_rows, eval_rows, stats = _panel_train_eval_rows(
        records,
        seq_len=128,
        pred_len=5,
        max_series=10,
    )

    assert train_rows == []
    assert eval_rows == []
    assert stats["skipped_label_contract"] == 1


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


def test_prediction_column_prefers_named_model_and_ignores_reset_index():
    pred_df = pd.DataFrame(
        {
            "unique_id": ["2330", "2330"],
            "ds": [1, 2],
            "PatchTST": [100.0, 101.0],
        },
        index=[800, 801],
    ).reset_index()

    assert _prediction_column(pred_df, "PatchTST") == "PatchTST"


def test_predict_horizon_uses_named_model_column_not_index_column():
    class FakeNeuralForecast:
        def predict(self, df):  # noqa: ANN001
            return pd.DataFrame(
                {
                    "unique_id": ["2330", "2330", "2317", "2317"],
                    "ds": [1, 2, 1, 2],
                    "PatchTST": [100.0, 101.0, 200.0, 202.0],
                },
                index=[900, 901, 902, 903],
            )

    pred_by_id, pred_col = _predict_horizon_by_id_with_column(
        FakeNeuralForecast(),
        pd.DataFrame({"unique_id": ["2330"], "ds": [0], "y": [99.0]}),
        horizon_idx=2,
        model_name="PatchTST",
    )

    assert pred_col == "PatchTST"
    assert pred_by_id == {"2330": 101.0, "2317": 202.0}
