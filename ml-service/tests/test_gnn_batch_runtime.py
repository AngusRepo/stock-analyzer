from __future__ import annotations

import numpy as np
import pytest

from app import gnn_batch_runtime, model_pool


def test_correlation_edge_index_builds_batch_context_graph():
    returns_matrix = np.asarray(
        [
            [0.01, 0.02, 0.03, 0.04],
            [0.011, 0.021, 0.031, 0.041],
            [-0.04, -0.03, -0.02, -0.01],
        ],
        dtype=np.float32,
    )

    edge_index, report = gnn_batch_runtime.build_correlation_edge_index(
        returns_matrix,
        threshold=0.9,
        top_k=0,
    )

    edges = {tuple(edge) for edge in edge_index.T.tolist()}
    assert (0, 1) in edges
    assert (1, 0) in edges
    assert report["n_nodes"] == 3
    assert report["n_edges"] == edge_index.shape[1]


def test_graphsage_artifact_requires_pt_batch_context_path(monkeypatch):
    gnn_batch_runtime.clear_graphsage_artifact_cache()
    monkeypatch.setattr(
        model_pool,
        "load_pool",
        lambda: {
            "models": {
                "GNN": {
                    "status": "active",
                    "version": "v1",
                    "gcs_path": "universal/gnn/v1.joblib",
                }
            }
        },
    )

    with pytest.raises(RuntimeError, match="GraphSAGE .* batch-context artifact"):
        gnn_batch_runtime.load_graphsage_artifact()
