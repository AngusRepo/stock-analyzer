from __future__ import annotations

import io

import numpy as np
import pytest

from app import gnn_training
from app.formal_feature_contract import FEATURE131_SEMANTIC
from app.gnn_graph_contract import (
    GNN_GRAPH_SEMANTIC_VERSION,
    GNN_GRAPH_VARIANTS,
    build_feature_sector_edge_index,
    build_industry_edge_index,
)

from tests.challenger_fixtures import PREFIX, put_industry_sidecar, synthetic_prep


@pytest.fixture(autouse=True)
def _source_sha(monkeypatch):
    monkeypatch.setenv("STOCKVISION_SOURCE_SHA", "0" * 40)


def _edge_set(edge_index):
    return {(int(a), int(b)) for a, b in np.asarray(edge_index).T}


def test_industry_clique_links_every_same_industry_pair_and_nothing_else():
    rng = np.random.default_rng(0)
    industries = np.asarray(["a", "b", "a", "c", "a", "b"])
    edges, report = build_industry_edge_index(rng.normal(size=(6, 4)), industries,
                                              variant="industry", top_k=2, threshold=0.25)
    expected = {(i, j) for i in range(6) for j in range(6) if i != j and industries[i] == industries[j]}
    assert _edge_set(edges) == expected
    assert report["isolated_nodes"] == 1  # the lone "c" node
    assert report["semantic_version"] == GNN_GRAPH_VARIANTS["industry"]["semantic_version"]
    assert report["semantic_version"] != GNN_GRAPH_SEMANTIC_VERSION


def test_industry_plus_cosine_is_the_union_with_incumbent_label_free_cosine_edges():
    rng = np.random.default_rng(1)
    x = rng.normal(size=(8, 5))
    industries = np.asarray(list("aabbccdd"))
    clique, _ = build_industry_edge_index(x, industries, variant="industry", top_k=3, threshold=0.1)
    union, report = build_industry_edge_index(x, industries, variant="industry_plus_cosine", top_k=3, threshold=0.1)
    cosine, _ = build_feature_sector_edge_index(x, np.asarray([""] * 8), top_k=3, threshold=0.1)
    assert _edge_set(union) == _edge_set(clique) | _edge_set(cosine)
    assert report["cosine_edge_count"] == cosine.shape[1]


def test_industry_graph_fails_closed_without_pit_label():
    with pytest.raises(ValueError, match="requires_pit_industry"):
        build_industry_edge_index(np.ones((3, 2)), np.asarray(["a", "unknown", "a"]),
                                  variant="industry", top_k=1, threshold=0.0)


def _payload(info, **extra):
    dates = info["signal_dates"]
    return {
        "gcs_prefix": PREFIX, "batch_count": info["batch_count"], "feature_semantic_version": FEATURE131_SEMANTIC,
        "feature_release_mode": "approved_full131_v1", "generation_mode": "purged_oof",
        "cohort_id": "cohort-test", "fold_id": "w0", "window_id": 0, "output_model_version": "cohort-test-w0",
        "label_horizon_days": 5, "epochs": 2, "hidden_dim": 8, "max_train_dates_per_epoch": 10,
        "train_start": dates[0], "train_end": dates[59], "test_start": dates[65], "test_end": dates[79],
        **extra,
    }


@pytest.mark.parametrize("variant", ["industry", "industry_plus_cosine"])
def test_challenger_fold_writes_its_own_artifact_and_oof(monkeypatch, variant):
    bucket, info = synthetic_prep()
    monkeypatch.setattr(gnn_training, "_get_bucket", lambda: bucket)
    sidecar = put_industry_sidecar(bucket, info, snapshot_dates=[info["signal_dates"][20]])
    result = gnn_training.train_graphsage_universal(
        _payload(info, graph_variant=variant, industry_exposure=sidecar))

    model_name = GNN_GRAPH_VARIANTS[variant]["model_name"]
    folder = {"industry": "gnn_industry", "industry_plus_cosine": "gnn_industry_cosine"}[variant]
    assert result["model"] == model_name
    assert result["artifact_path"] == f"universal/{folder}/cohort-test-w0.pt"
    graph = result["metadata"]["graph_context"]
    assert graph["semantic_version"] == GNN_GRAPH_VARIANTS[variant]["semantic_version"]
    assert graph["industry_coverage"]["first_labelled_date"] == info["signal_dates"][20]
    assert result["metadata"]["model_name"] == model_name
    assert result["metadata"]["challenger"]["compares_against"] == "GNN"
    oof = result["oof_artifact"]
    assert oof["path"] == f"{PREFIX}/oof/cohort-test/w0/{model_name.lower()}.npz"
    data = np.load(io.BytesIO(bucket.blob(oof["path"]).download_as_bytes()), allow_pickle=True)
    assert min(data["dates"].tolist()) >= info["signal_dates"][65]
    assert len(data["raw_scores"]) == 15 * len(info["symbol_list"])


def test_incumbent_path_is_unchanged_without_graph_variant(monkeypatch):
    bucket, info = synthetic_prep()
    monkeypatch.setattr(gnn_training, "_get_bucket", lambda: bucket)
    result = gnn_training.train_graphsage_universal(_payload(info))
    assert result["model"] == "GNN"
    assert result["artifact_path"] == "universal/gnn/cohort-test-w0.pt"
    assert result["metadata"]["graph_context"]["semantic_version"] == GNN_GRAPH_SEMANTIC_VERSION
    assert "graph_variant" not in result["metadata"]["graph_context"]  # incumbent metadata shape untouched
    assert "graph_variant" not in result["metadata"]["training_params"]
    assert result["oof_artifact"]["path"].endswith("/gnn.npz")


def test_unknown_graph_variant_is_rejected(monkeypatch):
    bucket, info = synthetic_prep(n_symbols=6)
    monkeypatch.setattr(gnn_training, "_get_bucket", lambda: bucket)
    with pytest.raises(ValueError, match="gnn_graph_variant_invalid"):
        gnn_training.train_graphsage_universal(_payload(info, graph_variant="sector_v2"))
