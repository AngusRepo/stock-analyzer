"""Point-in-time inputs for the Portfolio-ML inspired allocation shadow.

The module is read-only.  It learns only from immutable Learning-D1 snapshots
whose outcomes were known by ``as_of_date`` and marks every result as
comparison-only.  Paper positions are the inherited portfolio state; no order
or production allocation is changed here.
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from typing import Any

import numpy as np

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain


SCHEMA_VERSION = "portfolio-ml-shadow-inputs-v1"
CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)
MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)
LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
PAPER_D1_CLIENT = client_proxy_for_domain(D1DataDomain.PAPER)
HORIZONS = (3, 5, 10)


def _finite(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _json_object(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _features(row: dict[str, Any], *, inherited_weight: float) -> list[float] | None:
    allocation = _json_object(row.get("alpha_allocation"))
    expected = _finite(
        row.get("expected_return")
        if row.get("expected_return") is not None
        else allocation.get("expected_return")
    )
    score = _finite(row.get("score"))
    heat = _finite(row.get("market_heat_expected_return"))
    if expected is None or score is None:
        return None
    return [
        1.0,
        expected,
        max(0.0, min(1.0, score / 100.0)),
        heat or 0.0,
        max(0.0, min(1.0, inherited_weight)),
    ]


def _ridge_fit(rows: list[tuple[list[float], float]], penalty: float = 1e-3) -> list[float] | None:
    if len(rows) < 20:
        return None
    matrix = np.asarray([features for features, _target in rows], dtype=float)
    target = np.asarray([target for _features, target in rows], dtype=float)
    regularizer = np.eye(matrix.shape[1], dtype=float) * max(1e-9, penalty)
    regularizer[0, 0] = 0.0
    try:
        coefficients = np.linalg.solve(matrix.T @ matrix + regularizer, matrix.T @ target)
    except np.linalg.LinAlgError:
        return None
    if not np.all(np.isfinite(coefficients)):
        return None
    return [float(value) for value in coefficients]


def _predict(coefficients: list[float] | None, features: list[float]) -> float | None:
    if not coefficients or len(coefficients) != len(features):
        return None
    value = float(np.dot(np.asarray(coefficients), np.asarray(features)))
    return value if math.isfinite(value) else None


def _load_training_rows(as_of_date: str, lookback_days: int) -> list[dict[str, Any]]:
    return LEARNING_D1_CLIENT.query(
        """
        SELECT a.snapshot_date, a.symbol, a.score, a.alpha_allocation,
               a.market_heat_expected_return, a.market_segment,
               o.horizon_days, o.residual_return_net, o.outcome_known_date
          FROM allocator_ev_feature_snapshots a
          JOIN selection_reference_snapshots_v1 r
            ON r.signal_date = a.snapshot_date
           AND r.symbol = a.symbol
           AND r.feature_available = 1
          JOIN canonical_selection_outcomes_v1 o
            ON o.signal_date = r.signal_date
           AND o.symbol = r.symbol
           AND o.producer_run_id = r.producer_run_id
         WHERE date(o.outcome_known_date) <= date(?)
           AND date(a.snapshot_date) >= date(?, ?)
           AND a.generation_mode = 'native'
           AND a.as_of_guard IS NOT NULL
           AND o.horizon_days IN (3,5,10)
         ORDER BY a.snapshot_date, a.symbol, o.horizon_days
         LIMIT 12000
        """,
        [as_of_date, as_of_date, f"-{max(30, min(int(lookback_days), 730))} days"],
        timeout=60.0,
    )


def load_inherited_paper_weights(
    candidates: list[dict[str, Any]],
    *,
    as_of_date: str,
    account_id: int = 1,
) -> dict[str, Any]:
    positions = PAPER_D1_CLIENT.query(
        "SELECT symbol, shares, avg_cost FROM paper_positions WHERE account_id=? AND shares>0",
        [account_id],
        timeout=20.0,
    )
    account_rows = PAPER_D1_CLIENT.query(
        "SELECT cash, initial_cash FROM paper_accounts WHERE id=? LIMIT 1",
        [account_id],
        timeout=20.0,
    )
    cash = max(0.0, _finite((account_rows[0] if account_rows else {}).get("cash")) or 0.0)
    candidate_price = {
        str(row.get("symbol") or "").strip(): _finite(row.get("current_price"))
        for row in candidates
        if str(row.get("symbol") or "").strip()
    }
    missing_symbols = sorted({
        str(row.get("symbol") or "").strip()
        for row in positions
        if str(row.get("symbol") or "").strip()
        and not (candidate_price.get(str(row.get("symbol") or "").strip()) or 0.0) > 0
    })
    latest_price: dict[str, float] = {}
    if missing_symbols:
        for offset in range(0, len(missing_symbols), 80):
            chunk = missing_symbols[offset : offset + 80]
            placeholders = ",".join("?" for _ in chunk)
            identities = CORE_D1_CLIENT.query(
                f"SELECT id, symbol FROM stocks WHERE symbol IN ({placeholders})",
                chunk,
                timeout=20.0,
            )
            symbol_by_id = {int(row["id"]): str(row["symbol"]) for row in identities}
            if not symbol_by_id:
                continue
            id_placeholders = ",".join("?" for _ in symbol_by_id)
            price_rows = MARKET_D1_CLIENT.query(
                f"""
                SELECT stock_id, close FROM (
                  SELECT stock_id, close,
                         ROW_NUMBER() OVER (PARTITION BY stock_id ORDER BY date DESC) AS rn
                    FROM stock_prices
                   WHERE stock_id IN ({id_placeholders}) AND date <= ? AND close > 0
                ) WHERE rn=1
                """,
                [*symbol_by_id, as_of_date],
                timeout=30.0,
            )
            for row in price_rows:
                price = _finite(row.get("close"))
                symbol = symbol_by_id.get(int(row.get("stock_id") or 0))
                if symbol and price and price > 0:
                    latest_price[symbol] = price
    values: dict[str, float] = {}
    unresolved: list[str] = []
    for row in positions:
        symbol = str(row.get("symbol") or "").strip()
        shares = max(0.0, _finite(row.get("shares")) or 0.0)
        price = candidate_price.get(symbol) or latest_price.get(symbol)
        if not symbol or not price or price <= 0:
            if symbol:
                unresolved.append(symbol)
            continue
        values[symbol] = shares * price
    nav = cash + sum(values.values())
    weights = {symbol: value / nav for symbol, value in values.items()} if nav > 0 else {}
    return {
        "weights": weights,
        "portfolio_value_twd": nav,
        "cash_weight": cash / nav if nav > 0 else 1.0,
        "position_count": len(positions),
        "priced_position_count": len(values),
        "unresolved_symbols": sorted(set(unresolved)),
        "status": "ready" if len(values) == len(positions) else "partial",
        "source": "paper_positions_plus_asof_market_close",
    }


def build_portfolio_ml_shadow_inputs(
    candidates: list[dict[str, Any]],
    *,
    as_of_date: str,
    inherited_state: dict[str, Any],
    lookback_days: int = 365,
    training_rows: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    training = [dict(row) for row in training_rows] if training_rows is not None else _load_training_rows(as_of_date, lookback_days)
    by_key: dict[tuple[str, str], dict[str, Any]] = defaultdict(dict)
    for row in training:
        key = (str(row.get("snapshot_date") or "")[:10], str(row.get("symbol") or ""))
        horizon = int(row.get("horizon_days") or 0)
        if horizon in HORIZONS:
            by_key[key]["base"] = row
            by_key[key][horizon] = _finite(row.get("residual_return_net"))

    horizon_training: dict[int, list[tuple[list[float], float]]] = {h: [] for h in HORIZONS}
    direct_training: list[tuple[list[float], float]] = []
    direct_examples_by_date: dict[str, list[tuple[list[float], float]]] = defaultdict(list)
    speed_training: list[tuple[list[float], float]] = []
    dates: set[str] = set()
    for (snapshot_date, _symbol), packet in sorted(by_key.items()):
        base = packet.get("base")
        if not isinstance(base, dict):
            continue
        allocation = _json_object(base.get("alpha_allocation"))
        inherited = _finite(allocation.get("allocation_weight")) or 0.0
        features = _features(base, inherited_weight=inherited)
        if features is None:
            continue
        dates.add(snapshot_date)
        for horizon in HORIZONS:
            target = packet.get(horizon)
            if target is not None:
                horizon_training[horizon].append((features, float(target)))
        fast = packet.get(3)
        medium = packet.get(5)
        slow = packet.get(10)
        if slow is not None:
            direct_examples_by_date[snapshot_date].append((features, max(0.0, float(slow))))
        if fast is not None and medium is not None and slow is not None:
            denominator = abs(float(fast)) + abs(float(slow)) + 1e-8
            urgency = max(0.05, min(1.0, abs(float(fast)) / denominator))
            if float(fast) * float(slow) < 0:
                urgency *= 0.5
            speed_training.append((features, urgency))

    for examples in direct_examples_by_date.values():
        positive_sum = sum(target for _features, target in examples)
        if positive_sum <= 0:
            direct_training.extend((features, 0.0) for features, _target in examples)
            continue
        direct_training.extend(
            (features, min(0.25, target / positive_sum))
            for features, target in examples
        )

    coefficients = {h: _ridge_fit(horizon_training[h]) for h in HORIZONS}
    direct_coefficients = _ridge_fit(direct_training)
    speed_coefficients = _ridge_fit(speed_training)
    inherited_weights = dict(inherited_state.get("weights") or {})
    paths: dict[str, dict[int, float]] = {}
    direct_targets: dict[str, float] = {}
    speeds: dict[str, float] = {}
    for row in candidates:
        symbol = str(row.get("symbol") or "").strip()
        if not symbol:
            continue
        features = _features(row, inherited_weight=float(inherited_weights.get(symbol, 0.0) or 0.0))
        if features is None:
            continue
        predicted_path = {
            horizon: predicted
            for horizon in HORIZONS
            if (predicted := _predict(coefficients[horizon], features)) is not None
        }
        if predicted_path:
            paths[symbol] = predicted_path
        direct = _predict(direct_coefficients, features)
        if direct is not None:
            direct_targets[symbol] = max(0.0, min(0.25, direct))
        speed = _predict(speed_coefficients, features)
        if speed is not None:
            speeds[symbol] = max(0.05, min(1.0, speed))

    model_ready = (
        all(coefficients[horizon] is not None for horizon in HORIZONS)
        and direct_coefficients is not None
        and speed_coefficients is not None
    )
    blockers: list[str] = []
    if inherited_state.get("status") != "ready":
        blockers.append("inherited_portfolio_incomplete")
    if len(dates) < 4:
        blockers.append("training_dates_below_4")
    if not model_ready:
        blockers.append("portfolio_ml_ridge_components_incomplete")
    return {
        "schema_version": SCHEMA_VERSION,
        "status": "shadow_ready" if not blockers else "shadow_observation_only",
        "production_effect": False,
        "promotion_eligible": False,
        "as_of_date": as_of_date,
        "training_row_count": len(training),
        "training_date_count": len(dates),
        "horizon_sample_counts": {str(h): len(horizon_training[h]) for h in HORIZONS},
        "multi_horizon_expected_return_path": paths,
        "direct_weight_targets": direct_targets,
        "dynamic_trading_speeds": speeds,
        "inherited_state": inherited_state,
        "model": {
            "kind": "purged_asof_ridge_direct_weight_shadow",
            "feature_names": ["intercept", "formal_expected_return", "score_v2", "market_heat_ev", "inherited_weight"],
            "horizon_coefficients": {str(h): coefficients[h] for h in HORIZONS},
            "direct_weight_coefficients": direct_coefficients,
            "dynamic_speed_coefficients": speed_coefficients,
        },
        "validation_blockers": blockers,
    }
