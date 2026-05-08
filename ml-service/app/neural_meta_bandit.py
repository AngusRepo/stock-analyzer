"""Neural meta-bandit shadow challengers for LinUCB.

These policies are not alpha models and must not vote in production. They train
on expanded meta context + arm reward evidence and emit shadow decisions for
Strategy Lab / OBS review.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Sequence

import numpy as np

PolicyId = Literal["NeuralUCB", "NeuralTS"]


@dataclass(frozen=True)
class NeuralMetaBanditConfig:
    policy_id: PolicyId
    hidden_dim: int = 32
    epochs: int = 120
    learning_rate: float = 0.01
    ucb_alpha: float = 0.15
    ts_noise: float = 0.03
    seed: int = 42


@dataclass(frozen=True)
class NeuralMetaBanditTrainingReport:
    policy_id: PolicyId
    samples: int
    context_dim: int
    arm_count: int
    loss_initial: float
    loss_final: float
    epochs: int


class _RewardNet:
    def __init__(self, input_dim: int, hidden_dim: int) -> None:
        scale1 = np.sqrt(2.0 / max(input_dim, 1))
        scale2 = np.sqrt(2.0 / max(hidden_dim, 1))
        self.w1 = np.random.normal(0.0, scale1, size=(input_dim, hidden_dim)).astype("float32")
        self.b1 = np.zeros(hidden_dim, dtype="float32")
        self.w2 = np.random.normal(0.0, scale2, size=(hidden_dim, 1)).astype("float32")
        self.b2 = np.zeros(1, dtype="float32")

    def predict(self, x: np.ndarray) -> np.ndarray:
        h = np.maximum(0.0, x @ self.w1 + self.b1)
        return (h @ self.w2 + self.b2).reshape(-1)

    def train_step(self, x: np.ndarray, y: np.ndarray, learning_rate: float) -> float:
        h_pre = x @ self.w1 + self.b1
        h = np.maximum(0.0, h_pre)
        pred = (h @ self.w2 + self.b2).reshape(-1)
        err = pred - y
        loss = float(np.mean(err ** 2))
        grad_pred = (2.0 / max(len(x), 1)) * err.reshape(-1, 1)
        grad_w2 = h.T @ grad_pred
        grad_b2 = grad_pred.sum(axis=0)
        grad_h = grad_pred @ self.w2.T
        grad_h[h_pre <= 0] = 0
        grad_w1 = x.T @ grad_h
        grad_b1 = grad_h.sum(axis=0)
        self.w2 -= learning_rate * grad_w2.astype("float32")
        self.b2 -= learning_rate * grad_b2.astype("float32")
        self.w1 -= learning_rate * grad_w1.astype("float32")
        self.b1 -= learning_rate * grad_b1.astype("float32")
        return loss


class TrainedNeuralMetaBandit:
    def __init__(
        self,
        *,
        config: NeuralMetaBanditConfig,
        arm_names: Sequence[str],
        context_dim: int,
        model: _RewardNet,
        arm_counts: np.ndarray,
        training_report: NeuralMetaBanditTrainingReport,
    ) -> None:
        self.config = config
        self.arm_names = list(arm_names)
        self.context_dim = context_dim
        self.model = model
        self.arm_counts = arm_counts.astype("float32")
        self.training_report = training_report

    @property
    def arm_count(self) -> int:
        return len(self.arm_names)

    def _design_matrix(self, contexts: np.ndarray, arm_idx: int) -> np.ndarray:
        contexts = _validate_contexts(contexts, expected_dim=self.context_dim)
        one_hot = np.zeros((len(contexts), self.arm_count), dtype="float32")
        one_hot[:, arm_idx] = 1.0
        return np.concatenate([contexts, one_hot], axis=1).astype("float32")

    def score_actions(self, contexts: np.ndarray, mode: Literal["ucb", "ts"] = "ucb") -> np.ndarray:
        contexts = _validate_contexts(contexts, expected_dim=self.context_dim)
        scores: list[np.ndarray] = []
        for arm_idx in range(self.arm_count):
            pred = self.model.predict(self._design_matrix(contexts, arm_idx))
            if mode == "ucb":
                bonus = self.config.ucb_alpha / np.sqrt(max(float(self.arm_counts[arm_idx]), 1.0))
                pred = pred + bonus
            elif mode == "ts":
                rng = np.random.default_rng(self.config.seed + arm_idx)
                pred = pred + rng.normal(0.0, self.config.ts_noise, size=pred.shape)
            scores.append(pred)
        return np.stack(scores, axis=1)

    def choose_actions(self, contexts: np.ndarray, mode: Literal["ucb", "ts"] = "ucb") -> list[str]:
        scores = self.score_actions(contexts, mode=mode)
        return [self.arm_names[int(i)] for i in np.argmax(scores, axis=1)]


def _validate_contexts(contexts: np.ndarray, expected_dim: int | None = None) -> np.ndarray:
    arr = np.asarray(contexts, dtype="float32")
    if arr.ndim != 2:
        raise ValueError(f"contexts must be 2D, got shape={arr.shape}")
    if expected_dim is not None and arr.shape[1] != expected_dim:
        raise ValueError(f"context_dim mismatch: {arr.shape[1]} != {expected_dim}")
    if not np.isfinite(arr).all():
        raise ValueError("contexts contain non-finite values")
    return arr


def _validate_training_arrays(
    contexts: np.ndarray,
    arms: np.ndarray,
    rewards: np.ndarray,
    arm_names: Sequence[str],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = _validate_contexts(contexts)
    a = np.asarray(arms, dtype=np.int64)
    y = np.asarray(rewards, dtype="float32")
    if len(x) != len(a) or len(x) != len(y):
        raise ValueError("contexts, arms and rewards must have the same length")
    if len(arm_names) < 2:
        raise ValueError("at least two arms are required")
    if len(x) < len(arm_names) * 2:
        raise ValueError("not enough samples to train neural meta-bandit")
    if a.min(initial=0) < 0 or a.max(initial=0) >= len(arm_names):
        raise ValueError("arm index out of range")
    if not np.isfinite(y).all():
        raise ValueError("rewards contain non-finite values")
    return x, a, y


def train_neural_meta_bandit(
    contexts: np.ndarray,
    arms: np.ndarray,
    rewards: np.ndarray,
    *,
    arm_names: Sequence[str],
    config: NeuralMetaBanditConfig,
) -> TrainedNeuralMetaBandit:
    """Train a neural reward model on context + chosen arm evidence."""

    x, a, y = _validate_training_arrays(contexts, arms, rewards, arm_names)
    np.random.seed(config.seed)
    arm_count = len(arm_names)
    one_hot = np.zeros((len(x), arm_count), dtype="float32")
    one_hot[np.arange(len(x)), a] = 1.0
    train_x = np.concatenate([x, one_hot], axis=1).astype("float32")
    train_y = y.astype("float32")
    model = _RewardNet(train_x.shape[1], config.hidden_dim)
    losses: list[float] = []
    for _ in range(max(1, int(config.epochs))):
        losses.append(model.train_step(train_x, train_y, config.learning_rate))

    arm_counts = np.bincount(a, minlength=arm_count).astype("float32")
    report = NeuralMetaBanditTrainingReport(
        policy_id=config.policy_id,
        samples=len(x),
        context_dim=x.shape[1],
        arm_count=arm_count,
        loss_initial=round(losses[0], 8),
        loss_final=round(losses[-1], 8),
        epochs=max(1, int(config.epochs)),
    )
    return TrainedNeuralMetaBandit(
        config=config,
        arm_names=arm_names,
        context_dim=x.shape[1],
        model=model,
        arm_counts=arm_counts,
        training_report=report,
    )


def build_shadow_decisions(
    policy: TrainedNeuralMetaBandit,
    *,
    business_date: str,
    symbols: Sequence[str],
    contexts: np.ndarray,
    baseline_actions: Sequence[str],
    mode: Literal["ucb", "ts"] = "ucb",
) -> list[dict]:
    contexts = _validate_contexts(contexts, expected_dim=policy.context_dim)
    if len(symbols) != len(contexts) or len(baseline_actions) != len(contexts):
        raise ValueError("symbols, contexts and baseline_actions must have the same length")
    scores = policy.score_actions(contexts, mode=mode)
    chosen_idx = np.argmax(scores, axis=1)
    decisions: list[dict] = []
    for idx, arm_idx in enumerate(chosen_idx):
        shadow_action = policy.arm_names[int(arm_idx)]
        baseline_action = str(baseline_actions[idx])
        decisions.append({
            "policy_id": policy.config.policy_id,
            "business_date": business_date,
            "symbol": str(symbols[idx]),
            "arm_id": shadow_action,
            "baseline_action": baseline_action,
            "shadow_action": shadow_action,
            "counterfactual_reward": None,
            "context": {
                "version": "meta-context-v2",
                "vector": [round(float(v), 6) for v in contexts[idx].tolist()],
            },
            "evidence": {
                "mode": mode,
                "score": round(float(scores[idx, arm_idx]), 8),
                "baseline_equals_shadow": baseline_action == shadow_action,
                "training_report": policy.training_report.__dict__,
            },
        })
    return decisions
