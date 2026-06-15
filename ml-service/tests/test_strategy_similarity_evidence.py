from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _require_strategy_similarity_deps() -> None:
    pytest.importorskip("networkx")
    pytest.importorskip("sklearn_extra")


def test_strategy_similarity_evidence_is_modal_python_official_evidence_only():
    _require_strategy_similarity_deps()

    from app.strategy_similarity_evidence import build_strategy_similarity_evidence

    evidence = build_strategy_similarity_evidence({
        "edge_threshold": 0.5,
        "strategies": [
            {"strategy_id": "quality_a", "family_id": "QUALITY", "symbols": ["2330", "2317", "2454"]},
            {"strategy_id": "quality_b", "family_id": "QUALITY", "symbols": ["2330", "2317", "2308"]},
            {"strategy_id": "chip_flow", "family_id": "CHIP", "symbols": ["3037", "2344", "2408"]},
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
    assert evidence["edge_count"] >= 1
    assert evidence["component_count"] == 2
    assert evidence["strategy_cluster_id"]["quality_a"] == evidence["strategy_cluster_id"]["quality_b"]
    assert evidence["strategy_cluster_size"]["quality_a"] == 2
    assert evidence["strategy_cluster_id"]["chip_flow"] != evidence["strategy_cluster_id"]["quality_a"]
    assert any(row["medoid_evidence"]["method"] == "pam" for row in evidence["components"] if row["cluster_size"] > 1)
    assert evidence["kmedoids_pam_preflight_status"] == "pass"
    assert evidence["kmedoids_pam_preflight"]["status"] == "pass"

    forbidden = {"selected", "BUY", "buy", "top_k", "topK", "rank_override"}
    assert forbidden.isdisjoint(evidence.keys())


def test_kmedoids_pam_preflight_uses_official_sklearn_extra():
    _require_strategy_similarity_deps()

    from app.strategy_similarity_evidence import kmedoids_pam_runtime_preflight

    preflight = kmedoids_pam_runtime_preflight()

    assert preflight["status"] == "pass"
    assert preflight["algorithm"] == "sklearn_extra.cluster.KMedoids"
    assert preflight["method"] == "pam"
    assert preflight["self_implemented_fallback"] is False
    assert preflight["production_decision_path"] is False
