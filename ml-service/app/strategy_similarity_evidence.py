"""L1.25 strategy similarity evidence owned by Modal/Python.

This module is evidence-only. It computes strategy overlap communities and
representative medoids, but never selects stocks, emits BUY, or overrides the
PLE router.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import networkx as nx

try:
    from sklearn_extra.cluster import KMedoids
except Exception as exc:  # pragma: no cover - broken or unbuilt runtime only.
    KMedoids = None  # type: ignore[assignment]
    _KMEDOIDS_IMPORT_ERROR: Exception | None = exc
else:
    _KMEDOIDS_IMPORT_ERROR = None


STRATEGY_SIMILARITY_EVIDENCE_VERSION = "strategy-similarity-evidence-v1"
KMEDOIDS_PAM_PREFLIGHT_VERSION = "kmedoids-pam-preflight-v1"


def _clean_text(value: object) -> str:
    return str(value or "").strip()


def _clean_strategy_id(value: object) -> str:
    return _clean_text(value)


def _clean_symbol(value: object) -> str:
    return _clean_text(value).upper()


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _round(value: object, digits: int = 8) -> float:
    return round(_to_float(value), digits)


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 0.0
    union_size = len(left | right)
    if union_size <= 0:
        return 0.0
    return len(left & right) / union_size


def _strategy_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    rows = payload.get("strategies")
    if isinstance(rows, list):
        normalized = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            strategy_id = _clean_strategy_id(row.get("strategy_id") or row.get("id") or row.get("strategyId"))
            if not strategy_id:
                continue
            symbols = row.get("symbols") or row.get("holdings") or row.get("candidates") or []
            normalized.append({
                "strategy_id": strategy_id,
                "family_id": _clean_text(row.get("family_id") or row.get("familyId") or row.get("family")),
                "symbols": sorted({
                    _clean_symbol(symbol)
                    for symbol in symbols
                    if _clean_symbol(symbol)
                }),
            })
        return normalized

    strategy_symbols = payload.get("strategy_symbols") or payload.get("strategySymbols") or {}
    strategy_family = payload.get("strategy_family") or payload.get("strategyFamily") or {}
    if not isinstance(strategy_symbols, dict):
        return []
    normalized = []
    for raw_strategy_id, raw_symbols in strategy_symbols.items():
        strategy_id = _clean_strategy_id(raw_strategy_id)
        if not strategy_id:
            continue
        symbols = raw_symbols if isinstance(raw_symbols, list) else []
        normalized.append({
            "strategy_id": strategy_id,
            "family_id": _clean_text(strategy_family.get(strategy_id) if isinstance(strategy_family, dict) else ""),
            "symbols": sorted({
                _clean_symbol(symbol)
                for symbol in symbols
                if _clean_symbol(symbol)
            }),
        })
    return normalized


def _adaptive_threshold(
    similarities: list[float],
    *,
    explicit_threshold: object = None,
    threshold_quantile: object = None,
    min_threshold: object = None,
    max_threshold: object = None,
) -> tuple[float, str]:
    explicit = _to_float(explicit_threshold, default=float("nan"))
    if math.isfinite(explicit):
        return round(max(0.0, min(1.0, explicit)), 6), "config_explicit"

    finite_values = [value for value in similarities if math.isfinite(value) and value > 0]
    if not finite_values:
        return 1.0, "adaptive_empty"
    q = max(0.0, min(1.0, _to_float(threshold_quantile, 0.9)))
    lower = max(0.0, min(1.0, _to_float(min_threshold, 0.55)))
    upper = max(lower, min(1.0, _to_float(max_threshold, 0.95)))
    threshold = float(np.quantile(np.asarray(finite_values, dtype=float), q))
    threshold = max(lower, min(upper, threshold))
    return round(threshold, 6), "adaptive_quantile"


def _distance_matrix(strategy_ids: list[str], symbols_by_strategy: dict[str, set[str]]) -> np.ndarray:
    matrix = np.zeros((len(strategy_ids), len(strategy_ids)), dtype=float)
    for left, left_id in enumerate(strategy_ids):
        for right, right_id in enumerate(strategy_ids):
            if left == right:
                matrix[left, right] = 0.0
            elif right > left:
                distance = 1.0 - _jaccard(symbols_by_strategy.get(left_id, set()), symbols_by_strategy.get(right_id, set()))
                matrix[left, right] = distance
                matrix[right, left] = distance
    return matrix


def _component_medoid(
    strategy_ids: list[str],
    symbols_by_strategy: dict[str, set[str]],
    *,
    random_state: int,
    kmedoids_preflight: dict[str, Any],
) -> dict[str, Any]:
    if not strategy_ids:
        return {"status": "empty", "strategy_id": None}
    if len(strategy_ids) == 1:
        return {
            "status": "singleton",
            "strategy_id": strategy_ids[0],
            "algorithm": "identity_singleton_component",
            "method": "not_applicable",
        }
    if KMedoids is None or kmedoids_preflight.get("status") != "pass":
        return {
            "status": "blocked",
            "reason": kmedoids_preflight.get("reason") or f"sklearn_extra_kmedoids_unavailable: {_KMEDOIDS_IMPORT_ERROR}",
            "self_implemented_fallback": False,
            "strategy_id": None,
        }

    matrix = _distance_matrix(strategy_ids, symbols_by_strategy)
    model = KMedoids(
        n_clusters=1,
        metric="precomputed",
        method="pam",
        init="heuristic",
        random_state=random_state,
    ).fit(matrix)
    medoid_index = int(model.medoid_indices_[0])
    return {
        "status": "computed",
        "strategy_id": strategy_ids[medoid_index],
        "algorithm": "sklearn_extra.cluster.KMedoids",
        "method": "pam",
        "metric": "precomputed_jaccard_distance",
        "n_clusters": 1,
        "scope": "single_networkx_component_representative",
    }


def kmedoids_pam_runtime_preflight() -> dict[str, Any]:
    """Validate official sklearn-extra KMedoids/PAM in the active runtime."""

    if KMedoids is None:
        return {
            "schema_version": KMEDOIDS_PAM_PREFLIGHT_VERSION,
            "status": "blocked",
            "reason": f"sklearn_extra_kmedoids_unavailable: {_KMEDOIDS_IMPORT_ERROR}",
            "production_decision_path": False,
            "self_implemented_fallback": False,
        }

    matrix = np.asarray(
        [
            [0.0, 0.1, 0.9, 1.0],
            [0.1, 0.0, 0.8, 0.9],
            [0.9, 0.8, 0.0, 0.1],
            [1.0, 0.9, 0.1, 0.0],
        ],
        dtype=float,
    )
    try:
        model = KMedoids(
            n_clusters=2,
            metric="precomputed",
            method="pam",
            init="heuristic",
            random_state=0,
        ).fit(matrix)
    except Exception as exc:  # pragma: no cover - depends on optional package ABI.
        return {
            "schema_version": KMEDOIDS_PAM_PREFLIGHT_VERSION,
            "status": "blocked",
            "reason": f"sklearn_extra_kmedoids_fit_failed: {exc}",
            "production_decision_path": False,
            "self_implemented_fallback": False,
        }
    return {
        "schema_version": KMEDOIDS_PAM_PREFLIGHT_VERSION,
        "status": "pass",
        "algorithm": "sklearn_extra.cluster.KMedoids",
        "method": "pam",
        "metric": "precomputed",
        "production_decision_path": False,
        "self_implemented_fallback": False,
        "medoid_indices": [int(value) for value in model.medoid_indices_.tolist()],
        "labels": [int(value) for value in model.labels_.tolist()],
    }


def build_strategy_similarity_evidence(payload: dict[str, Any] | None) -> dict[str, Any]:
    """Build L1.25 strategy-as-asset similarity evidence.

    Input is strategy -> supported symbols. Output is graph and medoid evidence
    consumed by L1.25/L1.5, never a stock selection list.
    """

    data = payload or {}
    rows = _strategy_rows(data)
    strategy_ids = [row["strategy_id"] for row in rows]
    kmedoids_preflight = kmedoids_pam_runtime_preflight()
    symbols_by_strategy = {
        row["strategy_id"]: set(row["symbols"])
        for row in rows
    }
    graph = nx.Graph()
    for row in rows:
        graph.add_node(
            row["strategy_id"],
            family_id=row.get("family_id") or "",
            support_count=len(row.get("symbols") or []),
        )

    similarities: list[float] = []
    for left_idx, left_id in enumerate(strategy_ids):
        for right_id in strategy_ids[left_idx + 1:]:
            similarities.append(_jaccard(symbols_by_strategy[left_id], symbols_by_strategy[right_id]))

    threshold, threshold_source = _adaptive_threshold(
        similarities,
        explicit_threshold=data.get("edge_threshold") or data.get("strategy_similarity_edge_threshold"),
        threshold_quantile=data.get("threshold_quantile") or data.get("strategy_similarity_threshold_quantile"),
        min_threshold=data.get("min_threshold"),
        max_threshold=data.get("max_threshold"),
    )

    max_pairwise = 0.0
    for left_idx, left_id in enumerate(strategy_ids):
        for right_id in strategy_ids[left_idx + 1:]:
            similarity = _jaccard(symbols_by_strategy[left_id], symbols_by_strategy[right_id])
            max_pairwise = max(max_pairwise, similarity)
            if similarity >= threshold:
                graph.add_edge(left_id, right_id, weight=round(similarity, 8), similarity=round(similarity, 8))

    components = [sorted(component) for component in nx.connected_components(graph)]
    components.sort(key=lambda members: min(strategy_ids.index(strategy_id) for strategy_id in members))

    random_state = int(_to_float(data.get("random_state"), 0))
    strategy_cluster_id: dict[str, str] = {}
    strategy_cluster_size: dict[str, int] = {}
    strategy_cluster_crowding_score: dict[str, float] = {}
    strategy_cluster_uniqueness_score: dict[str, float] = {}
    component_rows: list[dict[str, Any]] = []
    medoid_strategy_by_cluster: dict[str, str | None] = {}

    strategy_count = max(1, len(strategy_ids))
    for idx, members in enumerate(components):
        cluster_id = f"sc{idx:03d}"
        medoid = _component_medoid(
            members,
            symbols_by_strategy,
            random_state=random_state,
            kmedoids_preflight=kmedoids_preflight,
        )
        medoid_strategy_by_cluster[cluster_id] = medoid.get("strategy_id")
        size = len(members)
        crowding = round(max(0.0, min(1.0, (size - 1) / strategy_count)), 6)
        uniqueness = round(max(0.0, min(1.0, 1.0 - crowding)), 6)
        for strategy_id in members:
            strategy_cluster_id[strategy_id] = cluster_id
            strategy_cluster_size[strategy_id] = size
            strategy_cluster_crowding_score[strategy_id] = crowding
            strategy_cluster_uniqueness_score[strategy_id] = uniqueness
        component_rows.append({
            "cluster_id": cluster_id,
            "strategies": members,
            "cluster_size": size,
            "cluster_crowding_score": crowding,
            "cluster_uniqueness_score": uniqueness,
            "representative_medoid_strategy": medoid.get("strategy_id"),
            "medoid_evidence": medoid,
        })

    if rows:
        cluster_sizes = [len(component) for component in components]
        hhi = sum((size / len(rows)) ** 2 for size in cluster_sizes)
        effective_strategy_count = round(1.0 / max(hhi, 1e-12), 6)
    else:
        effective_strategy_count = 0.0

    return {
        "schema_version": STRATEGY_SIMILARITY_EVIDENCE_VERSION,
        "status": "computed" if kmedoids_preflight.get("status") == "pass" else "blocked",
        "version": "strategy-similarity-graph-v1",
        "evidence_only": True,
        "source": "modal_python",
        "algorithm_owner": "ml-service-modal-python",
        "graph_algorithm": "networkx.Graph+networkx.connected_components",
        "method": "networkx_connected_components_jaccard_overlap",
        "medoid_algorithm": "sklearn_extra.cluster.KMedoids(method='pam')",
        "medoid_scope": "per_graph_component_representative",
        "production_selector": False,
        "production_decision_path": False,
        "self_implemented_algorithm": False,
        "global_k_hardcoded": False,
        "component_count_source": "networkx.connected_components",
        "edge_threshold": threshold,
        "edge_threshold_source": threshold_source,
        "threshold_quantile": _round(data.get("threshold_quantile") or data.get("strategy_similarity_threshold_quantile") or 0.9, 6),
        "strategy_count": len(rows),
        "edge_count": int(graph.number_of_edges()),
        "component_count": len(component_rows),
        "effective_strategy_count": effective_strategy_count,
        "pairwise_overlap_max": round(max_pairwise, 8),
        "strategy_cluster_id": strategy_cluster_id,
        "strategy_cluster_size": strategy_cluster_size,
        "strategy_cluster_crowding_score": strategy_cluster_crowding_score,
        "strategy_cluster_uniqueness_score": strategy_cluster_uniqueness_score,
        "medoid_strategy_by_cluster": medoid_strategy_by_cluster,
        "components": component_rows,
        "kmedoids_pam_preflight_status": kmedoids_preflight.get("status"),
        "kmedoids_pam_preflight": kmedoids_preflight,
        "input_scope": "strategy_affinity_matrix_or_strategy_supported_symbols",
        "output_scope": "strategy_similarity_crowding_uniqueness_medoid_representatives",
    }
