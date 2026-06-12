from __future__ import annotations

import json

from app.linucb_multiplier_replay import (
    bandit_protection_from_l2,
    prepare_multiplier_replay_rows,
    run_linucb_multiplier_replay,
)


def _rows(n_days: int = 12, n_symbols: int = 4) -> list[dict]:
    out: list[dict] = []
    models = ["LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN", "DLinear", "PatchTST", "iTransformer", "TimesFM"]
    for day in range(n_days):
        date = f"2026-05-{day + 1:02d}"
        regime = "bull" if day % 2 == 0 else "volatile"
        best = "XGBoost" if regime == "bull" else "DLinear"
        for symbol_idx in range(n_symbols):
            actual = 0.02 if (symbol_idx + day) % 2 == 0 else -0.015
            for model in models:
                raw_score = 0.82 if model == best else 0.42
                signed = raw_score - 0.5
                direction_correct = int((signed >= 0) == (actual >= 0))
                out.append({
                    "date": date,
                    "stock_id": str(2300 + symbol_idx),
                    "symbol": str(2300 + symbol_idx),
                    "model_name": model,
                    "direction_correct": direction_correct,
                    "direction_accuracy": raw_score,
                    "actual_return_pct": actual,
                    "trade_pnl_pct": actual if direction_correct else -abs(actual),
                    "forecast_data": json.dumps({"rank_score": raw_score}),
                    "alpha_context": json.dumps({
                        "regime": regime,
                        "market_risk_score": 0.25 if regime == "bull" else 0.70,
                        "volatility": 0.12 if regime == "bull" else 0.40,
                    }),
                })
    return out


def test_bandit_protection_from_l2_uses_loss_thresholds_and_multiplier_order():
    l2 = {
        "bandit_loss_thresh_high": 0.75,
        "bandit_loss_thresh_med": 0.25,
        "bandit_max_mult_high": 1.1,
        "bandit_max_mult_med": 1.4,
        "bandit_max_mult_low": 2.4,
    }

    assert bandit_protection_from_l2(0, 0, l2)["bandit_max_mult"] == 2.4
    assert bandit_protection_from_l2(2, 4, l2)["bandit_max_mult"] == 1.4
    high = bandit_protection_from_l2(4, 4, l2)
    assert high["bandit_max_mult"] == 1.1
    assert high["bandit_force_explore"] is True


def test_prepare_multiplier_replay_rows_keeps_active_9_and_context():
    prepared = prepare_multiplier_replay_rows(_rows(n_days=1, n_symbols=1))

    assert len(prepared) == 9
    assert {row.model_name for row in prepared} == {
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
    assert prepared[0].context.shape == (4,)


def test_linucb_multiplier_replay_is_read_only_and_ranks_candidates():
    report = run_linucb_multiplier_replay(
        _rows(),
        candidates=[
            {
                "bandit_loss_thresh_high": 0.75,
                "bandit_loss_thresh_med": 0.25,
                "bandit_max_mult_high": 1.1,
                "bandit_max_mult_med": 1.4,
                "bandit_max_mult_low": 2.4,
            },
        ],
    )

    assert report["schema_version"] == "linucb-multiplier-replay-v1"
    assert report["production_effect"] is False
    assert report["mutation_allowed"] is False
    assert report["prepared_rows"] == 12 * 4 * 9
    assert report["candidate_count"] == 2
    assert report["baseline"]["candidate"]["bandit_max_mult_low"] == 2.5
    assert report["ranking"][0]["decisions"] == 12 * 4
    assert report["best_candidate"]
