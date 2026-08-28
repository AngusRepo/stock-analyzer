"""Read-only PIT validation for State-space v2 against immutable S12 outcomes.

The evaluator deliberately avoids rank buckets and top-k selection.  It joins
continuous State-space forecasts produced from prices known on each signal date
to the canonical, cost-net S12 replay outcomes.  It is a relevance screen, not
a formal post-exit continuation-value promotion test.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Iterable

import httpx
import numpy as np
import polars as pl


REPO_ROOT = Path(__file__).resolve().parents[1]
ML_SERVICE_ROOT = REPO_ROOT / "ml-service"
if str(ML_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_SERVICE_ROOT))

from app.state_space_v2 import build_state_space_v2_batch  # noqa: E402


ACCOUNT_ID_DEFAULT = "619a83ac9f20847d9e2f2920823b727d"
CORE_DB_ID_DEFAULT = "6401a5f6-5767-4fa8-a1a7-ec8d4739ac79"
MARKET_DB_ID_DEFAULT = "067bbeb0-1247-416a-96dd-138315345319"
LEARNING_DB_ID_DEFAULT = "73599848-b73b-4bac-9144-df638b877dbc"
S12_REPLAY_ENGINE_SIGNATURE = (
    "s12_replay_v3:tw_equity_raw_daily_namespace_safe:"
    "overlapping_r2_pit:five_session_price_domain:v2"
)
ROUNDTRIP_COST_BPS = 18.0
MIN_DATE_SAMPLE = 10


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha256(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


class D1ReadClient:
    def __init__(self, *, token: str, account_id: str) -> None:
        if not token.strip():
            raise RuntimeError("CF_API_TOKEN is required")
        self._account_id = account_id.strip()
        self._client = httpx.Client(
            headers={"Authorization": f"Bearer {token.strip()}", "Content-Type": "application/json"},
            timeout=90.0,
        )

    def close(self) -> None:
        self._client.close()

    def query(self, database_id: str, sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
        if sql.lstrip().split(None, 1)[0].upper() not in {"SELECT", "WITH", "PRAGMA", "EXPLAIN"}:
            raise ValueError("read_only_d1_client_rejected_mutating_sql")
        url = (
            f"https://api.cloudflare.com/client/v4/accounts/{self._account_id}"
            f"/d1/database/{database_id}/query"
        )
        response = self._client.post(url, json={"sql": sql, "params": params or []})
        response.raise_for_status()
        payload = response.json()
        if not payload.get("success"):
            raise RuntimeError(f"D1 query failed: {payload.get('errors', payload)}")
        result = payload.get("result") or []
        return list((result[0].get("results") if result else []) or [])


def _chunks(values: list[int], size: int) -> Iterable[list[int]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def load_formal_s12_outcomes(client: D1ReadClient, database_id: str, start_date: str, end_date: str) -> list[dict[str, Any]]:
    return client.query(
        database_id,
        """
        SELECT o.id, o.symbol, o.market, o.trade_date, o.signal_date,
               o.entry_price, o.stop_price, o.exit_price, o.pnl_pct,
               o.trade_pnl_r, o.max_favorable_pct, o.max_adverse_pct,
               o.bars_to_exit, o.exit_reason
          FROM s12_replay_trade_outcomes o
         WHERE o.trade_date >= ?
           AND o.trade_date <= ?
           AND o.sample_eligible = 1
           AND o.pnl_pct IS NOT NULL
           AND o.signal_date IS NOT NULL
           AND json_extract(o.detail_json, '$.replay_diagnostics.replay_engine_signature') = ?
           AND json_extract(o.detail_json, '$.replay_diagnostics.replay_cohort_signature') IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM allocator_ev_daily_lifecycle lifecycle
              WHERE lifecycle.business_date = o.signal_date
                AND lifecycle.state IN ('replay_complete', 'replay_pending_maturity')
           )
         ORDER BY o.signal_date, o.symbol, o.id
        """,
        [start_date, end_date, S12_REPLAY_ENGINE_SIGNATURE],
    )


def load_stock_identities(client: D1ReadClient, database_id: str, symbols: list[str]) -> dict[str, int]:
    if not symbols:
        return {}
    identities: dict[str, int] = {}
    for symbol_chunk in (symbols[index : index + 80] for index in range(0, len(symbols), 80)):
        placeholders = ",".join("?" for _ in symbol_chunk)
        rows = client.query(database_id, f"SELECT id, symbol FROM stocks WHERE symbol IN ({placeholders})", symbol_chunk)
        for row in rows:
            identities[str(row["symbol"])] = int(row["id"])
    return identities


def load_market_prices(
    client: D1ReadClient,
    database_id: str,
    stock_ids: list[int],
    start_date: str,
    end_date: str,
) -> dict[int, list[tuple[str, float]]]:
    by_stock: dict[int, list[tuple[str, float]]] = defaultdict(list)
    for stock_chunk in _chunks(sorted(set(stock_ids)), 30):
        placeholders = ",".join("?" for _ in stock_chunk)
        rows = client.query(
            database_id,
            f"""
            SELECT stock_id, date, close
              FROM stock_prices
             WHERE stock_id IN ({placeholders})
               AND date >= ? AND date <= ?
               AND close IS NOT NULL AND close > 0
             ORDER BY stock_id, date
            """,
            [*stock_chunk, start_date, end_date],
        )
        for row in rows:
            by_stock[int(row["stock_id"])].append((str(row["date"]), float(row["close"])))
    return dict(by_stock)


def _finite_float(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def build_pit_observations(
    outcomes: list[dict[str, Any]],
    identities: dict[str, int],
    prices_by_stock: dict[int, list[tuple[str, float]]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    symbols_by_date: dict[str, set[str]] = defaultdict(set)
    for row in outcomes:
        symbols_by_date[str(row["signal_date"])].add(str(row["symbol"]))

    observations: list[dict[str, Any]] = []
    packet_receipts: list[dict[str, Any]] = []
    for signal_date in sorted(symbols_by_date):
        series: list[dict[str, Any]] = []
        for symbol in sorted(symbols_by_date[signal_date]):
            stock_id = identities.get(symbol)
            if stock_id is None:
                continue
            closes = [close for observed_date, close in prices_by_stock.get(stock_id, []) if observed_date <= signal_date]
            series.append(
                {
                    "symbol": symbol,
                    "stock_id": stock_id,
                    "prices": closes,
                    "sequence_source": "market_d1_stock_prices_close_pit",
                }
            )
        packet = build_state_space_v2_batch(
            series,
            as_of_date=signal_date,
            run_id=f"local-pit-s12-{signal_date}",
            horizon_sessions=5,
            input_evidence={
                "price_owner": "stockvision-market-db.stock_prices",
                "as_of_fence": f"date <= {signal_date}",
                "outcome_owner": "stockvision-learning-db.s12_replay_trade_outcomes",
            },
        )
        observations.extend(packet["observations"])
        packet_receipts.append(
            {
                "signal_date": signal_date,
                "requested": len(series),
                "observations": int(packet["observation_count"]),
                "errors": int(packet["error_count"]),
                "payload_checksum": packet["payload_checksum"],
            }
        )
    return observations, {"dates": packet_receipts, "checksum": _sha256(packet_receipts)}


def _pearson(x: np.ndarray, y: np.ndarray) -> float | None:
    valid = np.isfinite(x) & np.isfinite(y)
    x_valid, y_valid = x[valid], y[valid]
    if x_valid.size < 3 or float(np.std(x_valid)) <= 1e-15 or float(np.std(y_valid)) <= 1e-15:
        return None
    return float(np.corrcoef(x_valid, y_valid)[0, 1])


def _mean_lcb90(values: list[float]) -> dict[str, Any]:
    clean = np.asarray([value for value in values if math.isfinite(value)], dtype=np.float64)
    if clean.size == 0:
        return {"n": 0, "mean": None, "lcb90": None}
    mean = float(np.mean(clean))
    if clean.size < 2:
        return {"n": int(clean.size), "mean": mean, "lcb90": None}
    standard_error = float(np.std(clean, ddof=1) / math.sqrt(clean.size))
    return {"n": int(clean.size), "mean": mean, "lcb90": mean - 1.6448536269514722 * standard_error}


def evaluate_relevance(outcomes: list[dict[str, Any]], observations: list[dict[str, Any]]) -> tuple[dict[str, Any], pl.DataFrame]:
    state_by_key = {(str(row["as_of_date"]), str(row["symbol"])): row for row in observations}
    joined: list[dict[str, Any]] = []
    for outcome in outcomes:
        state = state_by_key.get((str(outcome["signal_date"]), str(outcome["symbol"])))
        gross_pnl = _finite_float(outcome.get("pnl_pct"))
        if state is None or gross_pnl is None:
            continue
        net_pnl = gross_pnl - ROUNDTRIP_COST_BPS / 10_000.0
        joined.append(
            {
                **outcome,
                "forecast_return": float(state["forecast_return"]),
                "latent_slope_1d": float(state["latent_slope_1d"]),
                "up_probability": float(state["up_probability"]),
                "forecast_variance": float(state["forecast_variance"]),
                "innovation_z": float(state["innovation_z"]),
                "net_pnl_pct": net_pnl,
                "net_positive": net_pnl > 0,
                "forecast_positive": float(state["forecast_return"]) > 0,
                "stop_exit": str(outcome.get("exit_reason") or "") in {"structure_stop", "trailing_structure_stop"},
            }
        )
    frame = pl.DataFrame(joined) if joined else pl.DataFrame()
    if frame.is_empty():
        return {"status": "unavailable", "reason": "no_joined_rows"}, frame

    forecast = frame["forecast_return"].to_numpy()
    net_pnl = frame["net_pnl_pct"].to_numpy()
    day_correlations: list[float] = []
    day_spreads: list[float] = []
    per_date: list[dict[str, Any]] = []
    for signal_date in sorted(frame["signal_date"].unique().to_list()):
        day = frame.filter(pl.col("signal_date") == signal_date)
        corr = _pearson(day["forecast_return"].to_numpy(), day["net_pnl_pct"].to_numpy())
        positive = day.filter(pl.col("forecast_positive"))["net_pnl_pct"].to_numpy()
        non_positive = day.filter(~pl.col("forecast_positive"))["net_pnl_pct"].to_numpy()
        spread = float(np.mean(positive) - np.mean(non_positive)) if positive.size and non_positive.size else None
        if day.height >= MIN_DATE_SAMPLE and corr is not None:
            day_correlations.append(corr)
        if day.height >= MIN_DATE_SAMPLE and spread is not None:
            day_spreads.append(spread)
        per_date.append(
            {
                "signal_date": signal_date,
                "rows": day.height,
                "pearson_ic": corr,
                "positive_forecast_rows": int(positive.size),
                "non_positive_forecast_rows": int(non_positive.size),
                "positive_minus_non_positive_net_pnl": spread,
                "mean_net_pnl_pct": float(day["net_pnl_pct"].mean()),
            }
        )

    positive_frame = frame.filter(pl.col("forecast_positive"))
    non_positive_frame = frame.filter(~pl.col("forecast_positive"))
    direction_accuracy = float((frame["forecast_positive"] == frame["net_positive"]).mean())
    result = {
        "status": "complete",
        "contract": "state-space-v2-s12-pit-relevance-screen-v1",
        "rank_or_top_k_used": False,
        "formal_promotion_effect": False,
        "roundtrip_cost_bps": ROUNDTRIP_COST_BPS,
        "coverage": {
            "outcome_rows": len(outcomes),
            "state_observations": len(observations),
            "joined_rows": frame.height,
            "joined_dates": frame["signal_date"].n_unique(),
            "joined_symbols": frame["symbol"].n_unique(),
        },
        "baseline": {
            "gross_mean_pnl_pct": float(frame["pnl_pct"].mean()),
            "net_mean_pnl_pct": float(frame["net_pnl_pct"].mean()),
            "net_median_pnl_pct": float(frame["net_pnl_pct"].median()),
            "net_positive_rate": float(frame["net_positive"].mean()),
            "stop_exit_rate": float(frame["stop_exit"].mean()),
        },
        "continuous_signal": {
            "row_pearson_ic": _pearson(forecast, net_pnl),
            "date_clustered_ic": _mean_lcb90(day_correlations),
            "date_clustered_positive_spread": _mean_lcb90(day_spreads),
            "direction_accuracy": direction_accuracy,
            "positive_forecast": {
                "rows": positive_frame.height,
                "mean_net_pnl_pct": float(positive_frame["net_pnl_pct"].mean()) if positive_frame.height else None,
                "net_positive_rate": float(positive_frame["net_positive"].mean()) if positive_frame.height else None,
                "stop_exit_rate": float(positive_frame["stop_exit"].mean()) if positive_frame.height else None,
            },
            "non_positive_forecast": {
                "rows": non_positive_frame.height,
                "mean_net_pnl_pct": float(non_positive_frame["net_pnl_pct"].mean()) if non_positive_frame.height else None,
                "net_positive_rate": float(non_positive_frame["net_positive"].mean()) if non_positive_frame.height else None,
                "stop_exit_rate": float(non_positive_frame["stop_exit"].mean()) if non_positive_frame.height else None,
            },
        },
        "per_date": per_date,
    }
    result["result_checksum"] = _sha256(result)
    return result, frame


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--end-date", default="2026-08-28")
    parser.add_argument("--lookback-days", type=int, default=90)
    parser.add_argument("--price-lookback-days", type=int, default=300)
    parser.add_argument("--output-dir", default=str(REPO_ROOT / "output" / "s12_state_space_pit_validation"))
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    end = date.fromisoformat(args.end_date)
    start = end - timedelta(days=max(1, args.lookback_days))
    price_start = start - timedelta(days=max(120, args.price_lookback_days))
    client = D1ReadClient(
        token=os.environ.get("CF_API_TOKEN", ""),
        account_id=os.environ.get("CF_ACCOUNT_ID", ACCOUNT_ID_DEFAULT),
    )
    try:
        outcomes = load_formal_s12_outcomes(
            client,
            os.environ.get("CF_D1_LEARNING_DB_ID", LEARNING_DB_ID_DEFAULT),
            start.isoformat(),
            end.isoformat(),
        )
        symbols = sorted({str(row["symbol"]) for row in outcomes})
        identities = load_stock_identities(
            client,
            os.environ.get("CF_D1_CORE_DB_ID", CORE_DB_ID_DEFAULT),
            symbols,
        )
        prices = load_market_prices(
            client,
            os.environ.get("CF_D1_MARKET_DB_ID", MARKET_DB_ID_DEFAULT),
            list(identities.values()),
            price_start.isoformat(),
            end.isoformat(),
        )
    finally:
        client.close()

    observations, observation_receipt = build_pit_observations(outcomes, identities, prices)
    result, joined = evaluate_relevance(outcomes, observations)
    result["source_receipt"] = {
        "requested_window": {"start": start.isoformat(), "end": end.isoformat()},
        "price_window": {"start": price_start.isoformat(), "end": end.isoformat()},
        "replay_engine_signature": S12_REPLAY_ENGINE_SIGNATURE,
        "outcome_checksum": _sha256(outcomes),
        "identity_count": len(identities),
        "price_stock_count": len(prices),
        "observation_receipt": observation_receipt,
    }
    result["result_checksum"] = _sha256({key: value for key, value in result.items() if key != "result_checksum"})

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "report.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    if not joined.is_empty():
        joined.write_parquet(output_dir / "joined_evidence.parquet")
    print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
