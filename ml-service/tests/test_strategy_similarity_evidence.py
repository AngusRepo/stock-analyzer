from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _require_strategy_similarity_deps() -> None:
    pytest.importorskip("networkx")
    pytest.importorskip("sklearn_extra")


def _oof(values: list[float]) -> list[dict[str, object]]:
    return [
        {
            "signal_date": f"2026-07-{index:02d}",
            "residual_return": value,
            "sample_count": 12,
        }
        for index, value in enumerate(values, start=1)
    ]


def _install_fake_kmedoids(monkeypatch):
    pytest.importorskip("networkx")
    from app import strategy_similarity_evidence as module

    class FakeKMedoids:
        def __init__(self, n_clusters=1, **_kwargs):
            self.n_clusters = n_clusters

        def fit(self, matrix):
            count = min(self.n_clusters, len(matrix))
            self.medoid_indices_ = module.np.arange(count, dtype=int)
            self.labels_ = module.np.zeros(len(matrix), dtype=int)
            return self

    monkeypatch.setattr(module, "KMedoids", FakeKMedoids)
    monkeypatch.setattr(module, "_KMEDOIDS_IMPORT_ERROR", None)
    return module


def test_strategy_similarity_evidence_is_modal_python_official_evidence_only(monkeypatch):
    module = _install_fake_kmedoids(monkeypatch)
    build_strategy_similarity_evidence = module.build_strategy_similarity_evidence

    evidence = build_strategy_similarity_evidence({
        "edge_threshold": 0.5,
        "strategies": [
            {
                "strategy_id": "quality_a",
                "family_id": "QUALITY",
                "symbols": ["2330"],
                "oof_returns": _oof([0.01, 0.02, 0.015, 0.03, 0.025, 0.04, 0.035, 0.05]),
            },
            {
                "strategy_id": "quality_b",
                "family_id": "QUALITY",
                "symbols": ["2317"],
                "oof_returns": _oof([0.011, 0.019, 0.016, 0.031, 0.024, 0.041, 0.034, 0.051]),
            },
            {
                "strategy_id": "chip_flow",
                "family_id": "CHIP",
                "symbols": ["3037"],
                "oof_returns": _oof([-0.01, -0.02, -0.015, -0.03, -0.025, -0.04, -0.035, -0.05]),
            },
        ],
    })

    assert evidence["schema_version"] == "strategy-similarity-evidence-v1"
    assert evidence["status"] == "computed"
    assert evidence["version"] == "strategy-similarity-graph-v1"
    assert evidence["source"] == "modal_python"
    assert evidence["algorithm_owner"] == "ml-service-modal-python"
    assert evidence["graph_algorithm"] == "networkx.Graph+networkx.connected_components"
    assert evidence["medoid_algorithm"] == "sklearn_extra.cluster.KMedoids(method='pam')"
    assert evidence["evidence_only"] is True
    assert evidence["production_selector"] is False
    assert evidence["global_k_hardcoded"] is False
    assert evidence["component_count_source"] == "networkx.connected_components"
    assert evidence["method"] == "networkx_connected_components_oof_residual_correlation"
    assert evidence["input_scope"] == "mature_oof_residual_returns_with_same_day_overlap_diagnostic"
    assert evidence["eligible_oof_pair_count"] == 3
    assert evidence["paired_date_max"] == 8
    assert evidence["oof_max_date"] == "2026-07-08"
    assert evidence["edge_count"] >= 1
    assert evidence["component_count"] == 2
    assert evidence["strategy_cluster_id"]["quality_a"] == evidence["strategy_cluster_id"]["quality_b"]
    assert evidence["strategy_cluster_size"]["quality_a"] == 2
    assert evidence["strategy_cluster_id"]["chip_flow"] != evidence["strategy_cluster_id"]["quality_a"]
    quality_pair = evidence["pairwise_oof_evidence"]["quality_a|quality_b"]
    assert quality_pair["eligible"] is True
    assert quality_pair["same_day_jaccard_diagnostic"] == 0.0
    assert quality_pair["return_correlation_lcb90"] > 0.5
    assert quality_pair["similarity"] == quality_pair["return_correlation_lcb90"]
    assert any(row["medoid_evidence"]["method"] == "pam" for row in evidence["components"] if row["cluster_size"] > 1)
    assert evidence["kmedoids_pam_preflight_status"] == "pass"
    assert evidence["kmedoids_pam_preflight"]["status"] == "pass"

    forbidden = {"selected", "BUY", "buy", "top_k", "topK", "rank_override"}
    assert forbidden.isdisjoint(evidence.keys())


def test_strategy_similarity_blocks_same_day_overlap_without_mature_oof_evidence(monkeypatch):
    module = _install_fake_kmedoids(monkeypatch)
    build_strategy_similarity_evidence = module.build_strategy_similarity_evidence

    evidence = build_strategy_similarity_evidence({
        "strategies": [
            {"strategy_id": "alpha_a", "symbols": ["2330", "2317"]},
            {"strategy_id": "alpha_b", "symbols": ["2330", "2317"]},
        ],
    })

    assert evidence["status"] == "blocked"
    assert evidence["blocked_reason"] == "insufficient_paired_mature_oof_residual_returns"
    assert evidence["eligible_oof_pair_count"] == 0
    assert evidence["edge_count"] == 0
    pair = evidence["pairwise_oof_evidence"]["alpha_a|alpha_b"]
    assert pair["same_day_jaccard_diagnostic"] == 1.0
    assert pair["similarity"] == 0.0


def test_kmedoids_pam_preflight_uses_official_sklearn_extra():
    _require_strategy_similarity_deps()

    from app.strategy_similarity_evidence import kmedoids_pam_runtime_preflight

    preflight = kmedoids_pam_runtime_preflight()

    assert preflight["status"] == "pass"
    assert preflight["algorithm"] == "sklearn_extra.cluster.KMedoids"
    assert preflight["method"] == "pam"
    assert preflight["self_implemented_fallback"] is False
    assert preflight["production_decision_path"] is False
