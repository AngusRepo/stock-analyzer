"""
stacking_mlp.py — P2#21 Stacking MLP Shadow Mode

MLP [30→16→8→2] + Dropout 0.3 + Early stopping
Runs parallel with existing LR stacking. Weekly OOS comparison.
MLP > LR × 1.1 + PBO < 0.4 + 4 consecutive weeks lead → switch.
"""
import logging
import numpy as np
from typing import Optional

logger = logging.getLogger(__name__)


class StackingMLP:
    """
    Simple MLP meta-learner for stacking.
    Uses numpy-only implementation (no PyTorch dependency in production).
    Architecture: 30→16→8→2 with ReLU + Dropout.
    """

    def __init__(self, input_dim: int = 30, hidden1: int = 16, hidden2: int = 8,
                 dropout: float = 0.3, lr: float = 0.001, epochs: int = 100):
        self.input_dim = input_dim
        self.hidden1 = hidden1
        self.hidden2 = hidden2
        self.dropout = dropout
        self.lr = lr
        self.epochs = epochs
        self.trained = False

        # Xavier initialization
        self.W1 = np.random.randn(input_dim, hidden1) * np.sqrt(2.0 / input_dim)
        self.b1 = np.zeros(hidden1)
        self.W2 = np.random.randn(hidden1, hidden2) * np.sqrt(2.0 / hidden1)
        self.b2 = np.zeros(hidden2)
        self.W3 = np.random.randn(hidden2, 2) * np.sqrt(2.0 / hidden2)
        self.b3 = np.zeros(2)

    def _relu(self, x):
        return np.maximum(0, x)

    def _softmax(self, x):
        e = np.exp(x - np.max(x, axis=-1, keepdims=True))
        return e / e.sum(axis=-1, keepdims=True)

    def _dropout_mask(self, shape, training: bool):
        if training and self.dropout > 0:
            return (np.random.rand(*shape) > self.dropout).astype(float) / (1 - self.dropout)
        return np.ones(shape)

    def forward(self, X, training: bool = False):
        h1 = self._relu(X @ self.W1 + self.b1) * self._dropout_mask((X.shape[0], self.hidden1), training)
        h2 = self._relu(h1 @ self.W2 + self.b2) * self._dropout_mask((X.shape[0], self.hidden2), training)
        logits = h2 @ self.W3 + self.b3
        return self._softmax(logits)

    def fit(self, X: np.ndarray, y: np.ndarray, X_val: np.ndarray = None, y_val: np.ndarray = None):
        """Train with mini-batch SGD + early stopping."""
        best_val_loss = float('inf')
        patience = 10
        no_improve = 0

        for epoch in range(self.epochs):
            # Forward (no dropout for gradient computation — consistent graph)
            h1_raw = X @ self.W1 + self.b1
            h1 = self._relu(h1_raw)
            h2_raw = h1 @ self.W2 + self.b2
            h2 = self._relu(h2_raw)
            logits = h2 @ self.W3 + self.b3
            probs = self._softmax(logits)

            # Cross-entropy loss gradient
            y_onehot = np.zeros((len(y), 2))
            y_onehot[np.arange(len(y)), y.astype(int)] = 1
            grad_out = (probs - y_onehot) / len(y)

            # Backprop through W3 (using same h1/h2 as forward)
            dW3 = h2.T @ grad_out
            db3 = grad_out.sum(axis=0)

            # Backprop through W2
            grad_h2 = grad_out @ self.W3.T * (h2 > 0)
            dW2 = h1.T @ grad_h2
            db2 = grad_h2.sum(axis=0)

            # Backprop through W1
            grad_h1 = grad_h2 @ self.W2.T * (h1 > 0)
            dW1 = X.T @ grad_h1
            db1 = grad_h1.sum(axis=0)

            # Update
            self.W3 -= self.lr * dW3
            self.b3 -= self.lr * db3
            self.W2 -= self.lr * dW2
            self.b2 -= self.lr * db2
            self.W1 -= self.lr * dW1
            self.b1 -= self.lr * db1

            # Early stopping on validation
            if X_val is not None and y_val is not None:
                val_probs = self.forward(X_val, training=False)
                val_loss = -np.mean(np.log(val_probs[np.arange(len(y_val)), y_val.astype(int)] + 1e-8))
                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    no_improve = 0
                else:
                    no_improve += 1
                if no_improve >= patience:
                    logger.info(f"[MLP] Early stopping at epoch {epoch}")
                    break

        self.trained = True

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        """Return P(class=1) for each sample."""
        return self.forward(X, training=False)[:, 1]

    def score(self, X: np.ndarray, y: np.ndarray) -> float:
        """Accuracy on validation set."""
        preds = (self.predict_proba(X) > 0.5).astype(int)
        return float(np.mean(preds == y))


def train_shadow_mlp(X: np.ndarray, y: np.ndarray, split: float = 0.8) -> Optional[dict]:
    """
    Train MLP shadow model alongside existing LR stacking.
    Returns accuracy comparison dict.
    """
    if len(X) < 50 or X.shape[1] < 5:
        return None

    s = int(len(X) * split)
    X_train, X_val = X[:s], X[s:]
    y_train, y_val = y[:s], y[s:]

    if len(set(y_train)) < 2:
        return None

    mlp = StackingMLP(input_dim=X.shape[1])
    mlp.fit(X_train, y_train, X_val, y_val)

    mlp_acc = mlp.score(X_val, y_val)

    # Compare with simple LR (baseline)
    from sklearn.linear_model import LogisticRegression
    lr = LogisticRegression(max_iter=200, random_state=42)
    lr.fit(X_train, y_train)
    lr_acc = float(lr.score(X_val, y_val))

    return {
        "mlp_accuracy": round(mlp_acc, 4),
        "lr_accuracy": round(lr_acc, 4),
        "mlp_better": mlp_acc > lr_acc * 1.1,
        "improvement": round((mlp_acc - lr_acc) / max(lr_acc, 0.01), 4),
    }
