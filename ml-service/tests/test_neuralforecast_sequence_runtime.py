from app.neuralforecast_sequence_runtime import _panel_train_eval_rows, default_seq_len_for_model


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
