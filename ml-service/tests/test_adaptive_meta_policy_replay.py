from __future__ import annotations

import json

from app.adaptive_meta_policy_replay import (
    ReplayConfig,
    build_replay_samples,
    run_adaptive_meta_policy_replay,
)


def _synthetic_rows(n_days: int = 14, n_symbols: int = 8) -> list[dict]:
    rows: list[dict] = []
    models = ["XGBoost", "TabM", "GNN", "DLinear"]
    for day in range(n_days):
        date = f"2026-05-{day + 1:02d}"
        regime = "bull" if day % 2 == 0 else "volatile"
        best = "XGBoost" if regime == "bull" else "DLinear"
        for symbol_idx in range(n_symbols):
            actual = (symbol_idx - (n_symbols / 2)) / 100.0
            if actual == 0:
                actual = 0.001
            for model in models:
                rank_score = actual if model == best else -actual
                direction_correct = int((rank_score >= 0) == (actual >= 0))
                rows.append(
                    {
                        "date": date,
                        "stock_id": str(2300 + symbol_idx),
                        "symbol": str(2300 + symbol_idx),
                        "model_name": model,
                        "direction_correct": direction_correct,
                        "actual_return_pct": actual,
                        "trade_pnl_pct": actual if direction_correct else -abs(actual),
                        "forecast_data": json.dumps({"rank_score": rank_score}),
                        "ml_vote_summary": json.dumps({"coverage": 0.82, "ic_4w_avg": 0.04}),
                        "alpha_context": json.dumps(
                            {
                                "regime": regime,
                                "market_risk_score": 0.25 if regime == "bull" else 0.65,
                                "volatility": 0.12 if regime == "bull" else 0.36,
                            }
                        ),
                    }
                )
    return rows


def test_build_replay_samples_uses_family_date_rewards():
    rows = _synthetic_rows(n_days=2, n_symbols=8)

    samples = build_replay_samples(rows, ReplayConfig(min_ic_samples=4))

    assert len(samples) == 2
    first = samples[0]
    assert set(first.arm_rewards).issuperset({"tree_family", "time_series_family"})
    assert first.arm_rewards["tree_family"].ic is not None
    assert first.arm_rewards["tree_family"].reward > first.arm_rewards["time_series_family"].reward
    assert first.context.shape == (12,)


def test_adaptive_meta_policy_replay_compares_all_candidates_read_only():
    report = run_adaptive_meta_policy_replay(
        _synthetic_rows(),
        config=ReplayConfig(min_ic_samples=4, min_windows=6, neural_epochs=10, seed=5),
    )

    assert report["schema_version"] == "adaptive-meta-policy-replay-v1"
    assert report["production_effect"] is False
    assert report["sample_windows"] == 14
    assert set(report["methods"]) == {"LinUCB", "NeuralUCB", "NeuralTS", "NeuCB"}
    assert [row["method"] for row in report["ranking"]]
    assert report["baselines"]["best_fixed_hindsight"]["note"].startswith("hindsight")

    candidate = report["allocator_policy_candidate"]
    assert candidate["schema_version"] == "allocator-policy-candidate-v1"
    assert candidate["candidate_type"] == "family_allocator_model_weight_multipliers"
    assert candidate["approved"] is False
    assert candidate["mutation_allowed"] is False
    assert candidate["production_effect"] is False
    assert candidate["proposed_production_effect"] == "capped_production_effect"
    assert candidate["requires_wei_approval"] is True
    assert candidate["allowed_target"] == "ml:adaptive_params.model_allocator"
    assert candidate["model_multiplier_cap"] == 0.15
    assert set(candidate["model_weight_multipliers"]) == {
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
        "TimesFM",
    }
    assert all(0.85 <= mult <= 1.15 for mult in candidate["model_weight_multipliers"].values())
