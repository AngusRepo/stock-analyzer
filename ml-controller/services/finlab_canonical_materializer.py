from __future__ import annotations

import ast
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import polars as pl


SCHEMA_VERSION = "finlab-canonical-materializer-v1"


@dataclass(frozen=True)
class FinLabCanonicalOutputs:
    run_id: str
    generated_at: str
    artifact_root: str
    canonical_market_daily: list[dict[str, Any]]
    canonical_chip_daily: list[dict[str, Any]]
    canonical_institutional_amount_daily: list[dict[str, Any]]
    canonical_revenue_monthly: list[dict[str, Any]]
    canonical_broker_flow_daily: list[dict[str, Any]]
    finlab_taxonomy_tags: list[dict[str, Any]]
    data_source_inventory: list[dict[str, Any]]
    source_quality_metrics: list[dict[str, Any]]
    manifest: dict[str, Any]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _json(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)


def _date_expr(name: str = "date") -> pl.Expr:
    return pl.col(name).cast(pl.Utf8).str.slice(0, 10)


def normalize_symbol(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    # FinLab ROTC broker rows use values like "1260 富味鄉".
    first = raw.split()[0].strip()
    return first or raw


def _read_parquet(path: Path) -> pl.DataFrame:
    if not path.exists():
        return pl.DataFrame()
    return pl.read_parquet(path)


def _filter_dates(df: pl.DataFrame, *, start_date: str | None, end_date: str | None, date_col: str = "date") -> pl.DataFrame:
    if df.is_empty() or date_col not in df.columns:
        return df
    out = df.with_columns(_date_expr(date_col).alias(date_col))
    if start_date:
        out = out.filter(pl.col(date_col) >= start_date)
    if end_date:
        out = out.filter(pl.col(date_col) <= end_date)
    return out


def _wide_field_to_long(path: Path, field: str, *, start_date: str | None, end_date: str | None) -> pl.DataFrame:
    df = _read_parquet(path)
    if df.is_empty() or "date" not in df.columns:
        return pl.DataFrame({"date": [], "stock_id": [], field: []})
    df = _filter_dates(df, start_date=start_date, end_date=end_date)
    value_columns = [col for col in df.columns if col != "date"]
    if not value_columns:
        return pl.DataFrame({"date": [], "stock_id": [], field: []})
    return (
        df.unpivot(index="date", on=value_columns, variable_name="stock_id", value_name=field)
        .filter(pl.col(field).is_not_null())
        .with_columns(
            _date_expr("date").alias("date"),
            pl.col("stock_id").cast(pl.Utf8),
            pl.col(field).cast(pl.Float64, strict=False),
        )
    )


def _join_wide_fields(
    lane_dir: Path,
    fields: Iterable[str],
    *,
    start_date: str | None,
    end_date: str | None,
) -> pl.DataFrame:
    joined: pl.DataFrame | None = None
    for field in fields:
        frame = _wide_field_to_long(lane_dir / f"{field}.parquet", field, start_date=start_date, end_date=end_date)
        if frame.is_empty():
            continue
        joined = frame if joined is None else joined.join(frame, on=["date", "stock_id"], how="full", coalesce=True)
    return joined if joined is not None else pl.DataFrame()


def _rows(df: pl.DataFrame, limit: int | None = None) -> list[dict[str, Any]]:
    if df.is_empty():
        return []
    if limit and limit > 0:
        df = df.head(limit)
    return df.to_dicts()


def _lineage(run_id: str, lane: str, fields: list[str], artifact_root: Path) -> str:
    return _json({
        "schema_version": SCHEMA_VERSION,
        "run_id": run_id,
        "dataset_lane": lane,
        "fields": fields,
        "artifact_root": str(artifact_root),
        "source": "finlab",
    })


def build_market_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    lane: str,
    market_segment: str,
    source: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    fields = ["open", "high", "low", "close", "volume", "value"]
    df = _join_wide_fields(artifact_root / "raw" / lane, fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    lineage = _lineage(run_id, lane, fields, artifact_root)
    df = df.with_columns(
        pl.lit(market_segment).alias("market_segment"),
        pl.lit(source).alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).select([
        "stock_id",
        "date",
        "market_segment",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "value",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(df, limit)


def build_chip_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    fields = ["foreign_net", "trust_net", "dealer_self_net", "dealer_hedge_net", "margin_balance", "short_balance"]
    df = _join_wide_fields(artifact_root / "raw" / "chip_diversity", fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    lineage = _lineage(run_id, "chip_diversity", fields, artifact_root)
    df = df.with_columns(
        (pl.col("dealer_self_net").fill_null(0) + pl.col("dealer_hedge_net").fill_null(0)).alias("dealer_net"),
        pl.lit("LISTED_OTC").alias("market_segment"),
        pl.lit("finlab.institutional_investors_trading_summary").alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).select([
        "stock_id",
        "date",
        "market_segment",
        "foreign_net",
        "trust_net",
        "dealer_net",
        "margin_balance",
        "short_balance",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(df, limit)


INSTITUTIONAL_AMOUNT_CATEGORY_MAP: dict[str, tuple[str, str]] = {
    "上市合計": ("LISTED", "total"),
    "上市外資": ("LISTED", "foreign_total"),
    "上市外資及陸資(不含外資自營商)": ("LISTED", "foreign"),
    "上市外資自營商": ("LISTED", "foreign_dealer"),
    "上市投信": ("LISTED", "trust"),
    "上市自營商(自行買賣)": ("LISTED", "dealer_self"),
    "上市自營商(避險)": ("LISTED", "dealer_hedge"),
    "上市自營商合計": ("LISTED", "dealer_total"),
    "上櫃三大法人合計*": ("OTC", "total"),
    "上櫃外資及陸資(不含自營商)": ("OTC", "foreign"),
    "上櫃外資及陸資合計": ("OTC", "foreign_total"),
    "上櫃外資自營商": ("OTC", "foreign_dealer"),
    "上櫃投信": ("OTC", "trust"),
    "上櫃自營商(自行買賣)": ("OTC", "dealer_self"),
    "上櫃自營商(避險)": ("OTC", "dealer_hedge"),
    "上櫃自營商合計": ("OTC", "dealer_total"),
}


def build_institutional_amount_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    fields = ["buy_amount", "sell_amount", "net_amount"]
    df = _join_wide_fields(artifact_root / "raw" / "institutional_amount_summary", fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    lineage = _lineage(run_id, "institutional_amount_summary", fields, artifact_root)
    rows: list[dict[str, Any]] = []
    for row in df.to_dicts():
        category = str(row.get("stock_id") or "").strip()
        mapped = INSTITUTIONAL_AMOUNT_CATEGORY_MAP.get(category)
        if mapped is None:
            continue
        market_segment, investor = mapped
        rows.append({
            "date": str(row.get("date"))[:10],
            "market_segment": market_segment,
            "investor": investor,
            "category": category,
            "buy_amount": row.get("buy_amount"),
            "sell_amount": row.get("sell_amount"),
            "net_amount": row.get("net_amount"),
            "source": "finlab.institutional_investors_trading_all_market_summary",
            "lineage_json": lineage,
            "as_of_date": generated_at[:10],
        })
    return rows[:limit] if limit and limit > 0 else rows


def build_emerging_broker_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    lane = "emerging_chip_diversity"
    broker = _read_parquet(artifact_root / "raw" / lane / "rotc_broker_daily.parquet")
    if broker.is_empty():
        return [], []
    broker = _filter_dates(broker, start_date=start_date, end_date=end_date)
    if broker.is_empty():
        return [], []

    close = _wide_field_to_long(
        artifact_root / "raw" / "emerging_price_diversity" / "close.parquet",
        "close",
        start_date=start_date,
        end_date=end_date,
    )
    net_source = "dominant_net_shares" if "dominant_net_shares" in broker.columns else "buy_sell_net"
    gross_source = "gross_imbalance_shares" if "gross_imbalance_shares" in broker.columns else None
    broker = broker.with_columns(
        pl.col("stock_id").map_elements(normalize_symbol, return_dtype=pl.Utf8).alias("stock_id"),
        _date_expr("date").alias("date"),
        pl.col("buy_shares").cast(pl.Float64, strict=False),
        pl.col("sell_shares").cast(pl.Float64, strict=False),
        pl.col(net_source).cast(pl.Float64, strict=False).alias("net_shares"),
        pl.col(net_source).cast(pl.Float64, strict=False).alias("dominant_net_shares"),
        (
            pl.col(gross_source).cast(pl.Float64, strict=False)
            if gross_source
            else (pl.col("buy_shares").cast(pl.Float64, strict=False).fill_null(0) + pl.col("sell_shares").cast(pl.Float64, strict=False).fill_null(0))
        ).alias("gross_imbalance_shares"),
        pl.col("broker_count").cast(pl.Int64, strict=False),
    )
    if not close.is_empty():
        broker = broker.join(close.select(["stock_id", "date", "close"]), on=["stock_id", "date"], how="left")
    else:
        broker = broker.with_columns(pl.lit(None).cast(pl.Float64).alias("close"))
    lineage = _lineage(
        run_id,
        lane,
        ["buy_shares", "sell_shares", "net_shares", "dominant_net_shares", "gross_imbalance_shares", "broker_count"],
        artifact_root,
    )
    broker = broker.with_columns(
        (pl.col("net_shares") * pl.col("close")).alias("estimated_amount"),
        (
            pl.col("net_shares").abs()
            / (pl.col("buy_shares").fill_null(0).abs() + pl.col("sell_shares").fill_null(0).abs()).clip(1, None)
        ).alias("concentration"),
        pl.lit("EMERGING").alias("market_segment"),
        pl.lit("finlab.rotc_broker_transactions").alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    )

    broker_flow = broker.select([
        "stock_id",
        "date",
        "market_segment",
        "buy_shares",
        "sell_shares",
        "net_shares",
        "dominant_net_shares",
        "gross_imbalance_shares",
        "estimated_amount",
        "broker_count",
        "concentration",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    chip = broker.with_columns(
        pl.lit(None).cast(pl.Float64).alias("foreign_net"),
        pl.lit(None).cast(pl.Float64).alias("trust_net"),
        pl.col("net_shares").alias("dealer_net"),
        pl.lit(None).cast(pl.Float64).alias("margin_balance"),
        pl.lit(None).cast(pl.Float64).alias("short_balance"),
    ).select([
        "stock_id",
        "date",
        "market_segment",
        "foreign_net",
        "trust_net",
        "dealer_net",
        "margin_balance",
        "short_balance",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(chip, limit), _rows(broker_flow, limit)


def build_revenue_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    lane: str,
    market_segment: str,
    source: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    fields = ["revenue", "mom", "yoy"]
    df = _join_wide_fields(artifact_root / "raw" / lane, fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    lineage = _lineage(run_id, lane, fields, artifact_root)
    df = df.with_columns(
        pl.col("date").alias("revenue_month"),
        pl.lit(market_segment).alias("market_segment"),
        pl.lit(source).alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).select([
        "stock_id",
        "revenue_month",
        "market_segment",
        "revenue",
        "mom",
        "yoy",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(df, limit)


def _parse_category_list(value: Any) -> list[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    try:
        parsed = ast.literal_eval(raw)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
    except Exception:
        pass
    return [raw]


def build_taxonomy_rows(
    artifact_root: Path,
    *,
    generated_at: str,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    security_master = _read_parquet(artifact_root / "raw" / "security_master" / "table.parquet")
    if not security_master.is_empty():
        for row in _rows(security_master):
            symbol = normalize_symbol(row.get("stock_id") or row.get("symbol"))
            category = str(row.get("category") or "").strip()
            if symbol and category:
                rows.append({
                    "symbol": symbol,
                    "tag": category,
                    "tag_type": "industry",
                    "source": "finlab.security_categories",
                    "weight": 1,
                    "lineage_json": _json({"dataset_lane": "security_master", "market": row.get("market")}),
                    "as_of_date": generated_at[:10],
                })

    taxonomy = _read_parquet(artifact_root / "raw" / "taxonomy_expansion" / "table.parquet")
    if not taxonomy.is_empty():
        for row in _rows(taxonomy):
            symbol = normalize_symbol(row.get("stock_id") or row.get("symbol"))
            if not symbol:
                continue
            for tag in _parse_category_list(row.get("category")):
                if ":" in tag:
                    parent, child = [part.strip() for part in tag.split(":", 1)]
                    if parent:
                        rows.append({
                            "symbol": symbol,
                            "tag": parent,
                            "tag_type": "industry_theme",
                            "source": "finlab.security_industry_themes",
                            "weight": 0.9,
                            "lineage_json": _json({"dataset_lane": "taxonomy_expansion", "raw_tag": tag}),
                            "as_of_date": generated_at[:10],
                        })
                    if child:
                        rows.append({
                            "symbol": symbol,
                            "tag": child,
                            "tag_type": "subindustry",
                            "source": "finlab.security_industry_themes",
                            "weight": 0.8,
                            "lineage_json": _json({"dataset_lane": "taxonomy_expansion", "raw_tag": tag, "parent": parent}),
                            "as_of_date": generated_at[:10],
                        })
                else:
                    rows.append({
                        "symbol": symbol,
                        "tag": tag,
                        "tag_type": "industry_theme",
                        "source": "finlab.security_industry_themes",
                        "weight": 0.85,
                        "lineage_json": _json({"dataset_lane": "taxonomy_expansion", "raw_tag": tag}),
                        "as_of_date": generated_at[:10],
                    })

    deduped: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row["symbol"], row["tag"], row["tag_type"], row["source"])
        deduped[key] = row
    output = list(deduped.values())
    return output[:limit] if limit and limit > 0 else output


def build_inventory_rows(outputs: dict[str, list[dict[str, Any]]], *, generated_at: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for dataset, data_rows in outputs.items():
        if not data_rows:
            rows.append({
                "source": "finlab",
                "dataset": dataset,
                "field": "__dataset__",
                "stock_id": None,
                "market_segment": None,
                "date": None,
                "as_of_date": generated_at[:10],
                "coverage_status": "empty",
                "freshness_status": "missing",
                "lineage_json": _json({"row_count": 0}),
            })
            continue
        sample = data_rows[0]
        for field in sample.keys():
            if field in {"lineage_json"}:
                continue
            rows.append({
                "source": "finlab",
                "dataset": dataset,
                "field": field,
                "stock_id": None,
                "market_segment": None,
                "date": None,
                "as_of_date": generated_at[:10],
                "coverage_status": "materialized",
                "freshness_status": "ok",
                "lineage_json": _json({"row_count": len(data_rows), "field": field}),
            })
    return rows


def build_quality_rows(outputs: dict[str, list[dict[str, Any]]], *, generated_at: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for dataset, data_rows in outputs.items():
        rows.append({
            "source": "finlab",
            "dataset": dataset,
            "as_of_date": generated_at[:10],
            "freshness_status": "ok" if data_rows else "missing",
            "missing_rate": 0 if data_rows else 1,
            "duplicate_rate": 0,
            "schema_drift_status": "ok",
            "entity_link_confidence": 0.95,
            "latest_materialization": generated_at,
            "metrics_json": _json({"row_count": len(data_rows), "schema_version": SCHEMA_VERSION}),
        })
    return rows


def materialize_finlab_canonical_outputs(
    artifact_root: str | Path,
    *,
    run_id: str | None = None,
    start_date: str | None = None,
    end_date: str | None = None,
    limit_per_dataset: int | None = None,
    generated_at: str | None = None,
    datasets: Iterable[str] | None = None,
) -> FinLabCanonicalOutputs:
    root = Path(artifact_root)
    timestamp = generated_at or utc_now()
    rid = run_id or root.name
    dataset_filter = {str(name).strip() for name in datasets or [] if str(name).strip()}

    def wants(name: str) -> bool:
        return not dataset_filter or name in dataset_filter

    listed_market = build_market_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        lane="daily_price",
        market_segment="LISTED_OTC",
        source="finlab.price",
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_market_daily") else []
    emerging_market = build_market_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        lane="emerging_price_diversity",
        market_segment="EMERGING",
        source="finlab.rotc_price",
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_market_daily") else []
    listed_chip = build_chip_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_chip_daily") else []
    institutional_amounts = build_institutional_amount_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_institutional_amount_daily") else []
    if wants("canonical_chip_daily") or wants("canonical_broker_flow_daily"):
        emerging_chip, broker_flow = build_emerging_broker_rows(
            root,
            run_id=rid,
            generated_at=timestamp,
            start_date=start_date,
            end_date=end_date,
            limit=limit_per_dataset,
        )
        if not wants("canonical_chip_daily"):
            emerging_chip = []
        if not wants("canonical_broker_flow_daily"):
            broker_flow = []
    else:
        emerging_chip, broker_flow = [], []
    listed_revenue = build_revenue_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        lane="revenue",
        market_segment="LISTED_OTC",
        source="finlab.monthly_revenue",
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_revenue_monthly") else []
    emerging_revenue = build_revenue_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        lane="emerging_revenue_diversity",
        market_segment="EMERGING",
        source="finlab.rotc_monthly_revenue",
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_revenue_monthly") else []
    taxonomy = build_taxonomy_rows(root, generated_at=timestamp, limit=limit_per_dataset) if wants("finlab_taxonomy_tags") else []

    output_rows: dict[str, list[dict[str, Any]]] = {}
    if wants("canonical_market_daily"):
        output_rows["canonical_market_daily"] = listed_market + emerging_market
    if wants("canonical_chip_daily"):
        output_rows["canonical_chip_daily"] = listed_chip + emerging_chip
    if wants("canonical_institutional_amount_daily"):
        output_rows["canonical_institutional_amount_daily"] = institutional_amounts
    if wants("canonical_revenue_monthly"):
        output_rows["canonical_revenue_monthly"] = listed_revenue + emerging_revenue
    if wants("canonical_broker_flow_daily"):
        output_rows["canonical_broker_flow_daily"] = broker_flow
    if wants("finlab_taxonomy_tags"):
        output_rows["finlab_taxonomy_tags"] = taxonomy
    inventory = build_inventory_rows(output_rows, generated_at=timestamp)
    quality = build_quality_rows(output_rows, generated_at=timestamp)
    row_counts = {name: len(rows) for name, rows in output_rows.items()}
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "run_id": rid,
        "generated_at": timestamp,
        "artifact_root": str(root),
        "filters": {
            "start_date": start_date,
            "end_date": end_date,
            "limit_per_dataset": limit_per_dataset,
            "datasets": sorted(dataset_filter) if dataset_filter else None,
        },
        "row_counts": row_counts,
    }
    manifest["checksum"] = sha256_json(manifest)
    return FinLabCanonicalOutputs(
        run_id=rid,
        generated_at=timestamp,
        artifact_root=str(root),
        canonical_market_daily=output_rows.get("canonical_market_daily", []),
        canonical_chip_daily=output_rows.get("canonical_chip_daily", []),
        canonical_institutional_amount_daily=output_rows.get("canonical_institutional_amount_daily", []),
        canonical_revenue_monthly=output_rows.get("canonical_revenue_monthly", []),
        canonical_broker_flow_daily=output_rows.get("canonical_broker_flow_daily", []),
        finlab_taxonomy_tags=output_rows.get("finlab_taxonomy_tags", []),
        data_source_inventory=inventory,
        source_quality_metrics=quality,
        manifest=manifest,
    )


def _upsert_statement(
    table: str,
    columns: list[str],
    conflict_columns: list[str],
    update_columns: list[str],
) -> str:
    placeholders = ", ".join("?" for _ in columns)
    column_sql = ", ".join(columns)
    conflict_sql = ", ".join(conflict_columns)
    update_sql = ", ".join(f"{column}=excluded.{column}" for column in update_columns)
    return (
        f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders}) "
        f"ON CONFLICT({conflict_sql}) DO UPDATE SET {update_sql}"
    )


def _row_statements(
    table: str,
    rows: list[dict[str, Any]],
    columns: list[str],
    conflict_columns: list[str],
    update_columns: list[str],
) -> list[tuple[str, list[Any]]]:
    sql = _upsert_statement(table, columns, conflict_columns, update_columns)
    return [(sql, [row.get(column) for column in columns]) for row in rows]


def build_d1_upsert_statements(outputs: FinLabCanonicalOutputs) -> list[tuple[str, list[Any]]]:
    """Build D1 upsert statements for row-level FinLab canonical materialization.

    This is intentionally separate from materialization so local smoke tests can
    validate output without remote writes. Production CPD should call it only
    through an explicit apply step.
    """
    statements: list[tuple[str, list[Any]]] = []
    statements.extend(_row_statements(
        "canonical_market_daily",
        outputs.canonical_market_daily,
        ["stock_id", "date", "market_segment", "open", "high", "low", "close", "volume", "value", "source", "lineage_json", "as_of_date"],
        ["stock_id", "date", "source"],
        ["market_segment", "open", "high", "low", "close", "volume", "value", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_chip_daily",
        outputs.canonical_chip_daily,
        ["stock_id", "date", "market_segment", "foreign_net", "trust_net", "dealer_net", "margin_balance", "short_balance", "source", "lineage_json", "as_of_date"],
        ["stock_id", "date", "source"],
        ["market_segment", "foreign_net", "trust_net", "dealer_net", "margin_balance", "short_balance", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_institutional_amount_daily",
        outputs.canonical_institutional_amount_daily,
        ["date", "market_segment", "investor", "category", "buy_amount", "sell_amount", "net_amount", "source", "lineage_json", "as_of_date"],
        ["date", "market_segment", "investor", "source"],
        ["category", "buy_amount", "sell_amount", "net_amount", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_revenue_monthly",
        outputs.canonical_revenue_monthly,
        ["stock_id", "revenue_month", "market_segment", "revenue", "mom", "yoy", "source", "lineage_json", "as_of_date"],
        ["stock_id", "revenue_month", "source"],
        ["market_segment", "revenue", "mom", "yoy", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_broker_flow_daily",
        outputs.canonical_broker_flow_daily,
        ["stock_id", "date", "market_segment", "buy_shares", "sell_shares", "net_shares", "dominant_net_shares", "gross_imbalance_shares", "estimated_amount", "broker_count", "concentration", "source", "lineage_json", "as_of_date"],
        ["stock_id", "date", "source"],
        ["market_segment", "buy_shares", "sell_shares", "net_shares", "dominant_net_shares", "gross_imbalance_shares", "estimated_amount", "broker_count", "concentration", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "finlab_taxonomy_tags",
        outputs.finlab_taxonomy_tags,
        ["symbol", "tag", "tag_type", "source", "weight", "lineage_json", "as_of_date"],
        ["symbol", "tag", "tag_type", "source"],
        ["weight", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "data_source_inventory",
        outputs.data_source_inventory,
        ["source", "dataset", "field", "stock_id", "market_segment", "date", "as_of_date", "coverage_status", "freshness_status", "lineage_json"],
        ["source", "dataset", "field", "stock_id", "market_segment", "as_of_date"],
        ["date", "coverage_status", "freshness_status", "lineage_json"],
    ))
    statements.extend(_row_statements(
        "source_quality_metrics",
        outputs.source_quality_metrics,
        ["source", "dataset", "as_of_date", "freshness_status", "missing_rate", "duplicate_rate", "schema_drift_status", "entity_link_confidence", "latest_materialization", "metrics_json"],
        ["source", "dataset", "as_of_date"],
        ["freshness_status", "missing_rate", "duplicate_rate", "schema_drift_status", "entity_link_confidence", "latest_materialization", "metrics_json"],
    ))
    manifest_sql = _upsert_statement(
        "finlab_materialization_manifest",
        ["run_id", "generated_at", "source_run_id", "artifact_root", "row_counts_json", "freshness_json", "checksum", "status"],
        ["run_id"],
        ["generated_at", "source_run_id", "artifact_root", "row_counts_json", "freshness_json", "checksum", "status"],
    )
    statements.append((
        manifest_sql,
        [
            outputs.run_id,
            outputs.generated_at,
            outputs.run_id,
            outputs.artifact_root,
            _json(outputs.manifest.get("row_counts", {})),
            _json({"as_of_date": outputs.generated_at[:10], "filters": outputs.manifest.get("filters", {})}),
            outputs.manifest.get("checksum"),
            "ready",
        ],
    ))
    return statements
