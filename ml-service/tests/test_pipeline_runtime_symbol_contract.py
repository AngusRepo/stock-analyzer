from modal_app import _pipeline_runtime_expected_symbols


def test_gnn_uses_full_universe_when_sequence_carrier_is_empty() -> None:
    expected = ["2330", "2317", "2454"]

    assert _pipeline_runtime_expected_symbols("GNN", expected, []) == expected


def test_sequence_model_uses_its_own_eligible_carrier() -> None:
    rows = [{"symbol": "2330"}, {"stock_id": "2454"}]

    assert _pipeline_runtime_expected_symbols("DLinear", ["2330", "2317", "2454"], rows) == [
        "2330",
        "2454",
    ]
