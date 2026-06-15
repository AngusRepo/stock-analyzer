from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, HTTPException

from services import modal_client, similarity_evidence


router = APIRouter(prefix="/l125", tags=["l125-strategy-similarity"])


@router.post("/strategy_similarity_evidence")
async def build_strategy_similarity_evidence(
    payload: dict[str, Any] | None = Body(default=None),
) -> dict[str, Any]:
    """Proxy L1.25 strategy similarity evidence to Modal/Python.

    This endpoint is intentionally Modal-only. If Modal is unavailable, callers
    must treat the evidence as unavailable instead of falling back to a Worker
    algorithm owner.
    """

    try:
        return await modal_client.strategy_similarity_evidence(payload or {})
    except Exception as exc:  # noqa: BLE001 - HTTP surface should fail closed.
        raise HTTPException(
            status_code=503,
            detail=f"strategy_similarity_evidence_unavailable: {type(exc).__name__}: {exc}",
        ) from exc


@router.post("/hdbscan_research_audit")
async def build_hdbscan_research_audit(
    payload: dict[str, Any] | None = Body(default=None),
) -> dict[str, Any]:
    """Run research/shadow-only HDBSCAN strategy redundancy audit.

    This endpoint does not select, rank, promote, persist, or mutate production
    state. Any production-decision intent is rejected before fitting HDBSCAN.
    """

    body = payload or {}
    forbidden_flags = (
        "mutation_allowed",
        "persist_results",
        "persist_confirm",
        "production_decision_path",
        "production_selector",
        "promotion_ready",
    )
    if any(bool(body.get(flag)) for flag in forbidden_flags):
        raise HTTPException(status_code=400, detail="hdbscan research audit is shadow-only and cannot mutate or promote")

    feature_matrix = body.get("feature_matrix")
    labels = body.get("labels")
    if not isinstance(feature_matrix, list) or not isinstance(labels, list):
        raise HTTPException(status_code=400, detail="feature_matrix and labels are required")

    try:
        min_cluster_size = int(body.get("min_cluster_size") or 5)
        min_samples_raw = body.get("min_samples")
        min_samples = None if min_samples_raw in (None, "") else int(min_samples_raw)
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="invalid HDBSCAN min_cluster_size or min_samples") from exc

    result = similarity_evidence.hdbscan_research_audit(
        feature_matrix,
        labels,
        min_cluster_size=min_cluster_size,
        min_samples=min_samples,
    )
    return {
        **result,
        "route_owner": "ml-controller",
        "endpoint": "/l125/hdbscan_research_audit",
        "production_decision_path": False,
        "production_selector": False,
        "allowed_use": "research_shadow_only",
    }
