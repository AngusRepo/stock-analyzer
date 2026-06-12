from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from routers.meta_learning import NeuralShadowTrainRequest, train_neural_shadow


def test_neural_shadow_train_returns_counterfactual_decisions():
    req = NeuralShadowTrainRequest(
        policy_id="NeuralUCB",
        contexts=[
            [0.1, 0.2, 0.3],
            [0.2, 0.1, 0.4],
            [0.8, 0.7, 0.2],
            [0.7, 0.9, 0.3],
            [0.4, 0.5, 0.6],
            [0.5, 0.4, 0.7],
        ],
        arms=[0, 0, 1, 1, 2, 2],
        rewards=[0.01, 0.02, 0.03, 0.025, -0.01, 0.0],
        arm_names=["feature_family", "time_series_family", "do_nothing"],
        business_date="2026-05-08",
        symbols=["1", "2", "3", "4", "5", "6"],
        baseline_actions=["feature_family", "feature_family", "time_series_family", "time_series_family", "do_nothing", "do_nothing"],
    )

    result = asyncio.run(train_neural_shadow(req))

    assert result["status"] == "ok"
    assert result["training_report"]["samples"] == 6
    assert len(result["shadow_decisions"]) == 6
    assert result["shadow_decisions"][0]["business_date"] == "2026-05-08"


def test_neucb_shadow_train_returns_research_benchmark_evidence():
    req = NeuralShadowTrainRequest(
        policy_id="NeuCB",
        contexts=[
            [0.1, 0.2, 0.3],
            [0.2, 0.1, 0.4],
            [0.8, 0.7, 0.2],
            [0.7, 0.9, 0.3],
            [0.4, 0.5, 0.6],
            [0.5, 0.4, 0.7],
        ],
        arms=[0, 0, 1, 1, 2, 2],
        rewards=[0.01, 0.02, 0.03, 0.025, -0.01, 0.0],
        arm_names=["feature_family", "time_series_family", "do_nothing"],
        business_date="2026-05-08",
        symbols=["1", "2", "3", "4", "5", "6"],
        baseline_actions=["feature_family", "feature_family", "time_series_family", "time_series_family", "do_nothing", "do_nothing"],
    )

    result = asyncio.run(train_neural_shadow(req))

    assert result["status"] == "ok"
    assert result["policy_id"] == "NeuCB"
    assert result["training_report"]["algorithm"] == "NeuCB greedy benchmark"
    assert result["shadow_decisions"][0]["context"]["policy"] == "NeuCB"
