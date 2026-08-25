from __future__ import annotations

import json

import numpy as np
import pytest

from app import gnn_batch_runtime, gnn_training
from app.gnn_graph_contract import GNN_GRAPH_SEMANTIC_VERSION, _normalized_sector_labels, build_feature_sector_edge_index


class _FakeBlob:
    def __init__(self, text: str | None = None):
        self.text = text

    def exists(self):
        return self.text is not None

    def download_as_text(self):
        assert self.text is not None
        return self.text

    def upload_from_string(self, text: str, content_type: str | None = None):
        self.text = text
        self.content_type = content_type


class _FakeBucket:
    def __init__(self, pool: dict):
        self.blobs = {
            "universal/model_pool.json": _FakeBlob(json.dumps(pool)),
        }

    def blob(self, key: str):
        return self.blobs.setdefault(key, _FakeBlob())


def test_update_model_pool_active_clears_stale_live_ic_fields():
    bucket = _FakeBucket(
        {
            "models": {
                "GNN": {
                    "version": "old",
                    "gcs_path": "universal/gnn/old.joblib",
                    "ic_4w_avg": 0.15,
                    "weekly_ic": [0.15],
                    "rolling_ic": 0.15,
                    "last_ic_by_segment": {"LISTED": {"ic": 0.15}},
                    "model_cpcv": {"oos_ic": 0.02},
                    "artifact_backfill": {"source": "legacy_shadow"},
                }
            }
        }
    )

    result = gnn_training._update_model_pool_active(
        bucket,
        version="new",
        artifact_path="universal/gnn/new.pt",
        metadata={
            "oos_ic": 0.04,
            "daily_ic_count": 55,
            "validation_range": ["2026-02-11", "2026-05-14"],
        },
        reason="test",
    )

    updated = json.loads(bucket.blob("universal/model_pool.json").download_as_text())
    entry = updated["models"]["GNN"]
    assert result["new_version"] == "new"
    assert entry["gcs_path"] == "universal/gnn/new.pt"
    assert entry["last_ic_status"] == "awaiting_live_ic"
    for field in gnn_training.STALE_PROMOTION_FIELDS:
        assert field not in entry
    assert entry["retired_versions"][0]["ic_4w_avg_at_retire"] == 0.15


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
