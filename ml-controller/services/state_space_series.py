"""State-space/time-series payload export helpers.

The daily pipeline uses the same close-price series for sequence predictors,
KalmanFilter, and MarkovSwitching. Keep the extraction logic in one place so
parity checks use the same payload shape as production inference.
"""

from __future__ import annotations

import io
import json
import os
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any

from services.active_model_policy import (
    daily_sequence_target_points,
    long_history_sequence_enabled,
    long_history_sequence_prefix,
)


STATE_SPACE_SERIES_EXPORT_SCHEMA_VERSION = "state-space-series-export-v1"
LONG_HISTORY_SEQUENCE_SCHEMA_VERSION = "state-space-series-long-history-enrichment-v1"
_LONG_HISTORY_CACHE: dict[str, dict[str, list[float]]] = {}


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


def _coerce_close_values(values: Any) -> list[float]:
    close: list[float] = []
    for value in values or []:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            continue
        if parsed > 0:
            close.append(parsed)
    return close


def _configured_bucket_name() -> str:
    return os.environ.get("GCS_BUCKET_NAME", "").strip()


def _load_manifest_batch_count(bucket: Any, prefix: str) -> int:
    blob = bucket.blob(f"{prefix}/prep/sequence_manifest.json")
    if not blob.exists():
        return int(os.environ.get("STOCKVISION_SEQUENCE_LONG_BATCH_COUNT", "6") or "6")
    manifest = json.loads(blob.download_as_text().lstrip("\ufeff"))
    batches = manifest.get("batches") or manifest.get("batch_files")
    if isinstance(batches, list) and batches:
        return len(batches)
    for key in ("batch_count", "n_batches"):
        try:
            value = int(manifest.get(key) or 0)
        except (TypeError, ValueError):
            value = 0
        if value > 0:
            return value
    return int(os.environ.get("STOCKVISION_SEQUENCE_LONG_BATCH_COUNT", "6") or "6")


def load_long_history_sequence_map(
    *,
    symbols: set[str] | None = None,
    prefix: str | None = None,
) -> dict[str, list[float]]:
    """Load close-only long-history sequence rows from the GCS prep artifact.

    The artifact is produced by the FinLab long-sequence refresh and stores NPZ
    batches of `sequence_records`. Only requested symbols are retained.
    """

    resolved_prefix = (prefix or long_history_sequence_prefix()).strip().rstrip("/")
    wanted = {str(symbol) for symbol in symbols or set() if str(symbol).strip()}
    symbol_key = "*" if not wanted else ",".join(sorted(wanted))
    cache_key = f"{_configured_bucket_name()}::{resolved_prefix}::{symbol_key}"
    if cache_key in _LONG_HISTORY_CACHE:
        return dict(_LONG_HISTORY_CACHE[cache_key])

    bucket_name = _configured_bucket_name()
    if not bucket_name:
        return {}

    from google.cloud import storage
    import numpy as np

    bucket = storage.Client().bucket(bucket_name)
    batch_count = _load_manifest_batch_count(bucket, resolved_prefix)
    out: dict[str, list[float]] = {}
    for idx in range(max(0, batch_count)):
        blob = bucket.blob(f"{resolved_prefix}/prep/batch_{idx}.npz")
        if not blob.exists():
            continue
        raw = blob.download_as_bytes()
        with np.load(io.BytesIO(raw), allow_pickle=True) as data:
            records = data["sequence_records"].tolist() if "sequence_records" in data.files else []
        for record in records or []:
            if not isinstance(record, dict):
                continue
            symbol = str(record.get("symbol") or "").strip()
            if not symbol or (wanted and symbol not in wanted):
                continue
            close = _coerce_close_values(record.get("close") or record.get("series_close") or record.get("prices"))
            if close:
                out[symbol] = close

    _LONG_HISTORY_CACHE[cache_key] = dict(out)
    return out


def enrich_state_space_series_with_long_history(
    series: list[dict[str, Any]],
    *,
    target_points: int | None = None,
    prefix: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Prefer long-history close series while preserving the serving payload shape."""

    target = int(target_points or daily_sequence_target_points())
    base = list(series or [])
    meta: dict[str, Any] = {
        "schema_version": LONG_HISTORY_SEQUENCE_SCHEMA_VERSION,
        "enabled": long_history_sequence_enabled(),
        "target_points": target,
        "input_series": len(base),
        "source": "payload_prices",
    }
    if not base or not meta["enabled"]:
        meta["output_series"] = len(base)
        return base, meta

    symbols = {str(row.get("symbol") or "").strip() for row in base if row.get("symbol")}
    try:
        long_map = load_long_history_sequence_map(symbols=symbols, prefix=prefix)
    except Exception as exc:  # noqa: BLE001 - caller still enforces sequence length.
        meta.update({
            "status": "payload_prices_only",
            "error": f"{type(exc).__name__}: {exc}",
            "output_series": len(base),
        })
        return base, meta

    enriched: list[dict[str, Any]] = []
    enriched_count = 0
    lengths: list[int] = []
    for row in base:
        symbol = str(row.get("symbol") or "").strip()
        payload_prices = _coerce_close_values(row.get("prices") or [])
        long_prices = long_map.get(symbol) or []
        chosen = long_prices if len(long_prices) > len(payload_prices) else payload_prices
        if target > 0:
            chosen = chosen[-target:]
        out_row = {**row, "prices": chosen}
        if long_prices and len(long_prices) >= len(payload_prices):
            enriched_count += 1
            out_row["sequence_source"] = "gcs_long_history"
            out_row["history_points_available"] = len(long_prices)
        else:
            out_row["sequence_source"] = "payload_prices"
            out_row["history_points_available"] = len(payload_prices)
        lengths.append(len(chosen))
        enriched.append(out_row)

    meta.update({
        "status": "ok",
        "source": "gcs_long_history_or_payload_prices",
        "prefix": (prefix or long_history_sequence_prefix()).strip().rstrip("/"),
        "output_series": len(enriched),
        "enriched_series": enriched_count,
        "min_points": min(lengths) if lengths else 0,
        "max_points": max(lengths) if lengths else 0,
    })
    return enriched, meta


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
    from services.payload_builder import build_ml_universe, build_payloads, load_market_env

    screener_recs = d1_client.query(
        "SELECT * FROM daily_recommendations WHERE date = ? ORDER BY rank",
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
