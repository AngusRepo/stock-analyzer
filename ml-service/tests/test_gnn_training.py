from __future__ import annotations

import numpy as np
import pytest

from app import gnn_batch_runtime, gnn_training
from app.gnn_graph_contract import GNN_GRAPH_SEMANTIC_VERSION, _normalized_sector_labels, build_feature_sector_edge_index


def test_robust_standardize_applies_train_serve_clip():
    train = [[0.0, 0.0], [1.0, 1.0], [2.0, 2.0]]
    all_rows = [[100.0, -100.0]]

    scaled, _medians, _scales = gnn_training._robust_standardize(
        np.asarray(train, dtype=np.float32),
        np.asarray(all_rows, dtype=np.float32),
        clip_value=8.0,
    )

    assert scaled.tolist() == [[8.0, -8.0]]


def test_build_graph_snapshots_builds_each_date_once(monkeypatch):
    x = np.asarray(
        [
            [1.0, 0.0],
            [0.0, 1.0],
            [0.8, 0.2],
            [0.2, 0.8],
        ],
        dtype=np.float32,
    )
    sectors = np.asarray(["a", "a", "b", "b"])
    groups = [np.asarray([0, 1]), np.asarray([2, 3])]
    calls = []
    original = gnn_training._feature_edge_index

    def tracked(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(gnn_training, "_feature_edge_index", tracked)

    snapshots, report = gnn_training._build_graph_snapshots(
        groups,
        x=x,
        sectors=sectors,
        top_k=1,
        threshold=0.0,
    )

    assert len(calls) == len(groups)
    assert len(snapshots) == len(groups)
    assert report["snapshot_count"] == 2
    assert report["node_count"] == 4
    assert report["edge_count"] > 0


def test_cached_graph_evaluation_does_not_rebuild_edges(monkeypatch):
    torch = pytest.importorskip("torch")

    class _Model(torch.nn.Module):
        def forward(self, x, edge_index):
            del edge_index
            return x[:, 0]

    x = np.asarray([[0.1], [0.2], [0.3], [0.4]], dtype=np.float32)
    y = np.asarray([0.1, 0.2, 0.3, 0.4], dtype=np.float32)
    sectors = np.asarray(["a", "a", "b", "b"])
    groups = [np.asarray([0, 1]), np.asarray([2, 3])]
    snapshots = [
        (groups[0], np.asarray([[0, 1], [1, 0]], dtype=np.int64)),
        (groups[1], np.asarray([[0, 1], [1, 0]], dtype=np.int64)),
    ]

    monkeypatch.setattr(
        gnn_training,
        "_feature_edge_index",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("must use cached graph")),
    )

    result = gnn_training._evaluate(
        _Model(),
        groups=groups,
        x=x,
        y=y,
        sectors=sectors,
        device=torch.device("cpu"),
        top_k=1,
        threshold=0.0,
        graph_snapshots=snapshots,
    )

    assert result["samples"] == 4
    assert result["daily_ic_count"] == 2


def test_training_wrapper_matches_canonical_serving_graph_builder():
    x = np.asarray([[1.0, 0.0], [0.9, 0.1], [0.0, 1.0]], dtype=np.float32)
    sectors = np.asarray(["semiconductor", "semiconductor", "financial"], dtype=object)
    expected, report = build_feature_sector_edge_index(x, sectors, top_k=2, threshold=0.75)
    actual = gnn_training._feature_edge_index(x, sectors, top_k=2, threshold=0.75)
    np.testing.assert_array_equal(actual, expected)
    assert report["semantic_version"] == GNN_GRAPH_SEMANTIC_VERSION


def test_unknown_sector_values_never_create_false_same_sector_identity():
    labels = _normalized_sector_labels(np.asarray(["0", "0.0", "unknown", None], dtype=object))
    assert labels.tolist() == ["", "", "", ""]


def test_serving_rejects_pre_parity_gnn_graph_artifact_before_inference():
    artifact = gnn_batch_runtime.GraphSAGEArtifact(
        model=object(),
        metadata={"graph_context": {"semantic_version": "multi-similarity-legacy-v1"}},
        source_path="universal/gnn/legacy.pt",
        version="legacy",
    )
    with pytest.raises(Exception, match="gnn_graph_semantic_mismatch"):
        gnn_batch_runtime.predict_graphsage_scores(
            artifact,
            node_features=np.asarray([[1.0], [2.0]], dtype=np.float32),
            price_series=[[1.0], [2.0]],
            context_records=[{}, {}],
        )
def test_gnn_spearman_constant_prediction_is_neutral():
    assert gnn_training._spearman(np.ones(8), np.arange(8, dtype=float)) == 0.0


def test_evaluate_reports_dead_zone_and_daily_ties_without_changing_scores():
    torch = pytest.importorskip("torch")
    pytest.importorskip("torch_geometric")
    torch.manual_seed(0)
    model = gnn_training._build_model(n_features=3, hidden_dim=4, dropout=0.0)
    rng = np.random.default_rng(0)
    x = rng.normal(size=(50, 3)).astype(np.float32)
    y = rng.normal(size=50).astype(np.float32)
    dates = np.asarray(["2026-09-01"] * 25 + ["2026-09-02"] * 25, dtype=object)
    groups = [np.arange(25), np.arange(25, 50)]
    ring = np.asarray([np.arange(25), np.roll(np.arange(25), 1)], dtype=np.int64)
    snapshots = [(groups[0], ring), (groups[1], ring)]
    with torch.no_grad():
        model.conv2.lin_l.bias[:] = -1e6  # every row of every date lands in the dead zone
    expected = np.concatenate([
        torch.sigmoid(model(torch.tensor(x[idx]), torch.tensor(edge))).detach().numpy() for idx, edge in snapshots])

    result = gnn_training._evaluate(
        model, groups=groups, x=x, y=y, sectors=np.asarray(["a"] * 50), device=torch.device("cpu"),
        top_k=1, threshold=0.0, graph_snapshots=snapshots, include_predictions=True, dates=dates)

    assert np.array_equal(result["_predictions"], expected)
    assert not model.conv2._forward_hooks
    assert result["dead_zone_share"] == 1.0
    ties = result["daily_max_same_value"]
    assert ties["max_share"] == 1.0
    assert [d["signal_date"] for d in ties["flagged_days"]] == ["2026-09-01", "2026-09-02"]
    assert ties["flagged_days"][0]["max_same_value_rows"] == 25


def test_evaluate_tie_guard_ignores_small_blocks_and_models_without_conv2():
    torch = pytest.importorskip("torch")

    class _Model(torch.nn.Module):
        def forward(self, x, edge_index):
            del edge_index
            return x[:, 0]

    x = np.asarray([[0.5]] * 10 + [[i / 1000] for i in range(90)], dtype=np.float32)  # 10/100 tie: >1% but <20 rows
    result = gnn_training._evaluate(
        _Model(), groups=[np.arange(100)], x=x, y=np.arange(100, dtype=np.float32), sectors=np.asarray(["a"] * 100),
        device=torch.device("cpu"), top_k=1, threshold=0.0,
        graph_snapshots=[(np.arange(100), np.zeros((2, 0), dtype=np.int64))])
    assert result["dead_zone_share"] is None
    assert result["daily_max_same_value"]["max_share"] == 0.1
    assert result["daily_max_same_value"]["flagged_days"] == []


def test_max_same_value_rows_groups_ulp_neighbours_only():
    base = np.float32(0.50201904)
    ulp = np.nextafter(base, np.float32(1)) - base
    pred = np.asarray([base] * 12 + [base + ulp] * 12 + list(np.linspace(0.1, 0.9, 50)), dtype=np.float32)
    assert gnn_training._max_same_value_rows(pred) == 24
    assert gnn_training._max_same_value_rows(np.asarray([], dtype=np.float32)) == 0
    assert gnn_training._max_same_value_rows(np.linspace(0, 1, 1000, dtype=np.float32)) == 1
