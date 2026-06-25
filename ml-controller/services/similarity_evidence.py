"""Shared similarity evidence for portfolio risk and strategy crowding.

This module is evidence-only. It never selects, ranks, promotes, or emits BUY.
Production callers can use the evidence to penalize concentration, while the
existing layer owners keep the final decisions.
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np

try:  # Official graph implementation; no local algorithm fallback.
    import networkx as nx
except Exception as exc:  # pragma: no cover - exercised only in broken runtime.
    nx = None  # type: ignore[assignment]
    _NETWORKX_IMPORT_ERROR: Exception | None = exc
else:
    _NETWORKX_IMPORT_ERROR = None

try:  # Official covariance shrinkage implementation; no local fallback.
    from sklearn.covariance import LedoitWolf
except Exception as exc:  # pragma: no cover - exercised only in broken runtime.
    LedoitWolf = None  # type: ignore[assignment]
    _LEDOIT_WOLF_IMPORT_ERROR: Exception | None = exc
else:
    _LEDOIT_WOLF_IMPORT_ERROR = None


SIMILARITY_EVIDENCE_VERSION = "similarity-evidence-v1"
HDBSCAN_RESEARCH_AUDIT_VERSION = "hdbscan-research-audit-v1"


def _require_networkx() -> Any:
    if nx is None:
        raise RuntimeError(f"networkx_unavailable: {_NETWORKX_IMPORT_ERROR}")
    return nx


def _require_ledoit_wolf() -> Any:
    if LedoitWolf is None:
        raise RuntimeError(f"sklearn_ledoit_wolf_unavailable: {_LEDOIT_WOLF_IMPORT_ERROR}")
    return LedoitWolf


def _clean_symbol(value: object) -> str:
    return str(value or "").strip().upper()


def _clean_label(value: object) -> str:
    return str(value or "").strip()


def _to_float(value: object, default: float = 0.0) -> float:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return default
    return out if math.isfinite(out) else default


def _round(value: object, digits: int = 8) -> float:
    return round(_to_float(value), digits)


def _clean_history(values: list[float] | tuple[float, ...] | None) -> list[float]:
    if not values:
        return []
    out: list[float] = []
    for value in values:
        numeric = _to_float(value, default=float("nan"))
        if math.isfinite(numeric):
            out.append(numeric)
    return out


def aligned_return_matrix(
    symbols: list[str],
    return_history: dict[str, list[float]],
    *,
    min_observations: int = 3,
) -> tuple[list[str], np.ndarray]:
    """Build a trailing aligned return matrix.

    Return history currently has no date index, so alignment is by common
    trailing length. Symbols without enough observations are excluded.
    """

    clean_symbols = [_clean_symbol(symbol) for symbol in symbols if _clean_symbol(symbol)]
    histories = {
        symbol: _clean_history(return_history.get(symbol) or return_history.get(symbol.lower()))
        for symbol in clean_symbols
    }
    valid_symbols = [
        symbol for symbol in clean_symbols
        if len(histories.get(symbol, [])) >= min_observations
    ]
    common_len = min((len(histories[symbol]) for symbol in valid_symbols), default=0)
    if len(valid_symbols) < 1 or common_len < min_observations:
        return [], np.empty((0, 0), dtype=float)
    matrix = np.array(
        [
            [histories[symbol][-common_len + idx] for symbol in valid_symbols]
            for idx in range(common_len)
        ],
        dtype=float,
    )
    return valid_symbols, matrix


def diagonal_covariance_matrix(size: int, var_floor: float) -> list[list[float]]:
    if size <= 0:
        return []
    return [
        [float(var_floor) if left == right else 0.0 for right in range(size)]
        for left in range(size)
    ]


def ledoit_wolf_covariance(
    symbols: list[str],
    return_history: dict[str, list[float]],
    *,
    daily_vol_floor: float = 0.01,
    min_observations: int = 3,
) -> dict[str, Any]:
    """Estimate covariance with sklearn LedoitWolf when all symbols have data."""

    clean_symbols = [_clean_symbol(symbol) for symbol in symbols if _clean_symbol(symbol)]
    var_floor = max(1e-8, float(daily_vol_floor) * float(daily_vol_floor))
    valid_symbols, matrix = aligned_return_matrix(
        clean_symbols,
        return_history,
        min_observations=min_observations,
    )
    if not clean_symbols:
        return {
            "symbols": [],
            "covariance": [],
            "covariance_method": "empty_universe",
            "covariance_shrinkage": None,
            "observation_count": 0,
            "var_floor": var_floor,
        }
    if valid_symbols != clean_symbols or matrix.shape[0] < min_observations:
        return {
            "symbols": clean_symbols,
            "covariance": diagonal_covariance_matrix(len(clean_symbols), var_floor),
            "covariance_method": "diagonal_floor_missing_history",
            "covariance_shrinkage": None,
            "observation_count": int(matrix.shape[0]) if matrix.size else 0,
            "var_floor": var_floor,
        }

    estimator_cls = _require_ledoit_wolf()
    estimator = estimator_cls().fit(matrix)
    covariance = np.asarray(estimator.covariance_, dtype=float)
    if covariance.shape != (len(clean_symbols), len(clean_symbols)):
        return {
            "symbols": clean_symbols,
            "covariance": diagonal_covariance_matrix(len(clean_symbols), var_floor),
            "covariance_method": "diagonal_floor_invalid_ledoit_wolf_shape",
            "covariance_shrinkage": None,
            "observation_count": int(matrix.shape[0]),
            "var_floor": var_floor,
        }
    for idx in range(len(clean_symbols)):
        covariance[idx, idx] = max(float(covariance[idx, idx]), var_floor) + var_floor
    return {
        "symbols": clean_symbols,
        "covariance": covariance.tolist(),
        "covariance_method": "ledoit_wolf",
        "covariance_shrinkage": _round(getattr(estimator, "shrinkage_", 0.0), 8),
        "observation_count": int(matrix.shape[0]),
        "var_floor": var_floor,
    }


def correlation_from_covariance(covariance: list[list[float]] | np.ndarray) -> np.ndarray:
    matrix = np.asarray(covariance, dtype=float)
    if matrix.ndim != 2 or matrix.shape[0] != matrix.shape[1] or matrix.shape[0] == 0:
        return np.empty((0, 0), dtype=float)
    diag = np.sqrt(np.maximum(np.diag(matrix), 0.0))
    corr = np.zeros_like(matrix, dtype=float)
    for left in range(matrix.shape[0]):
        for right in range(matrix.shape[1]):
            denom = diag[left] * diag[right]
            corr[left, right] = 1.0 if left == right else (matrix[left, right] / denom if denom > 0 else 0.0)
    return np.clip(corr, -1.0, 1.0)


def sample_return_correlation_matrix(
    symbols: list[str],
    return_history: dict[str, list[float]],
    *,
    min_observations: int = 3,
) -> tuple[np.ndarray, str]:
    clean_symbols = [_clean_symbol(symbol) for symbol in symbols if _clean_symbol(symbol)]
    if not clean_symbols:
        return np.empty((0, 0), dtype=float), "sample_returns_empty_universe"
    correlation = np.eye(len(clean_symbols), dtype=float)
    valid_symbols, matrix = aligned_return_matrix(
        clean_symbols,
        return_history,
        min_observations=min_observations,
    )
    if len(valid_symbols) < 2 or matrix.shape[0] < min_observations:
        return correlation, "sample_returns_insufficient_history"

    sample = np.asarray(np.corrcoef(matrix, rowvar=False), dtype=float)
    if sample.ndim == 0:
        sample = np.asarray([[1.0]], dtype=float)
    sample = np.nan_to_num(sample, nan=0.0, posinf=0.0, neginf=0.0)
    sample = np.clip(sample, -1.0, 1.0)
    order = {symbol: idx for idx, symbol in enumerate(clean_symbols)}
    for left_valid, left_symbol in enumerate(valid_symbols):
        left = order.get(left_symbol)
        if left is None:
            continue
        for right_valid, right_symbol in enumerate(valid_symbols):
            right = order.get(right_symbol)
            if right is None:
                continue
            correlation[left, right] = 1.0 if left == right else float(sample[left_valid, right_valid])
    source = "sample_returns"
    if valid_symbols != clean_symbols:
        source = "sample_returns_partial_history"
    return correlation, source


def adaptive_abs_corr_threshold(
    correlation: np.ndarray,
    *,
    explicit_threshold: float | None = None,
    quantile: float = 0.9,
    min_threshold: float = 0.65,
    max_threshold: float = 0.95,
) -> tuple[float, str]:
    if explicit_threshold is not None and math.isfinite(float(explicit_threshold)):
        return round(float(max(0.0, min(1.0, explicit_threshold))), 6), "config_explicit"
    if correlation.size == 0 or correlation.shape[0] < 2:
        return 1.0, "adaptive_empty"
    values: list[float] = []
    for left in range(correlation.shape[0]):
        for right in range(left + 1, correlation.shape[1]):
            value = abs(float(correlation[left, right]))
            if math.isfinite(value):
                values.append(value)
    if not values:
        return 1.0, "adaptive_no_pairs"
    q = max(0.0, min(1.0, float(quantile)))
    threshold = float(np.quantile(np.asarray(values, dtype=float), q))
    threshold = max(float(min_threshold), min(float(max_threshold), threshold))
    return round(threshold, 6), "adaptive_quantile"


def pairwise_abs_corr_max(correlation: np.ndarray) -> float:
    if correlation.size == 0 or correlation.shape[0] < 2:
        return 0.0
    max_corr = 0.0
    for left in range(correlation.shape[0]):
        for right in range(left + 1, correlation.shape[1]):
            value = abs(float(correlation[left, right]))
            if math.isfinite(value):
                max_corr = max(max_corr, value)
    return round(max_corr, 8)


def build_similarity_graph(
    symbols: list[str],
    correlation: np.ndarray,
    *,
    edge_threshold: float,
) -> Any:
    graph_lib = _require_networkx()
    graph = graph_lib.Graph()
    clean_symbols = [_clean_symbol(symbol) for symbol in symbols if _clean_symbol(symbol)]
    graph.add_nodes_from(clean_symbols)
    if correlation.shape != (len(clean_symbols), len(clean_symbols)):
        return graph
    for left in range(len(clean_symbols)):
        for right in range(left + 1, len(clean_symbols)):
            corr = float(correlation[left, right])
            if math.isfinite(corr) and abs(corr) >= edge_threshold:
                graph.add_edge(
                    clean_symbols[left],
                    clean_symbols[right],
                    weight=round(abs(corr), 8),
                    correlation=round(corr, 8),
                )
    return graph


def _effective_independent_count(cluster_sizes: list[int]) -> float:
    total = sum(cluster_sizes)
    if total <= 0:
        return 0.0
    hhi = sum((size / total) ** 2 for size in cluster_sizes)
    return round(1.0 / max(hhi, 1e-12), 6)


def similarity_components(
    symbols: list[str],
    return_history: dict[str, list[float]],
    *,
    weights: dict[str, float] | None = None,
    edge_threshold: float | None = None,
    threshold_quantile: float = 0.9,
    daily_vol_floor: float = 0.01,
    min_observations: int = 3,
) -> dict[str, Any]:
    covariance_packet = ledoit_wolf_covariance(
        symbols,
        return_history,
        daily_vol_floor=daily_vol_floor,
        min_observations=min_observations,
    )
    clean_symbols = covariance_packet["symbols"]
    covariance = covariance_packet["covariance"]
    covariance_correlation = correlation_from_covariance(covariance)
    graph_correlation, correlation_method = sample_return_correlation_matrix(
        clean_symbols,
        return_history,
        min_observations=min_observations,
    )
    threshold, threshold_source = adaptive_abs_corr_threshold(
        graph_correlation,
        explicit_threshold=edge_threshold,
        quantile=threshold_quantile,
    )
    graph = build_similarity_graph(clean_symbols, graph_correlation, edge_threshold=threshold)
    graph_lib = _require_networkx()
    component_sets = list(graph_lib.connected_components(graph))
    order = {symbol: idx for idx, symbol in enumerate(clean_symbols)}
    component_sets.sort(key=lambda members: min(order.get(symbol, 10**9) for symbol in members))

    clean_weights = {_clean_symbol(symbol): max(0.0, _to_float(weight)) for symbol, weight in (weights or {}).items()}
    total_weight = sum(clean_weights.values())
    symbol_cluster: dict[str, str] = {}
    clusters: list[dict[str, Any]] = []
    for idx, members in enumerate(component_sets):
        ordered_symbols = sorted((_clean_symbol(symbol) for symbol in members), key=lambda symbol: order.get(symbol, 10**9))
        cluster_id = f"c{idx:03d}"
        for symbol in ordered_symbols:
            symbol_cluster[symbol] = cluster_id
        member_indices = [order[symbol] for symbol in ordered_symbols if symbol in order]
        cluster_corr_max = 0.0
        for left_pos, left in enumerate(member_indices):
            for right in member_indices[left_pos + 1:]:
                cluster_corr_max = max(cluster_corr_max, abs(float(graph_correlation[left, right])))
        exposure = sum(clean_weights.get(symbol, 0.0) for symbol in ordered_symbols)
        clusters.append({
            "cluster_id": cluster_id,
            "symbols": ordered_symbols,
            "cluster_size": len(ordered_symbols),
            "cluster_exposure": round(exposure, 8) if total_weight > 0 else 0.0,
            "pairwise_corr_max": round(cluster_corr_max, 8),
        })

    return {
        "schema_version": SIMILARITY_EVIDENCE_VERSION,
        "evidence_only": True,
        "method": "networkx_connected_components_abs_correlation",
        "node_count": len(clean_symbols),
        "edge_count": int(graph.number_of_edges()),
        "component_count": len(clusters),
        "effective_independent_count": _effective_independent_count([cluster["cluster_size"] for cluster in clusters]),
        "pairwise_corr_max": pairwise_abs_corr_max(graph_correlation),
        "correlation_method": correlation_method,
        "covariance_pairwise_corr_max": pairwise_abs_corr_max(covariance_correlation),
        "edge_threshold": threshold,
        "edge_threshold_source": threshold_source,
        "threshold_quantile": round(float(threshold_quantile), 6),
        "covariance_method": covariance_packet["covariance_method"],
        "covariance_shrinkage": covariance_packet["covariance_shrinkage"],
        "observation_count": covariance_packet["observation_count"],
        "clusters": clusters,
        "symbol_cluster": symbol_cluster,
    }


def symbol_cluster_evidence(
    symbol: str,
    similarity_evidence: dict[str, Any],
) -> dict[str, Any]:
    clean_symbol = _clean_symbol(symbol)
    cluster_id = (similarity_evidence.get("symbol_cluster") or {}).get(clean_symbol)
    clusters = similarity_evidence.get("clusters") or []
    cluster = next((item for item in clusters if item.get("cluster_id") == cluster_id), None)
    return {
        "cluster_id": cluster_id,
        "cluster_size": int((cluster or {}).get("cluster_size") or 0),
        "cluster_exposure": _round((cluster or {}).get("cluster_exposure") or 0.0, 8),
        "pairwise_corr_max": _round((cluster or {}).get("pairwise_corr_max") or 0.0, 8),
    }


def apply_cluster_exposure_cap(
    weights: dict[str, float],
    similarity_evidence: dict[str, Any],
    *,
    max_cluster_weight: float,
    preserve_total_weight: bool = False,
) -> tuple[dict[str, float], bool]:
    """Cap graph-cluster exposure without adding replacement symbols."""

    clean_weights = {
        _clean_symbol(symbol): max(0.0, _to_float(weight))
        for symbol, weight in weights.items()
        if _clean_symbol(symbol) and _to_float(weight) > 0
    }
    total = sum(clean_weights.values())
    if total <= 0:
        return {}, False
    budget = min(1.0, total) if preserve_total_weight else 1.0
    normalized = (
        dict(clean_weights)
        if preserve_total_weight
        else {symbol: weight / total for symbol, weight in clean_weights.items()}
    )
    cap = max(0.01, min(1.0, float(max_cluster_weight)))
    clusters = similarity_evidence.get("clusters") or []
    symbol_cluster = similarity_evidence.get("symbol_cluster") or {}
    cluster_members: dict[str, list[str]] = {
        str(cluster.get("cluster_id")): [_clean_symbol(symbol) for symbol in cluster.get("symbols") or []]
        for cluster in clusters
    }
    if not cluster_members:
        return normalized, False

    capped = dict(normalized)
    applied = False
    for cluster_id, members in cluster_members.items():
        exposure = sum(capped.get(symbol, 0.0) for symbol in members)
        if exposure <= cap:
            continue
        scale = cap / exposure
        for symbol in members:
            if symbol in capped:
                capped[symbol] *= scale
        applied = True

    if not applied:
        return normalized, False

    capped_total = sum(capped.values())
    if capped_total <= 0:
        return {}, True

    # Redistribute only to clusters with headroom; otherwise leave cash unallocated.
    cash = max(0.0, budget - capped_total)
    for _ in range(8):
        if cash <= 1e-12:
            break
        eligible_symbols: list[str] = []
        for symbol, weight in capped.items():
            cluster_id = str(symbol_cluster.get(symbol) or "")
            members = cluster_members.get(cluster_id) or [symbol]
            exposure = sum(capped.get(member, 0.0) for member in members)
            if exposure < cap - 1e-12 and weight > 0:
                eligible_symbols.append(symbol)
        if not eligible_symbols:
            break
        base_total = sum(capped[symbol] for symbol in eligible_symbols)
        if base_total <= 0:
            break
        added = 0.0
        for symbol in eligible_symbols:
            cluster_id = str(symbol_cluster.get(symbol) or "")
            members = cluster_members.get(cluster_id) or [symbol]
            exposure = sum(capped.get(member, 0.0) for member in members)
            headroom = max(0.0, cap - exposure)
            delta = min(cash * (capped[symbol] / base_total), headroom)
            capped[symbol] += delta
            added += delta
        if added <= 1e-12:
            break
        cash -= added

    return {
        symbol: round(weight, 10)
        for symbol, weight in capped.items()
        if weight > 1e-12
    }, True


def hdbscan_research_audit(
    feature_matrix: list[list[float]],
    labels: list[str],
    *,
    min_cluster_size: int = 5,
    min_samples: int | None = None,
) -> dict[str, Any]:
    """Research/shadow HDBSCAN audit for strategy redundancy only."""

    try:
        from sklearn.cluster import HDBSCAN
    except Exception as exc:  # pragma: no cover - broken runtime only.
        return {
            "schema_version": HDBSCAN_RESEARCH_AUDIT_VERSION,
            "status": "blocked",
            "reason": f"sklearn_hdbscan_unavailable: {exc}",
            "production_decision_path": False,
        }

    matrix = np.asarray(feature_matrix, dtype=float)
    clean_labels = [_clean_label(label) for label in labels]
    if matrix.ndim != 2 or matrix.shape[0] != len(clean_labels) or matrix.shape[0] == 0:
        return {
            "schema_version": HDBSCAN_RESEARCH_AUDIT_VERSION,
            "status": "blocked",
            "reason": "invalid_feature_matrix",
            "production_decision_path": False,
        }
    model = HDBSCAN(min_cluster_size=max(2, int(min_cluster_size)), min_samples=min_samples)
    model.fit(matrix)
    cluster_ids = np.asarray(model.labels_, dtype=int)
    probabilities = np.asarray(getattr(model, "probabilities_", np.zeros(len(clean_labels))), dtype=float)
    if probabilities.shape[0] != len(clean_labels):
        probabilities = np.zeros(len(clean_labels), dtype=float)
    outliers = [clean_labels[idx] for idx, cluster_id in enumerate(cluster_ids) if int(cluster_id) < 0]
    cluster_counts: dict[str, int] = {}
    for cluster_id in cluster_ids:
        key = str(int(cluster_id))
        cluster_counts[key] = cluster_counts.get(key, 0) + 1
    cluster_stability: dict[str, float] = {}
    for cluster_id in sorted({int(value) for value in cluster_ids if int(value) >= 0}):
        member_idx = [idx for idx, value in enumerate(cluster_ids) if int(value) == cluster_id]
        if member_idx:
            cluster_stability[str(cluster_id)] = _round(float(np.mean(probabilities[member_idx])), 8)
    outlier_score = {
        clean_labels[idx]: _round(1.0 - max(0.0, min(1.0, float(probabilities[idx]))), 8)
        for idx in range(len(clean_labels))
    }
    return {
        "schema_version": HDBSCAN_RESEARCH_AUDIT_VERSION,
        "status": "computed",
        "production_decision_path": False,
        "production_selector": False,
        "promotion_ready": False,
        "allowed_use": "research_shadow_only",
        "algorithm": "sklearn.cluster.HDBSCAN",
        "cluster_stability_source": "sklearn.cluster.HDBSCAN.probabilities_",
        "strategy_count": len(clean_labels),
        "cluster_count": len([key for key in cluster_counts if key != "-1"]),
        "outlier_count": len(outliers),
        "hdbscan_cluster_id": {
            clean_labels[idx]: int(cluster_id)
            for idx, cluster_id in enumerate(cluster_ids)
        },
        "outlier_score": outlier_score,
        "cluster_stability": cluster_stability,
        "outlier_strategies": outliers,
        "research_strategy_redundancy": cluster_counts,
        "candidate_new_style": outliers,
    }
