from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import polars as pl

from services import d1_client
from services.dataset_snapshots import build_dataset_snapshot_manifest, upsert_dataset_snapshot_manifest


def _date_add(date_s: str, days: int) -> str:
    return (datetime.strptime(date_s, "%Y-%m-%d") + timedelta(days=days)).strftime("%Y-%m-%d")


def _date_chunks(start_date: str, end_date: str, chunk_days: int) -> list[tuple[str, str]]:
    chunks: list[tuple[str, str]] = []
    current = start_date
    while current <= end_date:
        chunk_end = min(_date_add(current, max(1, chunk_days) - 1), end_date)
        chunks.append((current, chunk_end))
        if chunk_end == end_date:
            break
        current = _date_add(chunk_end, 1)
    return chunks


def _frame(rows: list[dict]) -> pl.DataFrame:
    return pl.DataFrame(rows, infer_schema_length=None) if rows else pl.DataFrame()


def _empty_frame(columns: list[str]) -> pl.DataFrame:
    return pl.DataFrame(schema={column: pl.Utf8 for column in columns})


def _query_date_range(sql: str, start_date: str, end_date: str, chunk_days: int) -> tuple[pl.DataFrame, int]:
    frames: list[pl.DataFrame] = []
    query_count = 0
    for chunk_start, chunk_end in _date_chunks(start_date, end_date, chunk_days):
        rows = d1_client.query(sql, [chunk_start, chunk_end], timeout=120.0)
        query_count += 1
        if rows:
            frames.append(_frame(rows))
    if not frames:
        return pl.DataFrame(), query_count
    return pl.concat(frames, how="diagonal_relaxed"), query_count


def _gcs_bucket_name() -> str:
    name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not name:
        raise RuntimeError("GCS_BUCKET_NAME not configured")
    return name


def _gcs_client_bucket():
    from google.cloud import storage

    bucket_name = _gcs_bucket_name()
    return storage.Client().bucket(bucket_name), bucket_name


def _temporary_directory(prefix: str):
    base_dir = os.environ.get("STOCKVISION_TMP_DIR", "").strip()
    if base_dir:
        Path(base_dir).mkdir(parents=True, exist_ok=True)
        return tempfile.TemporaryDirectory(prefix=prefix, dir=base_dir, ignore_cleanup_errors=True)
    return tempfile.TemporaryDirectory(prefix=prefix, ignore_cleanup_errors=True)


def _write_component_to_gcs(bucket, prefix: str, name: str, df: pl.DataFrame, tmp_dir: Path) -> dict[str, Any]:
    local_path = tmp_dir / f"{name}.parquet"
    df.write_parquet(local_path)
    object_name = f"{prefix.rstrip('/')}/{name}.parquet"
    blob = bucket.blob(object_name)
    blob.upload_from_filename(str(local_path), content_type="application/octet-stream")
    return {
        "name": name,
        "row_count": int(len(df)),
        "gcs_uri": f"gs://{bucket.name}/{object_name}",
        "columns": list(df.columns),
        "bytes": int(local_path.stat().st_size),
    }


def _checksum_payload(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    return f"sha256:{hashlib.sha256(raw).hexdigest()}"


@dataclass(frozen=True)
class D1ColdArchiveExportRequest:
    business_date: str
    start_date: str
    end_date: str
    tables: tuple[str, ...] = (
        "stock_prices",
        "technical_indicators",
        "chip_data",
        "margin_data",
        "predictions",
    )
    gcs_prefix: str | None = None
    producer_run_id: str | None = None
    chunk_days: int = 10
    hot_window_days: int = 504


@dataclass(frozen=True)
class FinLabRawArchiveMetadataRequest:
    manifest_path: str
    business_date: str
    producer_run_id: str
    gcs_uri: str | None = None


D1_COLD_ARCHIVE_TABLE_SPECS: dict[str, dict[str, str]] = {
    "stock_prices": {"date_column": "date", "order_by": "date, stock_id"},
    "technical_indicators": {"date_column": "date", "order_by": "date, stock_id"},
    "chip_data": {"date_column": "date", "order_by": "date, symbol"},
    "margin_data": {"date_column": "date", "order_by": "date, stock_id"},
    "predictions": {"date_column": "prediction_date", "order_by": "prediction_date, stock_id"},
}


def _query_cold_archive_table(table: str, start_date: str, end_date: str, chunk_days: int) -> tuple[pl.DataFrame, int]:
    spec = D1_COLD_ARCHIVE_TABLE_SPECS.get(table)
    if not spec:
        raise ValueError(f"d1_cold_archive_table_not_allowed:{table}")
    date_column = spec["date_column"]
    return _query_date_range(
        f"""
        SELECT *
        FROM {table}
        WHERE {date_column} >= ? AND {date_column} <= ?
        ORDER BY {spec["order_by"]}
        """,
        start_date,
        end_date,
        chunk_days,
    )


def export_d1_cold_archive_snapshot(req: D1ColdArchiveExportRequest) -> dict[str, Any]:
    """Export exact D1 cold rows to a GCS archive snapshot before any D1 deletion."""
    started = time.perf_counter()
    chunk_days = max(1, min(int(req.chunk_days or 10), 30))
    allowed_tables = tuple(dict.fromkeys(req.tables))

    bucket, bucket_name = _gcs_client_bucket()
    run_id = req.producer_run_id or f"d1-cold-archive-{req.business_date}-{int(time.time())}"
    prefix = (
        req.gcs_prefix
        or f"archives/d1_cold_archive/business_date={req.business_date}/run_id={run_id}"
    ).strip("/")

    components: dict[str, pl.DataFrame] = {}
    table_query_counts: dict[str, int] = {}
    for table in allowed_tables:
        df, query_count = _query_cold_archive_table(table, req.start_date, req.end_date, chunk_days)
        table_query_counts[table] = query_count
        if not df.is_empty():
            components[table] = df

    if not components:
        raise RuntimeError("d1_cold_archive_no_rows")

    component_meta: dict[str, dict[str, Any]] = {}
    with _temporary_directory(prefix="stockvision-d1-cold-archive-") as tmp:
        tmp_dir = Path(tmp)
        for table, df in components.items():
            component_meta[table] = _write_component_to_gcs(bucket, prefix, f"d1_{table}", df, tmp_dir)

    table_coverage = []
    for table, meta in component_meta.items():
        spec = D1_COLD_ARCHIVE_TABLE_SPECS[table]
        table_coverage.append({
            "table": table,
            "date_column": spec["date_column"],
            "coverage_start": req.start_date,
            "coverage_end": req.end_date,
            "source": "stockvision_d1_exact",
            "component_gcs_uri": meta["gcs_uri"],
            "row_count": meta["row_count"],
        })

    row_count = sum(int(meta["row_count"]) for meta in component_meta.values())
    metadata = {
        "role": "d1_cold_archive",
        "source": "stockvision_d1_exact",
        "business_date": req.business_date,
        "start_date": req.start_date,
        "end_date": req.end_date,
        "hot_window_days": int(req.hot_window_days),
        "delete_requires_manual_approval": True,
        "table_coverage": table_coverage,
        "component_meta": component_meta,
        "d1_query_counts": table_query_counts,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
    manifest_payload = {
        "kind": "d1_cold_archive",
        "business_date": req.business_date,
        "start_date": req.start_date,
        "end_date": req.end_date,
        "row_count": row_count,
        "table_coverage": table_coverage,
    }
    manifest = build_dataset_snapshot_manifest(
        snapshot_id=f"d1_cold_archive:{req.business_date}:{run_id}",
        kind="d1_cold_archive",
        business_date=req.business_date,
        schema_version="d1-cold-archive-parquet-v1",
        row_count=row_count,
        checksum=_checksum_payload(manifest_payload),
        access_tier="archive",
        producer_run_id=run_id,
        gcs_uri=f"gs://{bucket_name}/{prefix}",
        metadata_json=json.dumps(metadata, ensure_ascii=False),
    )
    upsert_dataset_snapshot_manifest(manifest)
    return {
        "status": "ready",
        "snapshot": manifest,
        "component_meta": component_meta,
        "table_coverage": table_coverage,
        "d1_query_counts": table_query_counts,
        "elapsed_s": round(time.perf_counter() - started, 3),
    }


def build_finlab_5y_raw_archive_metadata(req: FinLabRawArchiveMetadataRequest) -> dict[str, Any]:
    """Normalize an existing local FinLab 5Y raw manifest without calling FinLab API."""
    manifest_path = Path(req.manifest_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    datasets = payload.get("datasets") or {}
    dataset_coverage = []
    for name, info in sorted(datasets.items()):
        if not isinstance(info, dict):
            continue
        dataset_coverage.append({
            "dataset": name,
            "row_count": int(info.get("rows") or info.get("row_count") or 0),
            "min_date": info.get("min_date") or info.get("start_date"),
            "max_date": info.get("max_date") or info.get("end_date"),
            "artifact_count": len(info.get("artifacts") or []),
        })
    return {
        "role": "finlab_5y_raw_archive_metadata",
        "source": "finlab_5y_raw",
        "business_date": req.business_date,
        "producer_run_id": req.producer_run_id,
        "local_manifest_path": str(manifest_path),
        "gcs_uri": req.gcs_uri,
        "run_id": payload.get("run_id"),
        "lookback_years": payload.get("lookback_years"),
        "dataset_count": int(payload.get("dataset_count") or len(dataset_coverage)),
        "finlab_rows": int(payload.get("finlab_rows") or 0),
        "missing_in_stockvision": int(payload.get("missing_in_stockvision") or 0),
        "value_conflicts": int(payload.get("value_conflicts") or 0),
        "dataset_coverage": dataset_coverage,
        "normalized_at": datetime.now(timezone.utc).isoformat(),
    }


def _query_active_stocks(start_date: str, end_date: str) -> pl.DataFrame:
    return _frame(d1_client.query(
        """
        SELECT id, symbol, name, market, sector, in_current_watchlist,
               listed_date, delisted_date
        FROM stocks
        WHERE (delisted_date IS NULL OR delisted_date >= ?)
          AND (listed_date IS NULL OR listed_date <= ?)
        """,
        [start_date, end_date],
        timeout=120.0,
    ))


def _query_prices(start_date: str, end_date: str, chunk_days: int) -> tuple[pl.DataFrame, int]:
    return _query_date_range(
        """
        SELECT stock_id, date, open, high, low, close, adj_close, volume, avg_price
        FROM stock_prices
        WHERE date >= ? AND date <= ?
        ORDER BY stock_id, date
        """,
        start_date,
        end_date,
        chunk_days,
    )


def _query_market_risk(start_date: str, end_date: str) -> pl.DataFrame:
    return _frame(d1_client.query(
        """
        SELECT *
        FROM market_risk
        WHERE date >= ? AND date <= ?
        ORDER BY date
        """,
        [start_date, end_date],
        timeout=120.0,
    ))


def _query_sentiment_scores(start_date: str, end_date: str, chunk_days: int) -> tuple[pl.DataFrame, int]:
    return _query_date_range(
        """
        SELECT stock_id, date(published_at) as date,
               AVG(CASE sentiment WHEN 'positive' THEN 1 WHEN 'negative' THEN -1 ELSE 0 END) as score
        FROM news
        WHERE date(published_at) >= ? AND date(published_at) <= ?
        GROUP BY stock_id, date(published_at)
        ORDER BY stock_id, date
        """,
        start_date,
        end_date,
        chunk_days,
    )


def _query_monthly_revenue(start_date: str, end_date: str) -> pl.DataFrame:
    return _frame(d1_client.query(
        """
        SELECT stock_id, date, revenue, revenue_yoy, revenue_mom
        FROM monthly_revenue
        WHERE date <= ?
        ORDER BY stock_id, date
        """,
        [end_date],
        timeout=120.0,
    ))


def _query_margin_data(start_date: str, end_date: str, chunk_days: int) -> tuple[pl.DataFrame, int]:
    return _query_date_range(
        """
        SELECT stock_id, date, margin_buy, margin_sell, margin_balance,
               short_buy, short_sell, short_balance, short_ratio
        FROM margin_data
        WHERE date >= ? AND date <= ?
        ORDER BY stock_id, date
        """,
        start_date,
        end_date,
        chunk_days,
    )


def _query_shareholding(start_date: str, end_date: str, chunk_days: int) -> tuple[pl.DataFrame, int]:
    return _query_date_range(
        """
        SELECT stock_id, date, total_shares, holder_count, retail_shares,
               retail_pct, large_holder_shares, large_holder_pct
        FROM shareholding
        WHERE date >= ? AND date <= ?
        ORDER BY stock_id, date
        """,
        start_date,
        end_date,
        chunk_days,
    )


def _write_compute_snapshot(
    *,
    req: DatasetSnapshotExportRequest,
    schema_version: str,
    components: dict[str, pl.DataFrame],
    d1_query_counts: dict[str, Any],
    started: float,
) -> dict[str, Any]:
    bucket, bucket_name = _gcs_client_bucket()
    run_id = req.producer_run_id or f"dataset-export-{req.business_date}-{int(time.time())}"
    prefix = (
        req.gcs_prefix
        or f"datasets/{req.kind}/business_date={req.business_date}/run_id={run_id}"
    ).strip("/")

    component_meta: dict[str, dict[str, Any]] = {}
    with _temporary_directory(prefix="stockvision-dataset-export-") as tmp:
        tmp_dir = Path(tmp)
        for name, df in components.items():
            component_meta[name] = _write_component_to_gcs(bucket, prefix, name, df, tmp_dir)

    return _register_compute_manifest(
        req=req,
        schema_version=schema_version,
        component_meta=component_meta,
        d1_query_counts=d1_query_counts,
        gcs_uri=f"gs://{bucket_name}/{prefix}",
        started=started,
        run_id=run_id,
    )


def _register_compute_manifest(
    *,
    req: DatasetSnapshotExportRequest,
    schema_version: str,
    component_meta: dict[str, dict[str, Any]],
    d1_query_counts: dict[str, Any],
    gcs_uri: str,
    started: float,
    run_id: str | None = None,
) -> dict[str, Any]:
    run_id = run_id or req.producer_run_id or f"dataset-export-{req.business_date}-{int(time.time())}"
    row_count = sum(int(meta["row_count"]) for meta in component_meta.values())
    metadata = {
        "role": "compute_snapshot",
        "kind": req.kind,
        "business_date": req.business_date,
        "start_date": req.start_date,
        "end_date": req.end_date,
        "components": {name: meta["gcs_uri"] for name, meta in component_meta.items()},
        "component_meta": component_meta,
        "d1_query_counts": d1_query_counts,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
    manifest_payload = {
        "kind": req.kind,
        "business_date": req.business_date,
        "start_date": req.start_date,
        "end_date": req.end_date,
        "row_count": row_count,
        "component_meta": component_meta,
    }
    manifest = build_dataset_snapshot_manifest(
        snapshot_id=f"{req.kind}:{req.business_date}:{run_id}",
        kind=req.kind,
        business_date=req.business_date,
        schema_version=schema_version,
        row_count=row_count,
        checksum=_checksum_payload(manifest_payload),
        access_tier="compute",
        producer_run_id=run_id,
        gcs_uri=gcs_uri,
        metadata_json=json.dumps(metadata, ensure_ascii=False),
    )
    upsert_dataset_snapshot_manifest(manifest)
    return {
        "status": "ready",
        "snapshot": manifest,
        "component_meta": component_meta,
        "d1_query_counts": metadata["d1_query_counts"],
        "elapsed_s": round(time.perf_counter() - started, 3),
    }


@dataclass(frozen=True)
class DatasetSnapshotExportRequest:
    business_date: str
    start_date: str
    end_date: str
    kind: str = "backtest_dataset"
    gcs_prefix: str | None = None
    producer_run_id: str | None = None
    chunk_days: int = 10
    include_signals: bool = True


def export_backtest_dataset_snapshot(req: DatasetSnapshotExportRequest) -> dict[str, Any]:
    """Export D1 research data into a GCS compute snapshot and D1 manifest."""
    started = time.perf_counter()
    chunk_days = max(1, min(int(req.chunk_days or 10), 30))

    stocks = _query_active_stocks(req.start_date, req.end_date)
    prices, price_queries = _query_prices(req.start_date, req.end_date, chunk_days)
    indicators, indicator_queries = _query_date_range(
        """
        SELECT stock_id, date, ma5, ma10, ma20, ma60, rsi14, macd, macd_signal,
               macd_hist, atr14, bb_upper, bb_mid, bb_lower
        FROM technical_indicators
        WHERE date >= ? AND date <= ?
        ORDER BY stock_id, date
        """,
        req.start_date,
        req.end_date,
        chunk_days,
    )
    chips, chip_queries = _query_date_range(
        """
        SELECT symbol, date, foreign_buy, foreign_sell, foreign_net,
               trust_buy, trust_sell, trust_net, dealer_buy, dealer_sell,
               dealer_net, margin_balance, short_balance
        FROM chip_data
        WHERE date >= ? AND date <= ?
        ORDER BY symbol, date
        """,
        req.start_date,
        req.end_date,
        chunk_days,
    )
    market_risk = _query_market_risk(req.start_date, req.end_date)
    sentiment, sentiment_queries = _query_sentiment_scores(req.start_date, req.end_date, chunk_days)
    monthly_revenue = _query_monthly_revenue(req.start_date, req.end_date)
    margin_data, margin_queries = _query_margin_data(req.start_date, req.end_date, chunk_days)
    shareholding, shareholding_queries = _query_shareholding(req.start_date, req.end_date, chunk_days)

    if stocks.is_empty():
        raise RuntimeError("dataset_export_no_stocks")
    if prices.is_empty():
        raise RuntimeError("dataset_export_no_prices")
    if indicators.is_empty():
        indicators = _empty_frame(["stock_id", "date"])
    if chips.is_empty():
        chips = _empty_frame(["symbol", "date"])
    if market_risk.is_empty():
        market_risk = _empty_frame(["date"])
    if sentiment.is_empty():
        sentiment = _empty_frame(["stock_id", "date", "score"])
    if monthly_revenue.is_empty():
        monthly_revenue = _empty_frame(["stock_id", "date", "revenue_yoy"])
    if margin_data.is_empty():
        margin_data = _empty_frame(["stock_id", "date", "margin_balance", "short_ratio"])
    if shareholding.is_empty():
        shareholding = _empty_frame(["stock_id", "date", "retail_pct"])

    components: dict[str, pl.DataFrame] = {
        "stocks": stocks,
        "prices": prices,
        "indicators": indicators,
        "chips": chips,
        "market_risk": market_risk,
        "sentiment": sentiment,
        "monthly_revenue": monthly_revenue,
        "margin_data": margin_data,
        "shareholding": shareholding,
    }
    signal_queries = 0
    if req.include_signals:
        signals, signal_queries = _query_date_range(
            """
            SELECT stock_id, generated_at, prediction_date, trade_signal,
                   direction_accuracy, entry_price, stop_loss, target1, target2,
                   forecast_data
            FROM predictions
            WHERE model_name = 'ensemble'
              AND COALESCE(prediction_date, substr(generated_at, 1, 10)) >= ?
              AND COALESCE(prediction_date, substr(generated_at, 1, 10)) <= ?
            ORDER BY stock_id, generated_at
            """,
            req.start_date,
            req.end_date,
            chunk_days,
        )
        if signals.is_empty():
            raise RuntimeError("dataset_export_no_ensemble_signals")
        components["signals"] = signals

    return _write_compute_snapshot(
        req=req,
        schema_version="backtest-dataset-parquet-v2",
        components=components,
        d1_query_counts={
            "stocks": 1,
            "prices": price_queries,
            "indicators": indicator_queries,
            "chips": chip_queries,
            "market_risk": 1,
            "sentiment": sentiment_queries,
            "monthly_revenue": 1,
            "margin_data": margin_queries,
            "shareholding": shareholding_queries,
            "signals": signal_queries,
        },
        started=started,
    )


def export_price_history_snapshot(req: DatasetSnapshotExportRequest) -> dict[str, Any]:
    """Export price-history data used by Optuna barrier/RRG into a GCS compute snapshot."""
    started = time.perf_counter()
    chunk_days = max(1, min(int(req.chunk_days or 10), 30))
    request = DatasetSnapshotExportRequest(
        business_date=req.business_date,
        start_date=req.start_date,
        end_date=req.end_date,
        kind="price_history",
        gcs_prefix=req.gcs_prefix,
        producer_run_id=req.producer_run_id,
        chunk_days=req.chunk_days,
        include_signals=False,
    )
    stocks = _query_active_stocks(req.start_date, req.end_date)
    prices, price_queries = _query_prices(req.start_date, req.end_date, chunk_days)
    market_risk = _query_market_risk(req.start_date, req.end_date)

    if stocks.is_empty():
        raise RuntimeError("dataset_export_no_stocks")
    if prices.is_empty():
        raise RuntimeError("dataset_export_no_prices")
    if market_risk.is_empty():
        market_risk = _empty_frame(["date"])

    return _write_compute_snapshot(
        req=request,
        schema_version="price-history-parquet-v1",
        components={
            "stocks": stocks,
            "prices": prices,
            "market_risk": market_risk,
        },
        d1_query_counts={
            "stocks": 1,
            "prices": price_queries,
            "market_risk": 1,
        },
        started=started,
    )


def export_daily_research_snapshots(req: DatasetSnapshotExportRequest) -> dict[str, Any]:
    """Export daily research data once, then register both full and price-history manifests."""
    backtest_req = DatasetSnapshotExportRequest(
        business_date=req.business_date,
        start_date=req.start_date,
        end_date=req.end_date,
        kind="backtest_dataset",
        gcs_prefix=req.gcs_prefix,
        producer_run_id=req.producer_run_id,
        chunk_days=req.chunk_days,
        include_signals=True,
    )
    backtest_summary = export_backtest_dataset_snapshot(backtest_req)
    backtest_snapshot = backtest_summary.get("snapshot") or {}
    component_meta = backtest_summary.get("component_meta") or {}
    price_components = {
        name: meta
        for name, meta in component_meta.items()
        if name in {"stocks", "prices", "market_risk"}
    }
    missing = {"stocks", "prices", "market_risk"} - set(price_components)
    if missing:
        raise RuntimeError(f"price_history_manifest_missing_components:{','.join(sorted(missing))}")

    started = time.perf_counter()
    price_req = DatasetSnapshotExportRequest(
        business_date=req.business_date,
        start_date=req.start_date,
        end_date=req.end_date,
        kind="price_history",
        gcs_prefix=req.gcs_prefix,
        producer_run_id=req.producer_run_id,
        chunk_days=req.chunk_days,
        include_signals=False,
    )
    d1_counts = backtest_summary.get("d1_query_counts") or {}
    price_summary = _register_compute_manifest(
        req=price_req,
        schema_version="price-history-parquet-v1",
        component_meta=price_components,
        d1_query_counts={
            "stocks": int(d1_counts.get("stocks", 0) or 0),
            "prices": int(d1_counts.get("prices", 0) or 0),
            "market_risk": int(d1_counts.get("market_risk", 0) or 0),
            "shared_with": "backtest_dataset",
        },
        gcs_uri=backtest_snapshot.get("gcs_uri"),
        started=started,
        run_id=req.producer_run_id,
    )
    return {
        "status": "ready",
        "snapshots": {
            "backtest_dataset": backtest_summary,
            "price_history": price_summary,
        },
    }
