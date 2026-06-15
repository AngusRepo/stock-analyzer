from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import strategy_similarity  # noqa: E402


def test_strategy_similarity_router_returns_modal_python_evidence(monkeypatch):
    async def fake_strategy_similarity_evidence(payload: dict) -> dict:
        return {
            "schema_version": "strategy-similarity-evidence-v1",
            "source": "modal_python",
            "algorithm_owner": "ml-service-modal-python",
            "strategies_seen": len(payload.get("strategies") or []),
        }

    monkeypatch.setattr(
        strategy_similarity.modal_client,
        "strategy_similarity_evidence",
        fake_strategy_similarity_evidence,
    )

    result = asyncio.run(strategy_similarity.build_strategy_similarity_evidence({
        "strategies": [
            {"strategy_id": "trend_a", "symbols": ["2330", "2317"]},
        ],
    }))

    assert result["source"] == "modal_python"
    assert result["algorithm_owner"] == "ml-service-modal-python"
    assert result["strategies_seen"] == 1


def test_strategy_similarity_router_fails_closed_when_modal_unavailable(monkeypatch):
    async def fake_strategy_similarity_evidence(payload: dict) -> dict:
        raise RuntimeError("modal unavailable")

    monkeypatch.setattr(
        strategy_similarity.modal_client,
        "strategy_similarity_evidence",
        fake_strategy_similarity_evidence,
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(strategy_similarity.build_strategy_similarity_evidence({"strategies": []}))

    assert exc_info.value.status_code == 503
    assert "strategy_similarity_evidence_unavailable" in str(exc_info.value.detail)


def test_hdbscan_research_audit_router_is_shadow_only(monkeypatch):
    def fake_hdbscan_research_audit(feature_matrix, labels, *, min_cluster_size, min_samples):
        return {
            "schema_version": "hdbscan-research-audit-v1",
            "status": "computed",
            "production_decision_path": False,
            "production_selector": False,
            "allowed_use": "research_shadow_only",
            "algorithm": "sklearn.cluster.HDBSCAN",
            "strategy_count": len(labels),
            "hdbscan_cluster_id": {labels[0]: 0, labels[1]: 0},
            "outlier_score": {labels[0]: 0.1, labels[1]: 0.2},
            "cluster_stability": {"0": 0.9},
            "candidate_new_style": [],
            "min_cluster_size_seen": min_cluster_size,
            "min_samples_seen": min_samples,
        }

    monkeypatch.setattr(
        strategy_similarity.similarity_evidence,
        "hdbscan_research_audit",
        fake_hdbscan_research_audit,
    )

    result = asyncio.run(strategy_similarity.build_hdbscan_research_audit({
        "feature_matrix": [[0.0, 0.0], [0.1, 0.1]],
        "labels": ["strategy_a", "strategy_b"],
        "min_cluster_size": 2,
        "min_samples": 1,
    }))

    assert result["route_owner"] == "ml-controller"
    assert result["endpoint"] == "/l125/hdbscan_research_audit"
    assert result["production_decision_path"] is False
    assert result["production_selector"] is False
    assert result["allowed_use"] == "research_shadow_only"
    assert result["algorithm"] == "sklearn.cluster.HDBSCAN"
    assert result["min_cluster_size_seen"] == 2
    assert result["min_samples_seen"] == 1
    assert "selected" not in result
    assert "BUY" not in result


def test_hdbscan_research_audit_router_rejects_production_intent():
    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(strategy_similarity.build_hdbscan_research_audit({
            "feature_matrix": [[0.0, 0.0], [0.1, 0.1]],
            "labels": ["strategy_a", "strategy_b"],
            "mutation_allowed": True,
        }))

    assert exc_info.value.status_code == 400
    assert "shadow-only" in str(exc_info.value.detail)
