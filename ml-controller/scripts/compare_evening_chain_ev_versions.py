from __future__ import annotations

import argparse
import copy
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services import d1_client  # noqa: E402
from services.allocator_ev_fusion_artifact_builder import (  # noqa: E402
    build_allocator_ev_fusion_artifact_from_rows,
    load_allocator_ev_fusion_training_rows,
)
from services.l4_alpha_ev_artifact_builder import (  # noqa: E402
    build_l4_alpha_ev_artifact_from_rows,
    load_l4_alpha_ev_training_rows,
)
from services.l4_alpha_ev_producer import materialize_l4_alpha_ev  # noqa: E402
from services.recommendation_service import (  # noqa: E402
    apply_sparse_tangent_allocation,
    load_online_portfolio_bandit_reward_ledger,
)
from services.trading_config_loader import load_merged_trading_config  # noqa: E402


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _load_candidate_rows(run_date: str) -> list[dict[str, Any]]:
    rows = d1_client.query(
        """
        SELECT dr.*, s.symbol, s.name, p.forecast_data
        FROM daily_recommendations dr
        JOIN stocks s ON s.id = dr.stock_id
        JOIN predictions p
          ON p.stock_id = dr.stock_id
         AND p.prediction_date = dr.date
         AND p.model_name = 'ensemble'
        WHERE date(dr.date) = date(?)
        ORDER BY dr.score DESC, s.symbol ASC
        """,
        [run_date],
    )
    normalized: list[dict[str, Any]] = []
    for raw in rows:
        allocation = _loads(raw.get("alpha_allocation"))
        forecast = _loads(raw.get("forecast_data"))
        score_components = _loads(raw.get("score_components"))
        alpha_context = _loads(raw.get("alpha_context"))
        s12 = allocation.get("s12_trade_ev") if isinstance(allocation.get("s12_trade_ev"), dict) else None
        row = {
            **raw,
            "forecast_data": forecast,
            "ensemble_v2": forecast.get("ensemble_v2") if isinstance(forecast.get("ensemble_v2"), dict) else {},
            "score_components": score_components,
            "alpha_context": alpha_context,
            "alpha_allocation": {},
            "s12_trade_ev": s12,
            "trade_expected_return_net_pct": (s12 or {}).get("trade_expected_return_net_pct"),
            "trade_expected_return_source": (s12 or {}).get("trade_expected_return_source"),
            "confidence": raw.get("confidence") or (forecast.get("ensemble_v2") or {}).get("confidence"),
        }
        for key in ("l4_alpha_ev", "alpha_ev", "alpha_ev_prediction", "allocator_ev_fusion"):
            row.pop(key, None)
            if isinstance(row.get("ensemble_v2"), dict):
                row["ensemble_v2"].pop(key, None)
            row["forecast_data"].pop(key, None)
        normalized.append(row)
    return normalized


def _load_return_history(run_date: str, symbols: list[str]) -> dict[str, list[float]]:
    if not symbols:
        return {}
    rows = d1_client.query(
        """
        SELECT s.symbol, date(sp.date) AS price_date, sp.close
        FROM stock_prices sp
        JOIN stocks s ON s.id = sp.stock_id
        WHERE date(sp.date) <= date(?)
          AND date(sp.date) >= date(?, '-120 days')
        ORDER BY s.symbol ASC, date(sp.date) ASC
        """,
        [run_date, run_date],
    )
    wanted = set(symbols)
    closes: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        symbol = str(row.get("symbol") or "").strip()
        close = _finite(row.get("close"))
        if symbol in wanted and close is not None and close > 0:
            closes[symbol].append(close)
    return {
        symbol: [values[index] / values[index - 1] - 1.0 for index in range(1, len(values))]
        for symbol, values in closes.items()
        if len(values) >= 2
    }


def _base_policy(config: dict[str, Any]) -> dict[str, Any]:
    policy = copy.deepcopy(config.get("alphaFramework") or config.get("alpha_framework") or {})
    allocation = policy.setdefault("allocation", {})
    allocation["engine"] = "sparse_tangent_inverse_risk"
    allocation["controller"] = "OnlinePortfolioBandit"
    for key in ("allocatorEvFusion", "allocator_ev_fusion", "allocatorEVFusion", "allocationEvFusion"):
        policy.pop(key, None)
        allocation.pop(key, None)
    return policy


def _prod_l4(config: dict[str, Any]) -> dict[str, Any] | None:
    ev2 = config.get("ensemble_v2") if isinstance(config.get("ensemble_v2"), dict) else {}
    for value in (
        config.get("l4AlphaEv"),
        config.get("l4_alpha_ev"),
        ev2.get("l4AlphaEv"),
        ev2.get("l4_alpha_ev"),
    ):
        if isinstance(value, dict):
            return value
    return None


def _force_shadow_fusion_for_scoring(artifact: dict[str, Any]) -> dict[str, Any]:
    forced = copy.deepcopy(artifact)
    forced["validation_packet"] = {
        **(forced.get("validation_packet") or {}),
        "decision": "PASS",
        "shadow_forced_scoring_only": True,
    }
    forced["approval_state"] = "production_approved"
    forced["promotion_state"] = "production_primary"
    forced["promotion_tier"] = "primary"
    forced["primary_expected_return_allowed"] = True
    forced["assistive_expected_return_allowed"] = True
    return forced


def _allocation_detail(row: dict[str, Any]) -> dict[str, Any]:
    allocation = row.get("alpha_allocation") if isinstance(row.get("alpha_allocation"), dict) else {}
    resolver = allocation.get("allocator_edge_resolver") if isinstance(allocation.get("allocator_edge_resolver"), dict) else {}
    l4 = allocation.get("l4_alpha_ev") if isinstance(allocation.get("l4_alpha_ev"), dict) else {}
    fusion = allocation.get("allocator_ev_fusion") if isinstance(allocation.get("allocator_ev_fusion"), dict) else {}
    sparse = allocation.get("alpha_utility") if isinstance(allocation.get("alpha_utility"), dict) else {}
    return {
        "symbol": str(row.get("symbol") or ""),
        "name": row.get("name"),
        "signal": row.get("signal"),
        "score_v2": _finite(row.get("score")),
        "ml_edge": _finite((row.get("score_components") or {}).get("components", {}).get("mlEdge")),
        "technical": _finite((row.get("score_components") or {}).get("components", {}).get("technicalStructure")),
        "fundamental": _finite((row.get("score_components") or {}).get("components", {}).get("fundamentalQuality")),
        "confidence": _finite(row.get("confidence")),
        "expected_return": _finite(allocation.get("expected_return")),
        "expected_return_owner": allocation.get("expected_return_owner"),
        "expected_return_source": allocation.get("expected_return_source"),
        "l4_expected_return": _finite(l4.get("expected_return")),
        "fusion_selection_ev": _finite(fusion.get("selection_expected_return")),
        "fusion_execution_probability": _finite(fusion.get("execution_probability")),
        "fusion_execution_adjustment": _finite(fusion.get("execution_residual_adjustment")),
        "s12_execution_model_applied": fusion.get("s12_execution_model_applied"),
        "allocation_weight": _finite(row.get("allocation_weight") or allocation.get("allocation_weight")),
        "allocation_rank": allocation.get("allocation_rank"),
        "eligible_for_sparse": allocation.get("eligible_for_sparse"),
        "potential_buy": allocation.get("potential_buy"),
        "selection_reason": allocation.get("selection_reason"),
        "marginal_utility": _finite(sparse.get("marginal_utility")),
        "edge_quality": _finite(resolver.get("allocator_edge_quality_score")),
    }


def _run_variant(
    label: str,
    rows: list[dict[str, Any]],
    *,
    ranking: dict[str, Any],
    policy: dict[str, Any],
    return_history: dict[str, list[float]],
    reward_ledger: list[dict[str, Any]],
) -> dict[str, Any]:
    materialized_rows = copy.deepcopy(rows)
    for row in materialized_rows:
        prediction = {
            "ensemble_v2": row.get("ensemble_v2"),
            "alpha_context": row.get("alpha_context"),
        }
        l4_payload = materialize_l4_alpha_ev(row, prediction=prediction, policy=policy)
        if isinstance(l4_payload, dict):
            row["l4_alpha_ev"] = l4_payload
    output = apply_sparse_tangent_allocation(
        materialized_rows,
        ranking,
        alpha_policy=policy,
        return_history=return_history,
        opb_reward_ledger=reward_ledger,
    )
    details = [_allocation_detail(row) for row in output]
    selected = [detail for detail in details if (detail.get("allocation_weight") or 0.0) > 0.0]
    potential = [
        detail for detail in details
        if detail.get("signal") == "POTENTIAL_BUY" or detail.get("potential_buy") is True
    ]
    positive_unselected = [
        detail for detail in details
        if detail.get("eligible_for_sparse") is True
        and not (detail.get("allocation_weight") or 0.0) > 0.0
        and (detail.get("expected_return") or 0.0) > 0.0
    ]
    potential.sort(key=lambda item: (item.get("expected_return") or -99.0, item.get("score_v2") or 0.0), reverse=True)
    positive_unselected.sort(key=lambda item: (item.get("expected_return") or -99.0, item.get("score_v2") or 0.0), reverse=True)
    owners = Counter(str(detail.get("expected_return_owner") or "missing") for detail in details)
    return {
        "label": label,
        "row_count": len(output),
        "buy_count": len(selected),
        "buy_symbols": [item["symbol"] for item in selected],
        "selected": selected,
        "potential_buy_count": len(potential),
        "top_potential": potential[:15],
        "positive_ev_eligible_zero_weight_count": len(positive_unselected),
        "top_positive_ev_eligible_zero_weight": positive_unselected[:15],
        "owner_counts": dict(owners),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-date", default="2026-07-09")
    parser.add_argument("--training-end-date", default="2026-07-02")
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)

    config = load_merged_trading_config(prefer_worker=True, allow_offline_defaults=False)
    rows = _load_candidate_rows(args.run_date)
    if not rows:
        raise RuntimeError(f"no recommendations for {args.run_date}")
    return_history = _load_return_history(args.run_date, [str(row.get("symbol")) for row in rows])
    reward_ledger = load_online_portfolio_bandit_reward_ledger()
    ranking = copy.deepcopy(config.get("ranking") or {"enabled": True})

    l4_training = load_l4_alpha_ev_training_rows(
        d1_client.query,
        end_date=args.training_end_date,
        lookback_days=90,
        limit=6000,
    )
    l4_result = build_l4_alpha_ev_artifact_from_rows(
        l4_training,
        trained_until=args.training_end_date,
        lookback_days=90,
        min_samples=500,
        min_dates=20,
    )
    canonical_l4 = l4_result.get("artifact") or {}

    fusion_training = load_allocator_ev_fusion_training_rows(
        d1_client.query,
        end_date=args.training_end_date,
        lookback_days=90,
        limit=6000,
    )
    fusion_result = build_allocator_ev_fusion_artifact_from_rows(
        fusion_training,
        trained_until=args.training_end_date,
        lookback_days=90,
        min_samples=500,
        min_dates=20,
    )
    fusion_shadow = fusion_result.get("artifact") or {}

    prod_policy = _base_policy(config)
    prod_artifact = _prod_l4(config)
    if not isinstance(prod_artifact, dict):
        raise RuntimeError("production L4 artifact missing")
    prod_policy["l4_alpha_ev"] = prod_artifact

    canonical_policy = _base_policy(config)
    canonical_policy["l4_alpha_ev"] = canonical_l4

    fusion_policy = _base_policy(config)
    fusion_policy["l4_alpha_ev"] = canonical_l4
    fusion_policy["allocator_ev_fusion"] = _force_shadow_fusion_for_scoring(fusion_shadow)

    report = {
        "schema_version": "evening-chain-ev-version-comparison-v1",
        "run_date": args.run_date,
        "training_end_date": args.training_end_date,
        "common_input": {
            "candidate_count": len(rows),
            "return_history_symbols": len(return_history),
            "opb_live_ledger_samples": sum(int(row.get("samples") or 0) for row in reward_ledger),
            "allocator": "OnlinePortfolioBandit+sparse_tangent_inverse_risk",
        },
        "artifacts": {
            "prod": {
                "model_version": prod_artifact.get("model_version"),
                "validation": (prod_artifact.get("validation_packet") or {}).get("decision"),
                "promotion_state": prod_artifact.get("promotion_state") or prod_artifact.get("approval_state"),
            },
            "canonical_l4": {
                "model_version": canonical_l4.get("model_version"),
                "validation": (l4_result.get("validation_packet") or {}).get("decision"),
                "validation_packet": l4_result.get("validation_packet"),
                "rows": len(l4_training),
            },
            "fusion_v5": {
                "model_version": fusion_shadow.get("model_version"),
                "validation": (fusion_result.get("validation_packet") or {}).get("decision"),
                "validation_packet": fusion_result.get("validation_packet"),
                "rows": len(fusion_training),
                "scoring_mode": "forced_shadow_math_only_not_promotion_eligible",
            },
        },
        "variants": [
            _run_variant("current_prod", rows, ranking=ranking, policy=prod_policy, return_history=return_history, reward_ledger=reward_ledger),
            _run_variant("canonical_l4", rows, ranking=ranking, policy=canonical_policy, return_history=return_history, reward_ledger=reward_ledger),
            _run_variant("fusion_v5_shadow", rows, ranking=ranking, policy=fusion_policy, return_history=return_history, reward_ledger=reward_ledger),
        ],
    }
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(output),
        "variants": [
            {"label": item["label"], "buy_count": item["buy_count"], "buy_symbols": item["buy_symbols"]}
            for item in report["variants"]
        ],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
