"""State-space/time-series payload export helpers.

The daily pipeline uses the same close-price series for Chronos, DLinear,
PatchTST, KalmanFilter, and MarkovSwitching. Keep the extraction logic in one
place so parity checks use the same payload shape as production inference.
"""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any


STATE_SPACE_SERIES_EXPORT_SCHEMA_VERSION = "state-space-series-export-v1"


def _as_mapping(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if is_dataclass(payload):
        return asdict(payload)
    return {}


def build_state_space_series_from_payloads(
    payloads: list[Any],
    *,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Extract `{symbol, prices}` rows from daily prediction payloads.

    The extraction intentionally mirrors the current daily pipeline behavior:
    use `prices[*].close`, skip rows without a symbol or usable closes, and keep
    input order unchanged.
    """
    series: list[dict[str, Any]] = []
    for payload in payloads or []:
        row = _as_mapping(payload)
        symbol = row.get("symbol")
        prices = row.get("prices") or []
        closes = [
            float(price.get("close", 0) or 0)
            for price in prices
            if isinstance(price, dict) and price.get("close") is not None
        ]
        if symbol and closes:
            series.append({"symbol": str(symbol), "prices": closes})
        if limit is not None and len(series) >= max(0, int(limit)):
            break
    return series


def build_state_space_series_export(
    *,
    run_date: str,
    payloads: list[Any],
    limit: int | None = None,
) -> dict[str, Any]:
    series = build_state_space_series_from_payloads(payloads, limit=limit)
    return {
        "schema_version": STATE_SPACE_SERIES_EXPORT_SCHEMA_VERSION,
        "run_date": run_date,
        "n_series": len(series),
        "series_list": series,
        "source": "daily_pipeline_v2.payloads.prices.close",
    }


def _extract_payloads_from_json(raw: Any) -> list[Any]:
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, dict):
        return []
    for key in ("payloads", "items", "rows"):
        value = raw.get(key)
        if isinstance(value, list):
            return value
    return []


def load_state_space_series_export_from_payload_file(
    *,
    path: str | Path,
    run_date: str,
    limit: int | None = None,
) -> dict[str, Any]:
    """Build a state-space series export from an offline payload JSON file."""
    source_path = Path(path)
    raw = json.loads(source_path.read_text(encoding="utf-8-sig"))
    payloads = _extract_payloads_from_json(raw)
    export = build_state_space_series_export(
        run_date=run_date,
        payloads=payloads,
        limit=limit,
    )
    export["n_payloads"] = len(payloads)
    export["source"] = "offline_payload_json.payloads.prices.close"
    export["source_path"] = str(source_path)
    return export


def load_daily_state_space_series_export(
    *,
    run_date: str,
    limit: int | None = None,
) -> dict[str, Any]:
    """Build a read-only daily state-space series export from D1 inputs."""
    from services import d1_client
    from services.payload_builder import (
        DAILY_RECOMMENDATION_PIPELINE_COLUMNS,
        build_ml_universe,
        build_payloads,
        load_market_env,
    )

    screener_recs = d1_client.query(
        f"SELECT {DAILY_RECOMMENDATION_PIPELINE_COLUMNS} "
        "FROM daily_recommendations WHERE date = ? ORDER BY rank",
        [run_date],
    )
    if not screener_recs:
        raise RuntimeError(f"screener_recs_missing for run_date={run_date}")

    active_stocks = build_ml_universe([], screener_recs)
    market_env, adaptive, barrier, lifecycle, trading_cfg = load_market_env(run_date)
    payloads = build_payloads(
        active_stocks=active_stocks,
        market_env=market_env,
        adaptive_params=adaptive,
        barrier_params=barrier,
        lifecycle_weights=lifecycle,
        trading_config=trading_cfg,
    )
    export = build_state_space_series_export(
        run_date=run_date,
        payloads=payloads,
        limit=limit,
    )
    export["n_payloads"] = len(payloads)
    export["n_screener_recs"] = len(screener_recs)
    return export
