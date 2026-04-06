"""
gnn_shadow.py — P3#28 GNN Shadow Mode Wrapper

Trains GNN on correlation graph, records shadow predictions.
Shadow only — predictions NEVER affect ensemble voting.
"""
import logging
import numpy as np
from typing import Optional

logger = logging.getLogger("gnn_shadow")


def train_gnn_shadow(
    all_returns: dict,  # {symbol: np.array of daily returns}
    all_features: dict,  # {symbol: np.array of (n_days, 32) features}
    all_labels: dict,  # {symbol: np.array of direction labels (0/1)}
    correlation_threshold: float = 0.5,
) -> Optional[dict]:
    """
    Train GNN on cross-stock correlation graph.
    Called during weekly retrain cycle.

    Returns training metrics dict.
    """
    from .gnn_model import build_correlation_graph, SimpleGraphSAGE

    symbols = sorted(all_returns.keys())
    if len(symbols) < 10:
        logger.warning(f"[GNN Shadow] Only {len(symbols)} stocks, need >= 10")
        return None

    # Build returns matrix for correlation
    min_days = min(len(r) for r in all_returns.values())
    if min_days < 30:
        return None

    returns_matrix = np.array([all_returns[s][-min_days:] for s in symbols])

    # Build graph
    edge_index, edge_weight = build_correlation_graph(returns_matrix, correlation_threshold)

    # Build node features (latest day)
    node_features = []
    labels = []
    for s in symbols:
        feat = all_features.get(s)
        label = all_labels.get(s)
        if feat is not None and len(feat) > 0:
            node_features.append(feat[-1][:32] if len(feat[-1]) >= 32 else np.pad(feat[-1], (0, 32 - len(feat[-1]))))
            labels.append(int(label[-1]) if label is not None and len(label) > 0 else 0)
        else:
            node_features.append(np.zeros(32))
            labels.append(0)

    node_features = np.array(node_features, dtype=np.float32)
    labels = np.array(labels, dtype=np.int32)

    # Train
    gnn = SimpleGraphSAGE(n_features=32, hidden_dim=32)
    metrics = gnn.fit(node_features, edge_index, labels, epochs=30, lr=0.01)

    # Evaluate
    probs = gnn.forward(node_features, edge_index)
    preds = np.argmax(probs, axis=1)
    accuracy = np.mean(preds == labels)

    result = {
        "trained": True,
        "n_stocks": len(symbols),
        "n_edges": edge_index.shape[1] // 2 if edge_index.shape[1] > 0 else 0,
        "accuracy": round(float(accuracy), 3),
        "correlation_threshold": correlation_threshold,
        **metrics,
    }

    logger.info(f"[GNN Shadow] {len(symbols)} stocks, {result['n_edges']} edges, acc={accuracy:.3f}")
    return result
