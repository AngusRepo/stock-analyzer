"""GraphSAGE batch-context serving for the GNN alpha family.

GNN is the only feature-family model whose production signal depends on the
other symbols in the same batch. It must therefore run through Modal's batch
runtime, build a cross-stock graph, and score all nodes in one forward pass.
"""

from __future__ import annotations

from dataclasses import dataclass
import io
import json
import logging
from typing import Any, Iterable

import numpy as np

logger = logging.getLogger(__name__)

MODEL_NAME = "GNN"
DEFAULT_CORRELATION_LOOKBACK = 60
DEFAULT_CORRELATION_THRESHOLD = 0.35
DEFAULT_TOP_K = 8

_ARTIFACT_CACHE: dict[tuple[str, str], "GraphSAGEArtifact"] = {}


@dataclass(frozen=True)
class GraphSAGEArtifact:
    model: Any
    metadata: dict
    source_path: str
    version: str


def clear_graphsage_artifact_cache() -> None:
    _ARTIFACT_CACHE.clear()


def _get_bucket():
    from .model_store import _get_bucket as _shared_get_bucket

    bucket = _shared_get_bucket()
    if bucket is None:
        raise RuntimeError("GCS bucket not available")
    return bucket


def _active_gnn_entry(pool: dict | None = None) -> dict:
    from .model_pool import gcs_path_for, load_pool

    snapshot = pool or load_pool()
    if not snapshot:
        raise RuntimeError("model_pool.json unavailable; GNN batch-context runtime fails closed")
    entry = (snapshot.get("models") or {}).get(MODEL_NAME)
    if not isinstance(entry, dict):
        raise RuntimeError("GNN missing from model_pool.models")
    status = str(entry.get("status") or "retired")
    if status not in {"active", "degraded"}:
        raise RuntimeError(f"GNN skipped by model_pool status={status}")
    version = str(entry.get("version") or "").strip()
    if not version:
        raise RuntimeError("GNN active model_pool entry is missing version")
    return {
        **entry,
        "version": version,
        "gcs_path": str(entry.get("gcs_path") or gcs_path_for(MODEL_NAME, version)),
    }


def _metadata_path_for(artifact_path: str, version: str) -> str:
    folder = artifact_path.rsplit("/", 1)[0]
    return f"{folder}/metadata_{version}.json"


def _build_graphsage_ranker(config: dict):
    import torch
    import torch.nn as nn
    from torch_geometric.nn import SAGEConv

    n_features = int(config.get("n_features") or config.get("input_dim") or 0)
    if n_features <= 0:
        raise RuntimeError("GraphSAGE artifact architecture missing n_features")
    hidden_dim = int(config.get("hidden_dim") or 64)
    dropout = float(config.get("dropout") or 0.0)

    class GraphSAGERankModel(nn.Module):
        def __init__(self):
            super().__init__()
            self.conv1 = SAGEConv(n_features, hidden_dim)
            self.conv2 = SAGEConv(hidden_dim, hidden_dim)
            self.dropout = nn.Dropout(dropout)
            self.head = nn.Linear(hidden_dim, 1)

        def forward(self, x, edge_index):
            h = self.conv1(x, edge_index).relu()
            h = self.dropout(h)
            h = self.conv2(h, edge_index).relu()
            return torch.sigmoid(self.head(h)).reshape(-1)

    return GraphSAGERankModel()


def load_graphsage_artifact(pool: dict | None = None) -> GraphSAGEArtifact:
    """Load the active GraphSAGE torch artifact from model_pool.json."""

    entry = _active_gnn_entry(pool)
    artifact_path = str(entry["gcs_path"])
    version = str(entry["version"])
    if not artifact_path.endswith((".pt", ".pth")):
        raise RuntimeError(
            "GNN production artifact must be a GraphSAGE .pt/.pth batch-context artifact; "
            f"got {artifact_path}"
        )

    cache_key = (artifact_path, version)
    if cache_key in _ARTIFACT_CACHE:
        return _ARTIFACT_CACHE[cache_key]

    bucket = _get_bucket()
    blob = bucket.blob(artifact_path)
    if not blob.exists():
        raise RuntimeError(f"GNN GraphSAGE artifact missing in GCS: {artifact_path}")

    import torch

    buf = io.BytesIO()
    blob.download_to_file(buf)
    buf.seek(0)
    payload = torch.load(buf, map_location="cpu", weights_only=False)
    if not isinstance(payload, dict):
        raise RuntimeError("GNN GraphSAGE artifact payload must be a dict")

    metadata = payload.get("metadata")
    if not isinstance(metadata, dict):
        meta_blob = bucket.blob(_metadata_path_for(artifact_path, version))
        metadata = json.loads(meta_blob.download_as_text()) if meta_blob.exists() else {}

    architecture = payload.get("architecture")
    if not isinstance(architecture, dict):
        architecture = metadata.get("architecture") if isinstance(metadata.get("architecture"), dict) else {}
    if str(architecture.get("type") or metadata.get("model_type") or "").lower() not in {
        "graphsage",
        "graphsage_ranker",
        "cross_stock_graphsage",
    }:
        raise RuntimeError("GNN artifact is not declared as GraphSAGE")

    state_dict = payload.get("state_dict")
    if not isinstance(state_dict, dict):
        raise RuntimeError("GNN GraphSAGE artifact missing state_dict")

    model = _build_graphsage_ranker(architecture)
    model.load_state_dict(state_dict)
    model.eval()
    artifact = GraphSAGEArtifact(
        model=model,
        metadata=metadata,
        source_path=artifact_path,
        version=version,
    )
    _ARTIFACT_CACHE[cache_key] = artifact
    return artifact


def _price_close(value: Any) -> float:
    if isinstance(value, dict):
        for key in ("adjusted_close", "close", "Close"):
            if key in value and value[key] is not None:
                return float(value[key])
    return float(value)


def _returns_from_prices(prices: Iterable[Any], lookback: int) -> np.ndarray:
    closes = np.asarray([_price_close(item) for item in prices], dtype=np.float32)
    closes = closes[np.isfinite(closes)]
    if closes.size < 2:
        return np.zeros(1, dtype=np.float32)
    closes = closes[-max(2, int(lookback) + 1):]
    prev = np.maximum(np.abs(closes[:-1]), 1e-9)
    return ((closes[1:] - closes[:-1]) / prev).astype(np.float32)


def _pad_returns(rows: list[np.ndarray]) -> np.ndarray:
    width = max((len(row) for row in rows), default=1)
    out = np.zeros((len(rows), width), dtype=np.float32)
    for idx, row in enumerate(rows):
        if len(row) == 0:
            continue
        out[idx, -len(row):] = row[-width:]
    return out


def build_correlation_edge_index(
    returns_matrix: np.ndarray,
    *,
    threshold: float = DEFAULT_CORRELATION_THRESHOLD,
    top_k: int = DEFAULT_TOP_K,
) -> tuple[np.ndarray, dict]:
    """Build directed correlation edges for a GraphSAGE batch."""

    n_nodes = int(returns_matrix.shape[0])
    if n_nodes <= 1:
        return np.zeros((2, 0), dtype=np.int64), {
            "n_nodes": n_nodes,
            "n_edges": 0,
            "threshold": float(threshold),
            "top_k": int(top_k),
        }

    corr = np.corrcoef(returns_matrix)
    corr = np.nan_to_num(corr, nan=0.0, posinf=0.0, neginf=0.0)
    np.fill_diagonal(corr, 0.0)

    edges: set[tuple[int, int]] = set()
    abs_corr = np.abs(corr)
    for i in range(n_nodes):
        for j in range(i + 1, n_nodes):
            if abs_corr[i, j] >= float(threshold):
                edges.add((i, j))
                edges.add((j, i))

    k = max(0, min(int(top_k), n_nodes - 1))
    if k:
        for i in range(n_nodes):
            ranked = np.argsort(abs_corr[i])[::-1][:k]
            for j in ranked:
                if i != int(j) and abs_corr[i, int(j)] > 0.0:
                    edges.add((i, int(j)))

    if not edges:
        return np.zeros((2, 0), dtype=np.int64), {
            "n_nodes": n_nodes,
            "n_edges": 0,
            "threshold": float(threshold),
            "top_k": int(top_k),
        }

    edge_index = np.asarray(sorted(edges), dtype=np.int64).T
    return edge_index, {
        "n_nodes": n_nodes,
        "n_edges": int(edge_index.shape[1]),
        "threshold": float(threshold),
        "top_k": int(top_k),
    }


def _standardize_node_features(node_features: np.ndarray, metadata: dict | None) -> np.ndarray:
    """Apply training-time robust scaling when the GraphSAGE artifact declares it."""

    meta = metadata or {}
    std = meta.get("feature_standardization") if isinstance(meta.get("feature_standardization"), dict) else {}
    medians = std.get("medians") if isinstance(std.get("medians"), list) else None
    scales = std.get("scales") if isinstance(std.get("scales"), list) else None
    if medians is None or scales is None:
        return np.asarray(node_features, dtype=np.float32)

    x = np.asarray(node_features, dtype=np.float32)
    center = np.asarray(medians, dtype=np.float32).reshape(1, -1)
    scale = np.asarray(scales, dtype=np.float32).reshape(1, -1)
    if center.shape[1] != x.shape[1] or scale.shape[1] != x.shape[1]:
        raise RuntimeError(
            "GNN GraphSAGE standardization width mismatch: "
            f"features={x.shape[1]} medians={center.shape[1]} scales={scale.shape[1]}"
        )
    scale = np.where(np.isfinite(scale) & (np.abs(scale) > 1e-9), scale, 1.0)
    out = np.nan_to_num((x - center) / scale, nan=0.0, posinf=0.0, neginf=0.0)
    clip_value = std.get("clip_value")
    if clip_value is not None:
        try:
            clip = float(clip_value)
            if clip > 0:
                out = np.clip(out, -clip, clip)
        except (TypeError, ValueError):
            pass
    return out.astype(np.float32)


def predict_graphsage_scores(
    artifact: GraphSAGEArtifact,
    *,
    node_features: np.ndarray,
    price_series: list[Iterable[Any]],
) -> tuple[np.ndarray, dict]:
    """Run GraphSAGE over a full batch and return one rank score per node."""

    metadata = artifact.metadata or {}
    graph_cfg = metadata.get("graph_context") if isinstance(metadata.get("graph_context"), dict) else {}
    lookback = int(graph_cfg.get("correlation_lookback") or DEFAULT_CORRELATION_LOOKBACK)
    threshold = float(graph_cfg.get("correlation_threshold") or DEFAULT_CORRELATION_THRESHOLD)
    top_k = int(graph_cfg.get("top_k") or DEFAULT_TOP_K)

    returns = [_returns_from_prices(series, lookback) for series in price_series]
    returns_matrix = _pad_returns(returns)
    edge_index_np, graph_report = build_correlation_edge_index(
        returns_matrix,
        threshold=threshold,
        top_k=top_k,
    )

    import torch

    standardized = _standardize_node_features(node_features, metadata)
    x = torch.tensor(standardized, dtype=torch.float32)
    edge_index = torch.tensor(edge_index_np, dtype=torch.long)
    with torch.no_grad():
        scores = artifact.model(x, edge_index).detach().cpu().numpy().reshape(-1)
    scores = np.clip(scores, 0.0, 1.0)
    return scores, {
        **graph_report,
        "artifact_path": artifact.source_path,
        "version": artifact.version,
        "runtime": "graphsage_batch_context",
    }
