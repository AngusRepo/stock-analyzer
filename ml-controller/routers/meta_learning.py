from __future__ import annotations

import hashlib
from typing import Any, Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/meta-learning", tags=["meta-learning"])


class NeuralShadowTrainRequest(BaseModel):
    policy_id: Literal["NeuralUCB", "NeuralTS"]
    contexts: list[list[float]] = Field(default_factory=list, max_items=20000)
    arms: list[int] = Field(default_factory=list, max_items=20000)
    rewards: list[float] = Field(default_factory=list, max_items=20000)
    arm_names: list[str] = Field(default_factory=list, max_items=20)
    business_date: str
    symbols: list[str] = Field(default_factory=list, max_items=20000)
    baseline_actions: list[str] = Field(default_factory=list, max_items=20000)


def _seed(policy_id: str, arm_names: list[str], width: int) -> int:
    material = f"{policy_id}:{','.join(arm_names)}:{width}".encode("utf-8")
    return int.from_bytes(hashlib.sha256(material).digest()[:4], "big")


def _standardize(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = np.nanmean(x, axis=0)
    std = np.nanstd(x, axis=0)
    std = np.where(std < 1e-6, 1.0, std)
    z = np.nan_to_num((x - mean) / std, nan=0.0, posinf=0.0, neginf=0.0)
    return z, mean, std


def _neural_features(x: np.ndarray, policy_id: str, arm_names: list[str]) -> np.ndarray:
    width = min(32, max(8, x.shape[1] * 2))
    rng = np.random.default_rng(_seed(policy_id, arm_names, width))
    projection = rng.normal(0.0, 1.0 / max(1, x.shape[1]) ** 0.5, size=(x.shape[1], width))
    hidden = np.tanh(x @ projection)
    return np.concatenate([np.ones((x.shape[0], 1)), x, hidden], axis=1)


def _fit_arm_models(phi: np.ndarray, arms: np.ndarray, rewards: np.ndarray, arm_count: int) -> list[dict[str, Any]]:
    ridge = 1.0
    models: list[dict[str, Any]] = []
    global_mean = float(np.mean(rewards)) if rewards.size else 0.0
    dim = phi.shape[1]
    identity = np.eye(dim)

    for arm in range(arm_count):
        idx = np.where(arms == arm)[0]
        if idx.size < 2:
            models.append({
                "samples": int(idx.size),
                "beta": np.zeros(dim),
                "a_inv": identity,
                "fallback_mean": global_mean,
            })
            continue
        x_arm = phi[idx]
        y_arm = rewards[idx]
        a = x_arm.T @ x_arm + ridge * identity
        a_inv = np.linalg.pinv(a)
        beta = a_inv @ x_arm.T @ y_arm
        models.append({
            "samples": int(idx.size),
            "beta": beta,
            "a_inv": a_inv,
            "fallback_mean": None,
        })
    return models


def _score_actions(policy_id: str, phi: np.ndarray, models: list[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray]:
    alpha = 0.6
    scores = np.zeros((phi.shape[0], len(models)))
    means = np.zeros_like(scores)
    rng = np.random.default_rng(_seed(policy_id, [str(i) for i in range(len(models))], phi.shape[1]))

    for arm_idx, model in enumerate(models):
        if model["fallback_mean"] is not None:
            means[:, arm_idx] = float(model["fallback_mean"])
            scores[:, arm_idx] = means[:, arm_idx]
            continue
        beta = model["beta"]
        a_inv = model["a_inv"]
        mean = phi @ beta
        means[:, arm_idx] = mean
        uncertainty = np.sqrt(np.maximum(np.sum((phi @ a_inv) * phi, axis=1), 0.0))
        if policy_id == "NeuralTS":
            sampled_beta = rng.multivariate_normal(beta, 0.05 * a_inv)
            scores[:, arm_idx] = phi @ sampled_beta
        else:
            scores[:, arm_idx] = mean + alpha * uncertainty
    return scores, means


@router.post("/neural-shadow/train")
async def train_neural_shadow(req: NeuralShadowTrainRequest):
    if not req.contexts or not req.arms or not req.rewards:
        raise HTTPException(status_code=400, detail="contexts, arms and rewards are required")
    if not (len(req.contexts) == len(req.arms) == len(req.rewards)):
        raise HTTPException(status_code=400, detail="contexts, arms and rewards length mismatch")
    if not req.arm_names:
        raise HTTPException(status_code=400, detail="arm_names are required")

    x = np.asarray(req.contexts, dtype=float)
    arms = np.asarray(req.arms, dtype=int)
    rewards = np.asarray(req.rewards, dtype=float)
    arm_count = len(req.arm_names)
    if x.ndim != 2:
        raise HTTPException(status_code=400, detail="contexts must be a 2D matrix")
    if np.any(arms < 0) or np.any(arms >= arm_count):
        raise HTTPException(status_code=400, detail="arms contain out-of-range index")

    xz, _, _ = _standardize(x)
    phi = _neural_features(xz, req.policy_id, req.arm_names)
    models = _fit_arm_models(phi, arms, rewards, arm_count)
    scores, means = _score_actions(req.policy_id, phi, models)
    chosen = np.argmax(scores, axis=1)

    decisions = []
    max_decisions = min(len(chosen), 1000)
    for idx in range(max_decisions):
        baseline = req.baseline_actions[idx] if idx < len(req.baseline_actions) else req.arm_names[int(arms[idx])]
        symbol = req.symbols[idx] if idx < len(req.symbols) else str(idx)
        action_idx = int(chosen[idx])
        decisions.append({
            "business_date": req.business_date,
            "symbol": str(symbol),
            "arm_id": req.arm_names[action_idx],
            "baseline_action": str(baseline),
            "shadow_action": req.arm_names[action_idx],
            "counterfactual_reward": float(means[idx, action_idx]),
            "context": {"dim": int(x.shape[1]), "policy": req.policy_id},
            "evidence": {
                "algorithm": "deterministic_random_feature_neural_bandit",
                "observed_arm": req.arm_names[int(arms[idx])],
                "observed_reward": float(rewards[idx]),
                "model_samples_by_arm": [model["samples"] for model in models],
            },
        })

    return {
        "status": "ok",
        "policy_id": req.policy_id,
        "shadow_decisions": decisions,
        "training_report": {
            "algorithm": "NeuralUCB" if req.policy_id == "NeuralUCB" else "Neural Thompson Sampling",
            "samples": int(x.shape[0]),
            "context_dim": int(x.shape[1]),
            "feature_dim": int(phi.shape[1]),
            "arm_names": req.arm_names,
            "samples_by_arm": [model["samples"] for model in models],
            "decision_count": len(decisions),
        },
    }
