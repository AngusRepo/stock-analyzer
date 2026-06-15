from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.portfolio_allocation import allocate_sparse_tangent_with_evidence  # noqa: E402
from services.similarity_evidence import (  # noqa: E402
    apply_cluster_exposure_cap,
    hdbscan_research_audit,
    similarity_components,
    symbol_cluster_evidence,
)


def _require_similarity_deps() -> None:
    pytest.importorskip("networkx")
    pytest.importorskip("sklearn")


def _history() -> dict[str, list[float]]:
    return {
        "AAA": [0.01, 0.012, 0.011, 0.013, 0.014, 0.012],
        "BBB": [0.0102, 0.0122, 0.0111, 0.0131, 0.0141, 0.0121],
        "CCC": [-0.02, 0.006, -0.004, 0.008, -0.003, 0.005],
    }


def test_similarity_evidence_uses_official_graph_and_ledoitwolf_without_selector_fields():
    _require_similarity_deps()

    evidence = similarity_components(
        ["AAA", "BBB", "CCC"],
        _history(),
        weights={"AAA": 0.4, "BBB": 0.4, "CCC": 0.2},
        edge_threshold=0.6,
    )

    assert evidence["schema_version"] == "similarity-evidence-v1"
    assert evidence["evidence_only"] is True
    assert evidence["method"] == "networkx_connected_components_abs_correlation"
    assert evidence["covariance_method"] == "ledoit_wolf"
    assert evidence["component_count"] >= 1
    assert evidence["effective_independent_count"] > 0
    assert symbol_cluster_evidence("AAA", evidence)["cluster_id"] == symbol_cluster_evidence("BBB", evidence)["cluster_id"]
    assert not ({"selected", "BUY", "top_k", "rank_override"} & set(evidence))


def test_cluster_exposure_cap_does_not_add_replacement_symbols():
    _require_similarity_deps()

    evidence = similarity_components(
        ["AAA", "BBB", "CCC"],
        _history(),
        weights={"AAA": 0.5, "BBB": 0.4, "CCC": 0.1},
        edge_threshold=0.6,
    )
    capped, applied = apply_cluster_exposure_cap(
        {"AAA": 0.5, "BBB": 0.4, "CCC": 0.1},
        evidence,
        max_cluster_weight=0.55,
    )

    assert applied is True
    assert set(capped).issubset({"AAA", "BBB", "CCC"})
    capped_evidence = similarity_components(["AAA", "BBB", "CCC"], _history(), weights=capped, edge_threshold=0.6)
    aaa_cluster = symbol_cluster_evidence("AAA", capped_evidence)
    assert aaa_cluster["cluster_exposure"] <= 0.55 + 1e-8


def test_sparse_tangent_allocation_returns_cluster_and_covariance_evidence():
    _require_similarity_deps()

    result = allocate_sparse_tangent_with_evidence(
        [
            {"symbol": "AAA", "score": 80, "expected_return": 0.03},
            {"symbol": "BBB", "score": 79, "expected_return": 0.028},
            {"symbol": "CCC", "score": 78, "expected_return": 0.02},
        ],
        _history(),
        top_k=3,
        max_weight=0.8,
        max_cluster_weight=0.55,
        cluster_edge_threshold=0.6,
    )

    assert result["weights"]
    assert result["similarity_evidence"]["covariance_method"] == "ledoit_wolf"
    assert result["max_cluster_weight"] == 0.55
    assert "cluster_penalty_applied" in result
    assert result["similarity_evidence"]["pairwise_corr_max"] >= 0


def test_hdbscan_research_audit_is_shadow_only_and_not_a_selector():
    result = hdbscan_research_audit(
        [
            [0.0, 0.0],
            [0.1, 0.1],
            [5.0, 5.0],
            [5.1, 5.1],
        ],
        ["strategy_alpha", "strategy_alpha_variant", "strategy_beta", "strategy_beta_variant"],
        min_cluster_size=2,
        min_samples=1,
    )

    assert result["schema_version"] == "hdbscan-research-audit-v1"
    assert result["production_decision_path"] is False
    assert result["status"] in {"blocked", "computed"}
    if result["status"] == "computed":
        assert result["production_selector"] is False
        assert result["allowed_use"] == "research_shadow_only"
        assert result["algorithm"] == "sklearn.cluster.HDBSCAN"
        assert "strategy_alpha" in result["hdbscan_cluster_id"]
        assert "outlier_score" in result
        assert "cluster_stability" in result
        assert "candidate_new_style" in result
        assert not ({"selected", "BUY", "top_k", "rank_override"} & set(result))
