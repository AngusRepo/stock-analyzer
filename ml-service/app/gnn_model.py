"""
gnn_model.py — P3#28 GNN Cross-Stock Relations (Shadow Mode)

Uses 60-day return correlation to build stock graph.
GraphSAGE learns cross-stock patterns.
Shadow mode: predictions recorded but never affect ensemble.
"""
import logging
import numpy as np
from typing import Optional

logger = logging.getLogger("gnn")


def build_correlation_graph(returns_matrix: np.ndarray, threshold: float = 0.5) -> tuple:
    """
    Build adjacency from correlation matrix.

    Args:
        returns_matrix: (n_stocks, n_days) daily returns
        threshold: minimum |correlation| to create edge

    Returns:
        edge_index: (2, n_edges) source-target pairs
        edge_weight: (n_edges,) correlation values
    """
    n_stocks = returns_matrix.shape[0]
    corr = np.corrcoef(returns_matrix)
    corr = np.nan_to_num(corr, nan=0.0)

    # Build edges where |corr| > threshold (exclude self-loops)
    sources, targets, weights = [], [], []
    for i in range(n_stocks):
        for j in range(i + 1, n_stocks):
            if abs(corr[i, j]) > threshold:
                sources.extend([i, j])
                targets.extend([j, i])
                weights.extend([corr[i, j], corr[i, j]])

    edge_index = np.array([sources, targets], dtype=np.int64)
    edge_weight = np.array(weights, dtype=np.float32)

    logger.info(f"[GNN] Built graph: {n_stocks} nodes, {len(weights)//2} edges (threshold={threshold})")
    return edge_index, edge_weight


class SimpleGraphSAGE:
    """
    Numpy-only GraphSAGE implementation (no PyTorch Geometric dependency).
    2-layer neighborhood aggregation for stock direction prediction.

    Why numpy-only: torch-geometric install on Modal is heavy and fragile.
    This lightweight version captures the core GNN idea:
    "aggregate neighbor features to predict node direction"
    """

    def __init__(self, n_features: int, hidden_dim: int = 32, n_classes: int = 2):
        self.n_features = n_features
        self.hidden_dim = hidden_dim
        self.n_classes = n_classes

        # Layer 1: project own + neighbor mean
        self.W1_self = np.random.randn(n_features, hidden_dim).astype(np.float32) * 0.1
        self.W1_neigh = np.random.randn(n_features, hidden_dim).astype(np.float32) * 0.1
        self.b1 = np.zeros(hidden_dim, dtype=np.float32)

        # Layer 2: project own + neighbor mean
        self.W2_self = np.random.randn(hidden_dim, hidden_dim).astype(np.float32) * 0.1
        self.W2_neigh = np.random.randn(hidden_dim, hidden_dim).astype(np.float32) * 0.1
        self.b2 = np.zeros(hidden_dim, dtype=np.float32)

        # Classifier
        self.W_out = np.random.randn(hidden_dim, n_classes).astype(np.float32) * 0.1
        self.b_out = np.zeros(n_classes, dtype=np.float32)

    def _aggregate_neighbors(self, node_features, edge_index, n_nodes):
        """Mean aggregation of neighbor features."""
        agg = np.zeros((n_nodes, node_features.shape[1]), dtype=np.float32)
        counts = np.zeros(n_nodes, dtype=np.float32) + 1e-8

        if edge_index.shape[1] > 0:
            for idx in range(edge_index.shape[1]):
                src, tgt = edge_index[0, idx], edge_index[1, idx]
                if src < n_nodes and tgt < n_nodes:
                    agg[tgt] += node_features[src]
                    counts[tgt] += 1

        return agg / counts[:, None]

    def _relu(self, x):
        return np.maximum(0, x)

    def _softmax(self, x):
        e = np.exp(x - x.max(axis=-1, keepdims=True))
        return e / e.sum(axis=-1, keepdims=True)

    def forward(self, node_features, edge_index):
        """Forward pass through 2 GraphSAGE layers + classifier."""
        n_nodes = node_features.shape[0]

        # Pad features if needed
        if node_features.shape[1] < self.n_features:
            node_features = np.pad(node_features, ((0, 0), (0, self.n_features - node_features.shape[1])))
        elif node_features.shape[1] > self.n_features:
            node_features = node_features[:, :self.n_features]

        # Layer 1
        neigh1 = self._aggregate_neighbors(node_features, edge_index, n_nodes)
        h1 = self._relu(
            node_features @ self.W1_self + neigh1 @ self.W1_neigh + self.b1
        )

        # Layer 2
        neigh2 = self._aggregate_neighbors(h1, edge_index, n_nodes)
        h2 = self._relu(
            h1 @ self.W2_self + neigh2 @ self.W2_neigh + self.b2
        )

        # Classifier
        logits = h2 @ self.W_out + self.b_out
        probs = self._softmax(logits)

        return probs  # (n_nodes, 2) — [down_prob, up_prob]

    def fit(self, node_features, edge_index, labels, epochs=50, lr=0.01):
        """Simple gradient descent training."""
        n_nodes = len(labels)

        for epoch in range(epochs):
            # Forward
            probs = self.forward(node_features, edge_index)

            # Cross-entropy loss
            probs_clipped = np.clip(probs, 1e-7, 1 - 1e-7)
            loss = -np.mean(np.log(probs_clipped[np.arange(n_nodes), labels.astype(int)]))

            # Accuracy
            preds = np.argmax(probs, axis=1)
            acc = np.mean(preds == labels.astype(int))

            if epoch % 10 == 0:
                logger.info(f"[GNN] Epoch {epoch}: loss={loss:.4f} acc={acc:.3f}")

            # Simple numerical gradient update (not efficient but works for small graphs)
            for param_name in ['W1_self', 'W1_neigh', 'W2_self', 'W2_neigh', 'W_out']:
                param = getattr(self, param_name)
                grad = np.zeros_like(param)
                eps = 1e-4
                # Sample gradient (only update subset for speed)
                n_sample = min(10, param.shape[0])
                for i in np.random.choice(param.shape[0], n_sample, replace=False):
                    for j in range(min(5, param.shape[1])):
                        param[i, j] += eps
                        loss_plus = -np.mean(np.log(np.clip(
                            self.forward(node_features, edge_index), 1e-7, 1-1e-7
                        )[np.arange(n_nodes), labels.astype(int)]))
                        param[i, j] -= 2 * eps
                        loss_minus = -np.mean(np.log(np.clip(
                            self.forward(node_features, edge_index), 1e-7, 1-1e-7
                        )[np.arange(n_nodes), labels.astype(int)]))
                        param[i, j] += eps
                        grad[i, j] = (loss_plus - loss_minus) / (2 * eps)

                setattr(self, param_name, param - lr * grad)

        return {"final_loss": float(loss), "final_accuracy": float(acc), "epochs": epochs}

    def predict(self, node_features, edge_index, node_idx: int) -> dict:
        """Predict direction for a specific node."""
        probs = self.forward(node_features, edge_index)
        if node_idx >= len(probs):
            return {"direction": "up", "confidence": 0.5}

        up_prob = float(probs[node_idx, 1])
        return {
            "direction": "up" if up_prob > 0.5 else "down",
            "confidence": round(max(up_prob, 1 - up_prob), 3),
            "up_prob": round(up_prob, 3),
            "n_neighbors": int(np.sum(edge_index[1] == node_idx)) if edge_index.shape[1] > 0 else 0,
        }
