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
    assert report["edge_source"] == "price_correlation_v1"


def test_correlation_edge_index_keeps_source_when_no_edges():
    returns_matrix = np.asarray(
        [
            [0.01, 0.0, 0.0, 0.0],
            [0.0, 0.02, 0.0, 0.0],
        ],
        dtype=np.float32,
    )

    edge_index, report = gnn_batch_runtime.build_correlation_edge_index(
        returns_matrix,
        threshold=0.99,
        top_k=0,
    )

    assert edge_index.shape == (2, 0)
    assert report["n_edges"] == 0
    assert report["edge_source"] == "price_correlation_v1"


def test_multi_similarity_graph_is_production_edge_context_not_selector():
    returns_matrix = np.asarray(
        [
            [0.01, 0.02, 0.03, 0.04],
            [0.011, 0.021, 0.031, 0.041],
            [-0.04, -0.03, -0.02, -0.01],
        ],
        dtype=np.float32,
    )
    node_features = np.asarray(
        [
            [1.0, 0.2],
            [0.98, 0.22],
            [-0.4, 1.0],
        ],
        dtype=np.float32,
    )

    edge_index, report = gnn_batch_runtime.build_multi_similarity_edge_index(
        returns_matrix,
        node_features,
        context_records=[
            {
                "strategy_hit_vector": {"trend": 1.0, "value": 0.0},
                "strategy_affinity_vector": {"trend": 90.0, "value": 10.0},
                "family_affinity_vector": {"momentum": 80.0},
                "sector_factor": {
                    "sector_key": "semiconductor",
                    "sector_encoded": 1.0,
                    "market_cap_bucket": 3.0,
                    "sector_peer_return_5d": 0.02,
                    "stock_vs_sector": 0.01,
                },
                "finlab_chip_flow": {"foreign_net": 1200.0, "trust_net": 100.0, "dealer_net": 20.0},
                "regime": {"risk_score": 0.4, "retail_pct": 0.1},
            },
            {
                "strategy_hit_vector": {"trend": 1.0, "value": 0.0},
                "strategy_affinity_vector": {"trend": 85.0, "value": 15.0},
                "family_affinity_vector": {"momentum": 75.0},
                "sector_factor": {
                    "sector_key": "semiconductor",
                    "sector_encoded": 1.0,
                    "market_cap_bucket": 3.0,
                    "sector_peer_return_5d": 0.021,
                    "stock_vs_sector": 0.012,
                },
                "finlab_chip_flow": {"foreign_net": 1100.0, "trust_net": 90.0, "dealer_net": 15.0},
                "regime": {"risk_score": 0.45, "retail_pct": 0.12},
            },
            {
                "strategy_hit_vector": {"trend": 0.0, "value": 1.0},
                "strategy_affinity_vector": {"trend": 5.0, "value": 88.0},
                "family_affinity_vector": {"value": 82.0},
                "sector_factor": {
                    "sector_key": "financial",
                    "sector_encoded": 7.0,
                    "market_cap_bucket": 2.0,
                    "sector_peer_return_5d": -0.01,
                    "stock_vs_sector": -0.02,
                },
                "finlab_chip_flow": {"foreign_net": -800.0, "trust_net": -40.0, "dealer_net": -10.0},
                "regime": {"risk_score": 0.7, "retail_pct": 0.5},
            },
        ],
    )

    assert edge_index.shape[0] == 2
    assert report["edge_source"] == "multi_similarity_graph_v1"
    assert report["production_edge_replaces"] == "price_correlation_v1"
    assert report["allowed_use"] == "production_gnn_edge_context"
    assert report["production_edge_active"] is True
    assert report["selector"] is False
    assert report["top_k"] is None
    assert report["edge_count"] >= 0
    assert report["component_count"] >= 1
    assert report["avg_degree"] >= 0
    assert report["source_coverage"]["return_correlation"] is True
    assert report["source_coverage"]["feature_similarity"] is True
    assert report["source_coverage"]["strategy_co_hit"] is True
    assert report["source_coverage"]["sector_factor_similarity"] is True
    assert report["source_coverage"]["finlab_chip_flow_similarity"] is True
    assert report["source_coverage"]["regime_co_movement"] is True
    assert "selected" not in report
    assert "BUY" not in report
    assert "shadow_edge_experiment" not in report


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


def test_graphsage_standardizes_features_from_artifact_metadata():
    node_features = np.asarray(
        [
            [3.0, 10.0],
            [5.0, 14.0],
        ],
        dtype=np.float32,
    )

    out = gnn_batch_runtime._standardize_node_features(
        node_features,
        {
            "feature_standardization": {
                "method": "robust_median_iqr",
                "medians": [1.0, 2.0],
                "scales": [2.0, 4.0],
            }
        },
    )

    np.testing.assert_allclose(
        out,
        np.asarray(
            [
                [1.0, 2.0],
                [2.0, 3.0],
            ],
            dtype=np.float32,
        ),
    )


def test_graphsage_standardization_rejects_width_mismatch():
    node_features = np.asarray([[3.0, 10.0]], dtype=np.float32)

    with pytest.raises(RuntimeError, match="standardization width mismatch"):
        gnn_batch_runtime._standardize_node_features(
            node_features,
            {
                "feature_standardization": {
                    "medians": [1.0],
                    "scales": [2.0],
                }
            },
        )


def test_graphsage_standardization_applies_artifact_clip_value():
    node_features = np.asarray([[101.0, -99.0]], dtype=np.float32)

    out = gnn_batch_runtime._standardize_node_features(
        node_features,
        {
            "feature_standardization": {
                "medians": [1.0, 1.0],
                "scales": [1.0, 1.0],
                "clip_value": 8.0,
            }
        },
    )

    np.testing.assert_allclose(out, np.asarray([[8.0, -8.0]], dtype=np.float32))
