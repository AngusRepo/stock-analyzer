from __future__ import annotations

from typing import Any

import numpy as np

GNN_GRAPH_SEMANTIC_VERSION = "gnn-same-date-feature-cosine-sector-v2"


def _normalized_sector_labels(sectors: np.ndarray) -> np.ndarray:
    missing = {"", "0", "0.0", "nan", "none", "null", "unknown", "n/a"}
    return np.asarray([
        "" if str(value).strip().lower() in missing else str(value).strip()
        for value in np.asarray(sectors).reshape(-1)
    ])


def build_feature_sector_edge_index(
    node_features: np.ndarray,
    sectors: np.ndarray,
    *,
    top_k: int,
    threshold: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Canonical train/serve graph; same inputs must produce identical edges."""

    x = np.asarray(node_features, dtype=np.float32)
    labels = _normalized_sector_labels(sectors)
    n_nodes = int(x.shape[0])
    if labels.shape[0] != n_nodes:
        raise ValueError("gnn_graph_sector_length_mismatch")
    if n_nodes <= 1:
        return np.zeros((2, 0), dtype=np.int64), {
            "semantic_version": GNN_GRAPH_SEMANTIC_VERSION,
            "edge_source": "same_date_feature_cosine_plus_sector",
            "n_nodes": n_nodes,
            "edge_count": 0,
            "top_k": 0,
            "threshold": float(threshold),
        }

    norms = np.linalg.norm(x, axis=1, keepdims=True)
    normalized = x / np.where(norms > 1e-9, norms, 1.0)
    similarity = np.nan_to_num(
        normalized @ normalized.T,
        nan=0.0,
        posinf=0.0,
        neginf=0.0,
    )
    np.fill_diagonal(similarity, 0.0)
    absolute = np.abs(similarity)
    k = max(1, min(int(top_k), n_nodes - 1))
    edges: set[tuple[int, int]] = set()
    node_ids = np.arange(n_nodes)
    for left in range(n_nodes):
        ranked = np.lexsort((node_ids, -absolute[left]))[:k]
        for right_raw in ranked:
            right = int(right_raw)
            if left == right:
                continue
            same_sector = bool(labels[left]) and labels[left] == labels[right]
            if absolute[left, right] >= float(threshold) or same_sector:
                edges.add((left, right))
                edges.add((right, left))
    if not edges:
        for left in range(n_nodes - 1):
            edges.add((left, left + 1))
            edges.add((left + 1, left))
    edge_index = np.asarray(sorted(edges), dtype=np.int64).T
    return edge_index, {
        "semantic_version": GNN_GRAPH_SEMANTIC_VERSION,
        "edge_source": "same_date_feature_cosine_plus_sector",
        "n_nodes": n_nodes,
        "edge_count": int(edge_index.shape[1]),
        "top_k": k,
        "threshold": float(threshold),
    }


# §7 challenger graphs. The incumbent GNN keeps GNN_GRAPH_SEMANTIC_VERSION above.
GNN_GRAPH_VARIANTS: dict[str, dict[str, str]] = {
    "industry": {
        "model_name": "GNNIndustry",
        "semantic_version": "gnn-same-date-pit-industry-clique-v1",
        "edge_source": "same_date_pit_industry_clique",
    },
    "industry_plus_cosine": {
        "model_name": "GNNIndustryCosine",
        "semantic_version": "gnn-same-date-pit-industry-clique-plus-feature-cosine-v1",
        "edge_source": "same_date_pit_industry_clique_union_feature_cosine",
    },
}


def build_industry_edge_index(
    node_features: np.ndarray,
    industries: np.ndarray,
    *,
    variant: str,
    top_k: int,
    threshold: float,
) -> tuple[np.ndarray, dict[str, Any]]:
    """Directed edges between every pair of same-date nodes in one PIT industry.

    ``industry_plus_cosine`` unions the clique with the incumbent cosine edges
    (computed without sector labels, as the incumbent sees them in training).
    """

    if variant not in GNN_GRAPH_VARIANTS:
        raise ValueError(f"gnn_graph_variant_invalid:{variant}")
    labels = _normalized_sector_labels(industries)
    n_nodes = int(np.asarray(node_features).shape[0])
    if labels.shape[0] != n_nodes:
        raise ValueError("gnn_graph_sector_length_mismatch")
    if np.any(labels == ""):
        raise ValueError("gnn_industry_graph_requires_pit_industry_for_every_node")
    blocks = []
    for label in np.unique(labels):
        members = np.flatnonzero(labels == label)
        if len(members) < 2:
            continue
        left, right = np.meshgrid(members, members, indexing="ij")
        keep = left != right
        blocks.append(np.stack([left[keep], right[keep]]))
    clique = np.concatenate(blocks, axis=1) if blocks else np.zeros((2, 0), dtype=np.int64)
    cosine_edges = 0
    if variant == "industry_plus_cosine":
        cosine, cosine_report = build_feature_sector_edge_index(
            node_features, np.asarray([""] * n_nodes), top_k=top_k, threshold=threshold)
        cosine_edges = int(cosine_report["edge_count"])
        clique = np.concatenate([clique, cosine], axis=1)
    edge_index = np.unique(clique.astype(np.int64), axis=1) if clique.shape[1] else clique.astype(np.int64)
    spec = GNN_GRAPH_VARIANTS[variant]
    return edge_index.astype(np.int32), {
        "semantic_version": spec["semantic_version"],
        "edge_source": spec["edge_source"],
        "n_nodes": n_nodes,
        "industries": int(len(np.unique(labels))),
        "isolated_nodes": int(n_nodes - len(np.unique(edge_index[0]))) if edge_index.shape[1] else n_nodes,
        "edge_count": int(edge_index.shape[1]),
        "cosine_edge_count": cosine_edges,
        "top_k": int(top_k) if variant == "industry_plus_cosine" else 0,
        "threshold": float(threshold) if variant == "industry_plus_cosine" else None,
    }
