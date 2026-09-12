"""State-space/time-series payload export helpers.

The daily pipeline uses the same close-price series for sequence predictors,
KalmanFilter, and MarkovSwitching. Keep the extraction logic in one place so
parity checks use the same payload shape as production inference.
"""

from __future__ import annotations

import io
import hashlib
import json
import os
import math
from copy import deepcopy
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timezone
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


def _utc_datetime(value: Any) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def long_history_sequence_artifact_evidence(
    *,
    prefix: str | None = None,
    as_of_utc: str | datetime | None = None,
    storage_client: Any | None = None,
) -> dict[str, Any]:
    """Return immutable GCS object evidence for PIT-safe sequence recovery."""

    resolved_prefix = (prefix or long_history_sequence_prefix()).strip().rstrip("/")
    bucket_name = _configured_bucket_name()
    if not bucket_name:
        raise RuntimeError("GCS_BUCKET_NAME is required for sequence artifact evidence")

    if storage_client is None:
        from google.cloud import storage

        storage_client = storage.Client()

    client = storage_client
    bucket = client.bucket(bucket_name)
    manifest_path = f"{resolved_prefix}/prep/sequence_manifest.json"
    manifest_blob = bucket.blob(manifest_path)
    if not manifest_blob.exists():
        raise RuntimeError(f"sequence artifact manifest missing: gs://{bucket_name}/{manifest_path}")
    batch_count = _load_manifest_batch_count(bucket, resolved_prefix)

    cutoff = _utc_datetime(as_of_utc) if as_of_utc is not None else None
    objects: list[dict[str, Any]] = []
    paths = [manifest_path, *(f"{resolved_prefix}/prep/batch_{idx}.npz" for idx in range(batch_count))]
    for path in paths:
        blob = bucket.blob(path)
        if not blob.exists():
            raise RuntimeError(f"sequence artifact object missing: gs://{bucket_name}/{path}")
        blob.reload()
        updated = _utc_datetime(blob.updated)
        if cutoff is not None and updated > cutoff:
            raise RuntimeError(
                "sequence artifact is newer than PIT source state: "
                f"gs://{bucket_name}/{path} updated={updated.isoformat()} cutoff={cutoff.isoformat()}"
            )
        objects.append({
            "gcs_uri": f"gs://{bucket_name}/{path}",
            "generation": str(blob.generation or ""),
            "updated_at": updated.isoformat(),
            "size": int(blob.size or 0),
            "md5_hash": str(blob.md5_hash or ""),
            "crc32c": str(blob.crc32c or ""),
        })

    fingerprint_payload = json.dumps(objects, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "schema_version": "state-space-sequence-artifact-evidence-v1",
        "prefix": resolved_prefix,
        "batch_count": batch_count,
        "batch_count_source": "runtime_manifest_resolver",
        "as_of_utc": cutoff.isoformat() if cutoff is not None else None,
        "object_count": len(objects),
        "object_fingerprint": hashlib.sha256(fingerprint_payload).hexdigest(),
        "objects": objects,
    }


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
    payloads: list[dict] | None = None,
    decision_date: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Prefer long-history close series while preserving the serving payload shape."""

    if payloads is not None or decision_date is not None:
        if payloads is None or decision_date is None:
            raise ValueError('sequence_daily_inputs_missing')
        return _enrich_daily_canonical_sequences(payloads, decision_date=decision_date,
            target_points=target_points, prefix=prefix)

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


def _sequence_day(value):
    if not isinstance(value, str) or len(value) != 10 or date.fromisoformat(value).isoformat() != value:
        raise ValueError('sequence_date_invalid')
    return value


def _sequence_price(value):
    if isinstance(value, bool) or value is None:
        raise ValueError('sequence_adjusted_price_invalid')
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise ValueError('sequence_adjusted_price_invalid')
    return parsed


def load_dated_long_history_records(*, symbols: set[str], decision_date: str, prefix: str | None = None):
    """Use the producer's existing checksum inventory, never the mutable cache.

    Validate bytes BEFORE deserializing the trusted GCS NPZ. Keep actual dates
    and lane price semantics; no undated legacy row or raw-price lane is an
    adjusted-price substitute. Observation-now is not historical PIT authority.
    """
    from google.cloud import storage
    import numpy as np
    _sequence_day(decision_date)
    prefix = (prefix or long_history_sequence_prefix()).strip().rstrip('/')
    bucket_name = _configured_bucket_name()
    if not bucket_name:
        raise ValueError('sequence_bucket_missing')
    bucket = storage.Client().bucket(bucket_name)
    manifest_blob = bucket.blob(f'{prefix}/prep/sequence_manifest.json')
    manifest = json.loads(manifest_blob.download_as_bytes().decode('utf-8-sig'))
    unsigned = {k: v for k, v in manifest.items() if k != 'manifest_checksum'}
    expected = hashlib.sha256(json.dumps(unsigned, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    count = manifest.get('batch_count')
    if (manifest.get('schema_version') != 'finlab-long-history-sequence-prep-v2'
            or manifest.get('contract') != 'sequence_records_v3' or manifest.get('status') != 'ready'
            or manifest.get('output_gcs_prefix') != prefix or manifest.get('manifest_checksum') != expected
            or type(count) is not int or count <= 0 or not isinstance(manifest.get('output_checksums'), dict)):
        raise ValueError('sequence_manifest_invalid')
    # Source-lane fields are already declared by the actual FinLab producer.
    adjusted_lanes = {r['lane'] for r in manifest.get('lane_reports', [])
                      if r.get('close_field') == 'adj_close'}
    if not adjusted_lanes:
        raise ValueError('sequence_adjusted_lane_missing')
    records = {}
    for idx in range(count):
        path = f'{prefix}/prep/batch_{idx}.npz'
        checksum = manifest['output_checksums'].get(path)
        raw = bucket.blob(path).download_as_bytes()
        if not checksum or hashlib.sha256(raw).hexdigest() != checksum:
            raise ValueError('sequence_batch_checksum_mismatch')
        with np.load(io.BytesIO(raw), allow_pickle=True) as data:
            if 'sequence_records' not in data.files:
                raise ValueError('sequence_dated_records_missing')
            rows = data['sequence_records'].tolist()
        for row in rows:
            symbol = row.get('symbol') if isinstance(row, dict) else None
            if symbol not in symbols:
                continue
            if symbol in records or row.get('source_lane') not in adjusted_lanes:
                raise ValueError('sequence_source_identity_or_basis_invalid')
            dates, prices = row.get('dates'), row.get('close')
            if not isinstance(dates, list) or not isinstance(prices, list) or len(dates) != len(prices) or not dates:
                raise ValueError('sequence_date_price_alignment_invalid')
            days = [_sequence_day(d) for d in dates]
            if days != sorted(set(days)):
                raise ValueError('sequence_dates_not_strictly_increasing')
            values = [_sequence_price(p) for p in prices]
            records[symbol] = {d: p for d, p in zip(days, values) if d <= decision_date}
    # A concurrent mutable-prefix refresh cannot produce a mixed valid batch set
    # because each batch is checked against the single manifest read above.
    return records, {'manifest_checksum': expected, 'records_checksum': manifest.get('records_checksum'),
        'output_checksums': manifest['output_checksums'],
        'prefix': prefix, 'price_basis': 'finlab_adjusted_close', 'cutoff_date': decision_date}


def _enrich_daily_canonical_sequences(payloads, *, decision_date, target_points=None, prefix=None):
    from services.payload_builder import MARKET_D1_CLIENT, _d1_bind_chunks
    from services.paired_nav_journal import digest
    _sequence_day(decision_date)
    target = daily_sequence_target_points() if target_points is None else target_points
    if type(target) is not int or target <= 0:
        raise ValueError('sequence_target_points_invalid')
    symbols = [p.get('symbol') for p in payloads]
    if any(not isinstance(s, str) or not s or s != s.strip() for s in symbols) or len(symbols) != len(set(symbols)):
        raise ValueError('sequence_symbols_invalid')
    required = {}
    for payload in payloads:
        days = []
        for row in payload.get('prices') or []:
            day = _sequence_day(row.get('date'))
            if day > decision_date:
                raise ValueError('sequence_payload_after_decision')
            if row.get('close') is not None:
                _sequence_price(row['close'])
                days.append(day)
        if days != sorted(set(days)):
            raise ValueError('sequence_payload_dates_not_strictly_increasing')
        required[payload['symbol']] = days[-target:]
    canonical = {s: {} for s in symbols}
    observations = []
    for chunk in _d1_bind_chunks(symbols):
        rows = MARKET_D1_CLIENT.query(
            f"SELECT symbol,date,adj_close,as_of_date,source FROM ("
            f"SELECT stock_id AS symbol,date,adj_close,as_of_date,source,"
            f"ROW_NUMBER() OVER(PARTITION BY stock_id ORDER BY date DESC) AS rn "
            f"FROM canonical_market_daily WHERE stock_id IN ({','.join('?' for _ in chunk)}) "
            f"AND source='finlab.price' AND date<=? AND as_of_date<=?) "
            f"WHERE rn<=? ORDER BY symbol,date", [*chunk, decision_date, decision_date, target], timeout=120.0)
        seen = set()
        for row in rows:
            s, day = row.get('symbol'), _sequence_day(row.get('date'))
            as_of = _sequence_day(row.get('as_of_date'))
            if (s not in chunk or (s, day) in seen or day > decision_date or as_of > decision_date
                    or as_of < day or row.get('source') != 'finlab.price'):
                raise ValueError('sequence_canonical_identity_or_time_invalid')
            seen.add((s, day))
            observations.append(deepcopy(row))
            if row.get('adj_close') is not None:
                canonical[s][day] = _sequence_price(row['adj_close'])
    needed = {s for s in symbols if len(canonical[s]) < target or not set(required[s]) <= set(canonical[s])}
    long, history_meta, issues = {}, None, []
    if needed and long_history_sequence_enabled():
        try:
            long, history_meta = load_dated_long_history_records(symbols=needed, decision_date=decision_date, prefix=prefix)
        except Exception as exc:
            # Optional historical extension cannot erase verified daily prices.
            # Keep the failure visible; NEVER replace missing adjusted data with
            # raw close, a stale tail, padded zeros or undated historical prices.
            code = str(exc)
            issues.append({'stage': 'long_history', 'reason': code if code.startswith('sequence_')
                           and code.replace('_', '').isalnum() else 'sequence_history_read_failed',
                           'error_type': type(exc).__name__})
    out = []
    for symbol in symbols:
        base, older = canonical[symbol], long.get(symbol, {})
        conflict = any(not math.isclose(base[d], older[d], rel_tol=1e-8, abs_tol=1e-8) for d in base.keys() & older.keys())
        if conflict:
            issues.append({'symbol': symbol, 'reason': 'sequence_adjusted_vintage_mismatch'})
            older = {}
        # If both series are present, overlap is necessary to verify same scale.
        if base and older and not base.keys() & older.keys():
            issues.append({'symbol': symbol, 'reason': 'sequence_adjusted_overlap_missing'})
            older = {}
        combined = {**older, **base}
        missing = sorted(set(required[symbol]) - set(combined))
        available_days = sorted(combined)[-target:]
        latest_mismatch = bool(required[symbol] and combined and max(combined) != required[symbol][-1])
        unavailable = bool(missing) or not required[symbol] or latest_mismatch
        days = [] if unavailable else available_days
        out.append({'symbol': symbol, 'prices': [combined[d] for d in days], 'dates': days,
            'sequence_source': 'finlab_canonical_and_verified_history' if older else 'finlab_canonical_adjusted',
            'price_basis': 'finlab_adjusted_close', 'history_points_available': len(combined),
            'status': 'unavailable' if unavailable else 'ready', 'missing_adjusted_dates': missing,
            'reason': 'canonical_adjusted_dates_missing' if missing else 'payload_market_dates_missing' if not required[symbol]
                      else 'payload_canonical_latest_date_mismatch' if latest_mismatch else None})
    return out, {'schema_version': 'state-space-dated-adjusted-enrichment-v1',
        'source': 'finlab_dated_adjusted_prices', 'decision_date': decision_date, 'target_points': target,
        'input_series': len(payloads), 'output_series': len(out),
        'canonical_observation_checksum': digest(observations), 'canonical_observations': observations,
        'history': history_meta, 'history_observations': long, 'source_issues': issues,
        'unavailable_symbols': [r['symbol'] for r in out if r['status'] == 'unavailable'],
        'knowledge_scope': 'observed_at_capture_not_historical_asof'}


def sequence_input_fingerprints(payloads):
    from services.paired_nav_journal import digest
    fingerprints = {}
    for row in payloads:
        symbol = row.get('symbol')
        if not isinstance(symbol, str) or not symbol or symbol in fingerprints:
            raise ValueError('sequence_snapshot_input_symbols_invalid')
        fingerprints[symbol] = digest({'symbol': symbol, 'stock_id': row.get('stock_id'), 'prices': row.get('prices') or []})
    return fingerprints


def read_frozen_sequence_inputs(packet, *, decision_date, payloads, observed_before=None):
    from services.paired_nav_journal import digest, _timestamp
    if (not isinstance(packet, dict) or packet.get('schema_version') != 'pipeline-sequence-observations-v1'
            or packet.get('signal_date') != decision_date
            or packet.get('source_checksum') != digest({k: v for k, v in packet.items() if k != 'source_checksum'})
            or not isinstance(packet.get('input_fingerprints'), dict) or not isinstance(packet.get('series'), list)):
        raise ValueError('sequence_snapshot_invalid')
    observed = _timestamp(packet['observed_at'])
    if observed_before is not None and observed > _timestamp(observed_before):
        raise ValueError('sequence_snapshot_observed_after_parent')
    inputs = sequence_input_fingerprints(payloads)
    if any(packet['input_fingerprints'].get(s) != value for s, value in inputs.items()):
        raise ValueError('sequence_snapshot_raw_inputs_changed')
    rows = {}
    for row in packet['series']:
        s = row.get('symbol')
        if s not in packet['input_fingerprints'] or s in rows or not isinstance(row.get('prices'), list):
            raise ValueError('sequence_snapshot_coverage_invalid')
        for price in row['prices']:
            _sequence_price(price)
        if 'dates' in row:
            days = [_sequence_day(d) for d in row['dates']]
            if len(days) != len(row['prices']) or days != sorted(set(days)) or any(d > decision_date for d in days):
                raise ValueError('sequence_snapshot_dates_invalid')
        rows[s] = row
    selected = [deepcopy(rows[s]) for s in inputs if s in rows]
    return selected, {**deepcopy(packet.get('metadata') or {}), 'frozen_source_checksum': packet['source_checksum'],
                       'input_series': len(payloads), 'output_series': len(selected)}


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
    from services.d1_domain_client import D1DataDomain, client_for_domain
    from services.payload_builder import build_ml_universe, build_payloads, load_market_env

    screener_recs = client_for_domain(D1DataDomain.CORE).query(
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
        decision_date=run_date,
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
