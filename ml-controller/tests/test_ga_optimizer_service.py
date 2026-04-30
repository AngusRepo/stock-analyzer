from __future__ import annotations

from services.ga_optimizer_service import (
    GAOptimizerRequest,
    build_ga_candidate,
    evaluate_ga_population,
    run_ga_optimizer,
)


def _score(candidate: dict) -> dict:
    params = candidate["params"]
    weights = params["alphaFramework"]["allocation"]["weights"]["bull"]
    risk = params["alphaFramework"]["riskOverlay"]
    trend = weights["trend_following"]
    high_vol = risk["highVolThreshold"]
    score = 1.0 - abs(trend - 0.62) - abs(high_vol - 0.045) * 5.0
    return {
        "score": score,
        "sharpe": 1.2 + score,
        "max_drawdown": 0.12,
        "trade_count": 80,
        "pbo": 0.25,
        "mdd_95th": 0.18,
    }


def test_ga_candidate_is_alpha_framework_learning_state_not_predictor():
    candidate = build_ga_candidate(
        {"allocation": {"weights": {"bull": {"trend_following": 0.62}}}},
        generation=3,
        candidate_index=7,
    )

    assert candidate["source"] == "ga_optimizer"
    assert candidate["target"] == "meta_optimizer_learning"
    assert candidate["metadata"]["optimizer"] == "GAOptimizer"
    assert candidate["metadata"]["direct_prediction"] is False
    assert candidate["metadata"]["learning_mode"] == "direct"
    assert candidate["params"]["alphaFramework"]["allocation"]["weights"]["bull"]["trend_following"] == 0.62


def test_evaluate_ga_population_uses_gate_and_plateau_not_raw_score_only():
    candidates = [
        build_ga_candidate({"allocation": {"weights": {"bull": {"trend_following": 0.62}}}}, generation=0, candidate_index=0),
        build_ga_candidate({"allocation": {"weights": {"bull": {"trend_following": 0.20}}}}, generation=0, candidate_index=1),
    ]

    result = evaluate_ga_population(candidates, evaluator=_score)

    assert result["best"]["gate"]["decision"] == "PASS"
    assert result["best"]["gate"]["passed"] is True
    assert result["best"]["plateau"]["plateau_size"] >= 1
    assert result["best"]["candidate"]["target"] == "meta_optimizer_learning"
    assert result["ranked"][0]["score"] >= result["ranked"][1]["score"]


def test_run_ga_optimizer_generates_learning_state_without_prod_mutation():
    result = run_ga_optimizer(
        GAOptimizerRequest(population_size=8, generations=3, seed=11, mutation_rate=0.35),
        evaluator=_score,
    )

    assert result["status"] == "completed"
    assert result["contract"]["applies_to_production"] is False
    assert result["contract"]["push_target"] == "worker_kv_ga_optimizer_state"
    assert result["contract"]["learning_mode"] == "direct"
    assert result["best"]["candidate"]["target"] == "meta_optimizer_learning"
    assert result["best"]["candidate"]["params"]["alphaFramework"]
    assert len(result["ranked"]) <= 8
