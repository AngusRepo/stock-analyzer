from __future__ import annotations

import ast
import hashlib
import json
import math
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
    canonical_market_index_daily: list[dict[str, Any]]
    canonical_futures_daily: list[dict[str, Any]]
    canonical_market_summary_daily: list[dict[str, Any]]
    canonical_regime_context_daily: list[dict[str, Any]]
    canonical_revenue_monthly: list[dict[str, Any]]
    canonical_fundamental_features: list[dict[str, Any]]
    canonical_broker_flow_daily: list[dict[str, Any]]
    canonical_broker_rank_daily: list[dict[str, Any]]
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


def _shift_start_date(start_date: str | None, lookback_days: int | None) -> str | None:
    if not start_date or not lookback_days or lookback_days <= 0:
        return start_date
    try:
        parsed = datetime.fromisoformat(start_date[:10]).date()
    except ValueError:
        return start_date
    return (parsed - timedelta(days=lookback_days)).isoformat()


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


def _join_wide_fields_asof_snapshot(
    lane_dir: Path,
    fields: Iterable[str],
    *,
    end_date: str,
) -> pl.DataFrame:
    joined: pl.DataFrame | None = None
    for field in fields:
        frame = _wide_field_to_long(lane_dir / f"{field}.parquet", field, start_date=None, end_date=end_date)
        if frame.is_empty():
            continue
        latest = (
            frame
            .sort(["stock_id", "date"])
            .group_by("stock_id", maintain_order=True)
            .agg([
                pl.col(field).last().alias(field),
                pl.col("date").last().alias(f"{field}__date"),
            ])
        )
        joined = latest if joined is None else joined.join(latest, on="stock_id", how="full", coalesce=True)
    return joined if joined is not None else pl.DataFrame()


def _wide_market_field_to_long(path: Path, field: str, *, start_date: str | None, end_date: str | None) -> pl.DataFrame:
    df = _read_parquet(path)
    if df.is_empty() or "date" not in df.columns:
        return pl.DataFrame({"date": [], "category": [], field: []})
    df = _filter_dates(df, start_date=start_date, end_date=end_date)
    value_columns = [col for col in df.columns if col != "date"]
    if not value_columns:
        return pl.DataFrame({"date": [], "category": [], field: []})
    return (
        df.unpivot(index="date", on=value_columns, variable_name="category", value_name=field)
        .filter(pl.col(field).is_not_null())
        .with_columns(
            _date_expr("date").alias("date"),
            pl.col("category").cast(pl.Utf8),
            pl.col(field).cast(pl.Float64, strict=False),
        )
    )


def _join_market_fields(
    lane_dir: Path,
    fields: Iterable[str],
    *,
    start_date: str | None,
    end_date: str | None,
) -> pl.DataFrame:
    joined: pl.DataFrame | None = None
    for field in fields:
        frame = _wide_market_field_to_long(lane_dir / f"{field}.parquet", field, start_date=start_date, end_date=end_date)
        if frame.is_empty():
            continue
        joined = frame if joined is None else joined.join(frame, on=["date", "category"], how="full", coalesce=True)
    return joined if joined is not None else pl.DataFrame()


def _rows(df: pl.DataFrame, limit: int | None = None) -> list[dict[str, Any]]:
    if df.is_empty():
        return []
    if limit and limit > 0:
        df = df.head(limit)
    return df.to_dicts()


def _coerce_number(value: Any) -> float | None:
    if value is None:
        return None
    try:
        parsed = float(str(value).replace(",", "").replace("%", "").strip())
    except Exception:
        return None
    return parsed if parsed == parsed else None


def _clean_text(value: Any) -> str | None:
    text = str(value or "").strip()
    return text or None


def _first_row_value(row: dict[str, Any], names: Iterable[str]) -> Any:
    match = _first_row_match(row, names)
    return match[1] if match else None


def _first_row_match(row: dict[str, Any], names: Iterable[str]) -> tuple[str, Any] | None:
    lowered = {str(key).strip().lower(): value for key, value in row.items()}
    for name in names:
        key = name.strip().lower()
        if key in lowered:
            return key, lowered[key]
    return None


def _date_value(row: dict[str, Any]) -> str:
    raw = _first_row_value(row, ["date", "trading_date", "data_date", "__index_level_0__", "年月", "月份", "日期"])
    return str(raw or "")[:10]


def _table_has_any(df: pl.DataFrame, names: Iterable[str]) -> bool:
    lowered = {col.lower() for col in df.columns}
    return any(name.lower() in lowered for name in names)


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
    fields = [
        "open",
        "high",
        "low",
        "close",
        "adj_open",
        "adj_high",
        "adj_low",
        "adj_close",
        "volume",
        "trade_count",
        "value",
        "avg_price",
        "last_bid_price",
        "last_ask_price",
        "last_bid_volume",
        "last_ask_volume",
        "market_value",
    ]
    df = _join_wide_fields(artifact_root / "raw" / lane, fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    missing_fields = [field for field in fields if field not in df.columns]
    if missing_fields:
        df = df.with_columns([pl.lit(None, dtype=pl.Float64).alias(field) for field in missing_fields])
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
        "adj_open",
        "adj_high",
        "adj_low",
        "adj_close",
        "volume",
        "trade_count",
        "value",
        "avg_price",
        "last_bid_price",
        "last_ask_price",
        "last_bid_volume",
        "last_ask_volume",
        "market_value",
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
    fields = [
        "foreign_net",
        "foreign_buy",
        "foreign_sell",
        "foreign_dealer_buy",
        "foreign_dealer_sell",
        "foreign_dealer_net",
        "trust_buy",
        "trust_sell",
        "trust_net",
        "dealer_self_buy",
        "dealer_self_sell",
        "dealer_self_net",
        "dealer_hedge_buy",
        "dealer_hedge_sell",
        "dealer_hedge_net",
        "margin_buy",
        "margin_sell",
        "margin_cash_repayment",
        "margin_prev_balance",
        "margin_balance",
        "margin_limit",
        "short_buy",
        "short_sell",
        "short_stock_repayment",
        "short_prev_balance",
        "short_balance",
        "short_limit",
        "margin_short_offset",
        "margin_usage_ratio",
        "short_usage_ratio",
        "margin_balance_total_buy",
        "margin_balance_total_sell",
        "margin_balance_total_repayment",
        "margin_balance_total_balance",
        "security_lending_prev_balance",
        "security_lending_borrow",
        "security_lending_return",
        "security_lending_delta",
        "security_lending_balance",
        "security_lending_sell",
        "security_lending_sell_return",
        "security_lending_sell_balance",
        "security_lending_sell_limit",
        "broker_top15_buy",
        "broker_top15_sell",
        "broker_buy_sell_ratio",
        "broker_balance_index",
    ]
    df = _join_wide_fields(artifact_root / "raw" / "chip_diversity", fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    missing_fields = [field for field in fields if field not in df.columns]
    if missing_fields:
        df = df.with_columns([pl.lit(None, dtype=pl.Float64).alias(field) for field in missing_fields])
    lineage = _lineage(run_id, "chip_diversity", fields, artifact_root)
    df = df.with_columns(
        (pl.col("dealer_self_net").fill_null(0) + pl.col("dealer_hedge_net").fill_null(0)).alias("dealer_net"),
        pl.when(pl.any_horizontal([pl.col("dealer_self_buy").is_not_null(), pl.col("dealer_hedge_buy").is_not_null()]))
        .then(pl.col("dealer_self_buy").fill_null(0) + pl.col("dealer_hedge_buy").fill_null(0))
        .otherwise(None)
        .alias("dealer_buy"),
        pl.when(pl.any_horizontal([pl.col("dealer_self_sell").is_not_null(), pl.col("dealer_hedge_sell").is_not_null()]))
        .then(pl.col("dealer_self_sell").fill_null(0) + pl.col("dealer_hedge_sell").fill_null(0))
        .otherwise(None)
        .alias("dealer_sell"),
        pl.lit("LISTED_OTC").alias("market_segment"),
        pl.lit("finlab.institutional_investors_trading_summary").alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).select([
        "stock_id",
        "date",
        "market_segment",
        "foreign_buy",
        "foreign_sell",
        "foreign_net",
        "foreign_dealer_buy",
        "foreign_dealer_sell",
        "foreign_dealer_net",
        "trust_buy",
        "trust_sell",
        "trust_net",
        "dealer_buy",
        "dealer_sell",
        "dealer_net",
        "dealer_self_buy",
        "dealer_self_sell",
        "dealer_hedge_buy",
        "dealer_hedge_sell",
        "margin_buy",
        "margin_sell",
        "margin_cash_repayment",
        "margin_prev_balance",
        "margin_balance",
        "margin_limit",
        "short_buy",
        "short_sell",
        "short_stock_repayment",
        "short_prev_balance",
        "short_balance",
        "short_limit",
        "margin_short_offset",
        "margin_usage_ratio",
        "short_usage_ratio",
        "margin_balance_total_buy",
        "margin_balance_total_sell",
        "margin_balance_total_repayment",
        "margin_balance_total_balance",
        "security_lending_prev_balance",
        "security_lending_borrow",
        "security_lending_return",
        "security_lending_delta",
        "security_lending_balance",
        "security_lending_sell",
        "security_lending_sell_return",
        "security_lending_sell_balance",
        "security_lending_sell_limit",
        "broker_top15_buy",
        "broker_top15_sell",
        "broker_buy_sell_ratio",
        "broker_balance_index",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(df, limit)


def _institutional_market_segment(category: Any) -> str:
    text = str(category or "")
    if "上櫃" in text:
        return "OTC"
    if "上市" in text:
        return "LISTED"
    return "LISTED_OTC"


def _institutional_investor(category: Any) -> str:
    text = str(category or "")
    if "外資及陸資合計" in text or "外陸資合計" in text:
        return "foreign_total"
    if "不含外資自營商" in text or "不含自營商" in text:
        return "foreign"
    if "外資自營商" in text:
        return "foreign_dealer"
    if "外資" in text or "外陸資" in text:
        return "foreign"
    if "投信" in text:
        return "trust"
    if "自營商合計" in text:
        return "dealer_total"
    if "自行買賣" in text:
        return "dealer_self"
    if "避險" in text:
        return "dealer_hedge"
    if "合計" in text or "三大法人" in text:
        return "total"
    return normalize_symbol(text).lower() or "unknown"


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
    df = _join_market_fields(artifact_root / "raw" / "institutional_amount_summary", fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    lineage = _lineage(run_id, "institutional_amount_summary", fields, artifact_root)
    df = df.with_columns(
        pl.col("category").map_elements(_institutional_market_segment, return_dtype=pl.Utf8).alias("market_segment"),
        pl.col("category").map_elements(_institutional_investor, return_dtype=pl.Utf8).alias("investor"),
        pl.col("buy_amount").cast(pl.Float64, strict=False),
        pl.col("sell_amount").cast(pl.Float64, strict=False),
        pl.col("net_amount").cast(pl.Float64, strict=False),
    ).with_columns(
        pl.when(pl.col("net_amount").is_null())
        .then(pl.col("buy_amount").fill_null(0) - pl.col("sell_amount").fill_null(0))
        .otherwise(pl.col("net_amount"))
        .alias("net_amount"),
        pl.lit("finlab.institutional_investors_trading_all_market_summary").alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).select([
        "date",
        "market_segment",
        "investor",
        "category",
        "buy_amount",
        "sell_amount",
        "net_amount",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(df, limit)


def _market_index_symbol(value: Any, *, fallback: str = "") -> str:
    text = str(value or "").strip()
    upper = text.upper()
    if "TWOII" in upper or "TPEX" in upper or "OTC" in upper or "櫃買" in text or "上櫃" in text:
        return "TWOII"
    if "TWII" in upper or "TAIEX" in upper or "加權" in text or "發行量加權" in text:
        return "TWII"
    return fallback or normalize_symbol(text) or upper


def _market_index_symbol_from_wide_column(column: Any, *, default_symbol: str = "") -> str:
    text = str(column or "").strip()
    upper = text.upper()
    symbol = _market_index_symbol(text, fallback="")
    if symbol in {"TWII", "TWOII"}:
        return symbol
    if upper in {"CLOSE", "PRICE", "VALUE"} and default_symbol:
        return default_symbol
    return ""


def _market_index_rows_from_frame(
    frame: pl.DataFrame,
    *,
    run_id: str,
    generated_at: str,
    artifact_root: Path,
    lane: str,
    source: str,
    default_symbol: str = "",
    default_name: str = "",
    start_date: str | None,
    end_date: str | None,
) -> list[dict[str, Any]]:
    frame = _filter_dates(frame, start_date=start_date, end_date=end_date) if "date" in frame.columns else frame
    if frame.is_empty():
        return []
    lineage = _lineage(run_id, lane, list(frame.columns), artifact_root)
    rows: list[dict[str, Any]] = []
    close_candidates = ["close", "收盤價", "指數", "value", "price", "發行量加權股價報酬指數"]
    table_like = _table_has_any(frame, close_candidates) and (
        _table_has_any(frame, ["symbol", "stock_id", "index_code", "代號", "name", "指數名稱"]) or len(frame.columns) > 3
    )

    if table_like:
        for row in _rows(frame):
            date = _date_value(row)
            if not date:
                continue
            raw_symbol = _first_row_value(row, ["symbol", "stock_id", "index_code", "代號", "name", "指數名稱"])
            close = _coerce_number(_first_row_value(row, close_candidates))
            if close is None:
                continue
            symbol = _market_index_symbol(raw_symbol, fallback=default_symbol)
            rows.append({
                "symbol": symbol,
                "date": date,
                "name": _clean_text(_first_row_value(row, ["name", "指數名稱"])) or default_name or symbol,
                "market_segment": "OTC" if symbol == "TWOII" else "LISTED",
                "open": _coerce_number(_first_row_value(row, ["open", "開盤價"])),
                "high": _coerce_number(_first_row_value(row, ["high", "最高價"])),
                "low": _coerce_number(_first_row_value(row, ["low", "最低價"])),
                "close": close,
                "change": _coerce_number(_first_row_value(row, ["change", "漲跌價", "漲跌點"])),
                "change_pct": _coerce_number(_first_row_value(row, ["change_pct", "漲跌幅"])),
                "volume": _coerce_number(_first_row_value(row, ["volume", "成交量"])),
                "value": _coerce_number(_first_row_value(row, ["value", "成交值", "成交金額"])),
                "source": source,
                "lineage_json": lineage,
                "as_of_date": generated_at[:10],
            })
        return rows

    date_columns = {"date", "trading_date", "data_date", "__index_level_0__"}
    for row in _rows(frame):
        date = _date_value(row)
        if not date:
            continue
        for column, value in row.items():
            if str(column).strip() in date_columns:
                continue
            close = _coerce_number(value)
            if close is None:
                continue
            symbol = _market_index_symbol_from_wide_column(column, default_symbol=default_symbol)
            if not symbol:
                continue
            rows.append({
                "symbol": symbol,
                "date": date,
                "name": default_name or str(column),
                "market_segment": "OTC" if symbol == "TWOII" else "LISTED",
                "open": None,
                "high": None,
                "low": None,
                "close": close,
                "change": None,
                "change_pct": None,
                "volume": None,
                "value": None,
                "source": source,
                "lineage_json": lineage,
                "as_of_date": generated_at[:10],
            })
    return rows


def _taiex_total_index_field(
    regime_dir: Path,
    filename: str,
    field: str,
    *,
    start_date: str | None,
    end_date: str | None,
) -> pl.DataFrame:
    frame = _read_parquet(regime_dir / f"{filename}.parquet")
    if frame.is_empty():
        return pl.DataFrame({"date": [], field: []})
    if "date" not in frame.columns:
        if "__index_level_0__" in frame.columns:
            frame = frame.rename({"__index_level_0__": "date"})
        else:
            return pl.DataFrame({"date": [], field: []})
    frame = _filter_dates(frame, start_date=start_date, end_date=end_date)
    value_columns = [col for col in frame.columns if col not in {"date", "__index_level_0__"}]
    if not value_columns:
        return pl.DataFrame({"date": [], field: []})
    value_column = "TAIEX" if "TAIEX" in value_columns else value_columns[0]
    return (
        frame
        .select([
            _date_expr("date").alias("date"),
            pl.col(value_column).cast(pl.Float64, strict=False).alias(field),
        ])
        .filter(pl.col(field).is_not_null())
    )


def _taiex_total_index_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
) -> list[dict[str, Any]]:
    regime_dir = artifact_root / "raw" / "regime_context"
    field_files = {
        "open": "taiex_open",
        "high": "taiex_high",
        "low": "taiex_low",
        "close": "taiex_close",
    }
    joined: pl.DataFrame | None = None
    lineage_fields: list[str] = []
    for field, filename in field_files.items():
        frame = _taiex_total_index_field(
            regime_dir,
            filename,
            field,
            start_date=start_date,
            end_date=end_date,
        )
        if frame.is_empty():
            continue
        lineage_fields.append(filename)
        joined = frame if joined is None else joined.join(frame, on="date", how="full", coalesce=True)
    if joined is None or joined.is_empty() or "close" not in joined.columns:
        return []

    lineage = _lineage(run_id, "regime_context", lineage_fields, artifact_root)
    rows: list[dict[str, Any]] = []
    for row in _rows(joined.sort("date")):
        close = _coerce_number(row.get("close"))
        if close is None:
            continue
        rows.append({
            "symbol": "TWII",
            "date": row["date"],
            "name": "發行量加權股價指數",
            "market_segment": "LISTED",
            "open": _coerce_number(row.get("open")),
            "high": _coerce_number(row.get("high")),
            "low": _coerce_number(row.get("low")),
            "close": close,
            "change": None,
            "change_pct": None,
            "volume": None,
            "value": None,
            "source": "finlab.taiex_total_index",
            "lineage_json": lineage,
            "as_of_date": generated_at[:10],
        })
    return rows


def build_market_index_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    regime_dir = artifact_root / "raw" / "regime_context"
    rows.extend(_taiex_total_index_rows(
        artifact_root,
        run_id=run_id,
        generated_at=generated_at,
        start_date=start_date,
        end_date=end_date,
    ))

    official_twse = _read_parquet(regime_dir / "official_twse_index.parquet")
    if not official_twse.is_empty():
        rows.extend(_market_index_rows_from_frame(
            official_twse,
            run_id=run_id,
            generated_at=generated_at,
            artifact_root=artifact_root,
            lane="regime_context",
            source="twse.mi_5mins_hist.official",
            default_symbol="TWII",
            default_name="發行量加權股價指數",
            start_date=start_date,
            end_date=end_date,
        ))

    market_ind = _read_parquet(regime_dir / "tw_stock_market_ind.parquet")
    if not market_ind.is_empty():
        rows.extend(_market_index_rows_from_frame(
            market_ind,
            run_id=run_id,
            generated_at=generated_at,
            artifact_root=artifact_root,
            lane="regime_context",
            source="finlab.etl.finlab_tw_stock_market_ind",
            default_symbol="TWII",
            start_date=start_date,
            end_date=end_date,
        ))

    official_tpex = _read_parquet(regime_dir / "official_tpex_index.parquet")
    if not official_tpex.is_empty():
        rows.extend(_market_index_rows_from_frame(
            official_tpex,
            run_id=run_id,
            generated_at=generated_at,
            artifact_root=artifact_root,
            lane="regime_context",
            source="tpex.openapi.tpex_index",
            default_symbol="TWOII",
            default_name="櫃買指數",
            start_date=start_date,
            end_date=end_date,
        ))

    benchmark = _read_parquet(regime_dir / "benchmark_twii_return_index.parquet")
    if not benchmark.is_empty():
        benchmark_rows = _market_index_rows_from_frame(
            benchmark,
            run_id=run_id,
            generated_at=generated_at,
            artifact_root=artifact_root,
            lane="regime_context",
            source="finlab.benchmark_return",
            default_symbol="TWII_RETURN",
            default_name="發行量加權股價報酬指數",
            start_date=start_date,
            end_date=end_date,
        )
        for row in benchmark_rows:
            if row["symbol"] == "TWII":
                row["symbol"] = "TWII_RETURN"
            rows.append(row)

    def source_priority(row: dict[str, Any]) -> int:
        source = str(row.get("source") or "")
        if source == "finlab.taiex_total_index":
            return 0
        if source.startswith("finlab."):
            return 1
        return 2

    deduped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row["symbol"], row["date"])
        existing = deduped.get(key)
        if existing is None or source_priority(row) < source_priority(existing):
            deduped[key] = row
    output = list(deduped.values())
    return output[:limit] if limit and limit > 0 else output


def _wide_or_table_values(
    frame: pl.DataFrame,
    *,
    value_field: str,
    start_date: str | None,
    end_date: str | None,
) -> list[dict[str, Any]]:
    frame = _filter_dates(frame, start_date=start_date, end_date=end_date) if "date" in frame.columns else frame
    if frame.is_empty():
        return []
    rows: list[dict[str, Any]] = []
    value_candidates = [value_field, "value", "close", "收盤價", "ratio", "淨部位"]
    table_like = _table_has_any(frame, value_candidates) and len(frame.columns) > 2
    if table_like:
        for row in _rows(frame):
            date = _date_value(row)
            if not date:
                continue
            category = _clean_text(_first_row_value(row, ["symbol", "stock_id", "contract", "契約", "name", "商品", "category"])) or "market"
            rows.append({
                "date": date,
                "category": category,
                value_field: _first_row_value(row, value_candidates),
                "raw": row,
            })
        return rows

    date_columns = {"date", "trading_date", "data_date", "__index_level_0__"}
    for row in _rows(frame):
        date = _date_value(row)
        if not date:
            continue
        for column, value in row.items():
            if str(column).strip() in date_columns:
                continue
            rows.append({
                "date": date,
                "category": str(column),
                value_field: value,
                "raw": row,
            })
    return rows


def _futures_symbol(category: Any, contract_month: Any = None) -> str:
    text = f"{category or ''} {contract_month or ''}".strip()
    upper = text.upper()
    if "MTX" in upper or "小型" in text:
        return "MTX"
    if upper.startswith("TX") or "TXF" in upper or "臺股" in text or "台股" in text:
        return "TXF"
    return ""


def build_futures_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    lane = "regime_context"
    lane_dir = artifact_root / "raw" / lane
    field_map = {
        "contract_month": "futures_contract_month",
        "open": "futures_open",
        "high": "futures_high",
        "low": "futures_low",
        "close": "futures_close",
        "change": "futures_change",
        "change_pct": "futures_change_pct",
        "volume": "futures_volume",
        "open_interest": "futures_open_interest",
    }
    keyed: dict[tuple[str, str], dict[str, Any]] = {}
    for output_field, filename in field_map.items():
        frame = _read_parquet(lane_dir / f"{filename}.parquet")
        if frame.is_empty():
            continue
        for item in _wide_or_table_values(frame, value_field=output_field, start_date=start_date, end_date=end_date):
            key = (item["date"], item["category"])
            bucket = keyed.setdefault(key, {"date": item["date"], "category": item["category"]})
            bucket[output_field] = item.get(output_field)

    lineage = _lineage(run_id, lane, list(field_map.values()), artifact_root)
    rows: list[dict[str, Any]] = []
    for item in keyed.values():
        symbol = _futures_symbol(item.get("category"), item.get("contract_month"))
        if not symbol:
            continue
        category = str(item.get("category") or "")
        session = "night" if "盤後" in category else "day"
        rows.append({
            "symbol": symbol,
            "date": item["date"],
            "contract_month": _clean_text(item.get("contract_month")) or _clean_text(item.get("category")),
            "session": session,
            "open": _coerce_number(item.get("open")),
            "high": _coerce_number(item.get("high")),
            "low": _coerce_number(item.get("low")),
            "close": _coerce_number(item.get("close")),
            "change": _coerce_number(item.get("change")),
            "change_pct": _coerce_number(item.get("change_pct")),
            "volume": _coerce_number(item.get("volume")),
            "open_interest": _coerce_number(item.get("open_interest")),
            "source": "finlab.futures_price",
            "lineage_json": lineage,
            "as_of_date": generated_at[:10],
        })

    rows = [row for row in rows if row["close"] is not None]
    rows.sort(key=lambda row: (row["date"], row["symbol"], str(row.get("contract_month") or "")))
    deduped: dict[tuple[str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        deduped[(row["date"], row["symbol"], row["session"], row["source"])] = row
    output = list(deduped.values())
    return output[:limit] if limit and limit > 0 else output


def _context_rows_from_frame(
    frame: pl.DataFrame,
    *,
    run_id: str,
    generated_at: str,
    artifact_root: Path,
    lane: str,
    dataset: str,
    source: str,
    field_alias: str | None,
    start_date: str | None,
    end_date: str | None,
) -> list[dict[str, Any]]:
    frame = _filter_dates(frame, start_date=start_date, end_date=end_date) if "date" in frame.columns else frame
    if frame.is_empty():
        return []
    lineage = _lineage(run_id, lane, list(frame.columns), artifact_root)
    rows: list[dict[str, Any]] = []
    date_columns = {"date", "trading_date", "data_date", "__index_level_0__"}
    category_columns = {"symbol", "stock_id", "contract", "category", "name", "商品", "契約"}
    category_column_order = ["symbol", "stock_id", "contract", "category", "name"]
    expiry_columns = {"到期月份(週別)", "expiry", "contract_month", "month", "settlement_month"}
    large_trader_datasets = {"tw_taifex_futures_large_trader", "tw_taifex_option_large_trader"}
    table_like = len([col for col in frame.columns if col not in date_columns]) > 2 and _table_has_any(frame, category_columns | {"value", "ratio", "close"})

    for raw in _rows(frame):
        date = _date_value(raw)
        if not date:
            continue
        if table_like:
            category = _clean_text(_first_row_value(raw, category_column_order)) or "market"
            metadata_columns = {name.lower() for name in category_columns} | {name.lower() for name in date_columns}
            if dataset in large_trader_datasets:
                expiry = _clean_text(_first_row_value(raw, expiry_columns))
                if expiry:
                    category = f"{category} / {expiry}"
                metadata_columns.update(name.lower() for name in expiry_columns)
                metadata_columns.add("key_date")
            for column, value in raw.items():
                col = str(column).strip()
                if col.lower() in metadata_columns:
                    continue
                num = _coerce_number(value)
                text_value = None if num is not None else _clean_text(value)
                if num is None and text_value is None:
                    continue
                rows.append({
                    "date": date,
                    "dataset": dataset,
                    "field": field_alias or col,
                    "category": category,
                    "value": num,
                    "text_value": text_value,
                    "source": source,
                    "lineage_json": lineage,
                    "as_of_date": generated_at[:10],
                })
            continue

        value_columns = [col for col in raw.keys() if str(col).strip() not in date_columns]
        single_value = len(value_columns) == 1
        for column in value_columns:
            value = raw.get(column)
            num = _coerce_number(value)
            text_value = None if num is not None else _clean_text(value)
            if num is None and text_value is None:
                continue
            rows.append({
                "date": date,
                "dataset": dataset,
                "field": field_alias or str(column),
                "category": "market" if single_value else str(column),
                "value": num,
                "text_value": text_value,
                "source": source,
                "lineage_json": lineage,
                "as_of_date": generated_at[:10],
            })
    return rows


def build_regime_context_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    specs = [
        ("regime_context", "tw_business_indicators", "business_signal_score", "finlab.tw_business_indicators", "business_signal_score", 370),
        ("regime_context", "tw_option_put_call_ratio", None, "finlab.tw_option_put_call_ratio", "tw_option_put_call_ratio", None),
        ("regime_context", "tw_taifex_futures_large_trader", None, "finlab.tw_taifex_futures_large_trader", "tw_taifex_futures_large_trader", None),
        ("regime_context", "tw_taifex_option_large_trader", None, "finlab.tw_taifex_option_large_trader", "tw_taifex_option_large_trader", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_long_trade_lots", "finlab.futures_institutional_investors_trading_summary", "futures_inst_long_trade_lots", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_short_trade_lots", "finlab.futures_institutional_investors_trading_summary", "futures_inst_short_trade_lots", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_net_trade_lots", "finlab.futures_institutional_investors_trading_summary", "futures_inst_net_trade_lots", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_long_oi_lots", "finlab.futures_institutional_investors_trading_summary", "futures_inst_long_oi_lots", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_short_oi_lots", "finlab.futures_institutional_investors_trading_summary", "futures_inst_short_oi_lots", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_net_oi_lots", "finlab.futures_institutional_investors_trading_summary", "futures_inst_net_oi_lots", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_long_trade_amount_k", "finlab.futures_institutional_investors_trading_summary", "futures_inst_long_trade_amount_k", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_short_trade_amount_k", "finlab.futures_institutional_investors_trading_summary", "futures_inst_short_trade_amount_k", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_net_trade_amount_k", "finlab.futures_institutional_investors_trading_summary", "futures_inst_net_trade_amount_k", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_long_oi_amount_k", "finlab.futures_institutional_investors_trading_summary", "futures_inst_long_oi_amount_k", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_short_oi_amount_k", "finlab.futures_institutional_investors_trading_summary", "futures_inst_short_oi_amount_k", None),
        ("regime_context", "futures_institutional_investors_trading_summary", "futures_inst_net_oi_amount_k", "finlab.futures_institutional_investors_trading_summary", "futures_inst_net_oi_amount_k", None),
        ("global_context", "world_index", "world_close", "finlab.world_index", "world_close", None),
        ("global_context", "world_index", "world_adj_close", "finlab.world_index", "world_adj_close", None),
    ]
    rows: list[dict[str, Any]] = []
    for lane, dataset, field_alias, source, filename, lookback_days in specs:
        frame = _read_parquet(artifact_root / "raw" / lane / f"{filename}.parquet")
        if frame.is_empty():
            continue
        context_start_date = _shift_start_date(start_date, lookback_days)
        rows.extend(_context_rows_from_frame(
            frame,
            run_id=run_id,
            generated_at=generated_at,
            artifact_root=artifact_root,
            lane=lane,
            dataset=dataset,
            source=source,
            field_alias=field_alias,
            start_date=context_start_date,
            end_date=end_date,
        ))

    deduped: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
    for row in rows:
        deduped[(row["date"], row["dataset"], row["field"], row["category"], row["source"])] = row
    output = list(deduped.values())
    return output[:limit] if limit and limit > 0 else output


def _market_summary_number(row: dict[str, Any], names: Iterable[str]) -> float | None:
    match = _first_row_match(row, names)
    if not match:
        return None
    key, value = match
    parsed = _coerce_number(value)
    if parsed is None:
        return None
    if "仟元" in key or "千元" in key:
        return parsed * 1000
    return parsed


def _market_summary_segment(value: Any) -> str:
    text = str(value or "").strip().upper()
    if not text:
        return "ALL"
    if text in {"ALL", "MARKET", "TOTAL"} or "合計" in text or "全市場" in text:
        return "ALL"
    if text in {"TWSE", "LISTED"} or "上市" in text:
        return "LISTED"
    if text in {"TPEX", "OTC"} or "上櫃" in text or "櫃買" in text:
        return "OTC"
    if "興櫃" in text or "EMERGING" in text:
        return "EMERGING"
    return text


def _market_summary_field(value: Any, *, kind: str) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    if "融資金額" in text:
        return "margin_value"
    if "融資" in text:
        return "margin_units"
    if "融券" in text:
        return "short_units"
    if kind == "breadth" and ("漲跌" in text or "家數" in text):
        return "breadth"
    return None


def _market_summary_amount_row(
    raw: dict[str, Any],
    *,
    generated_at: str,
    source: str,
    lineage: str,
) -> dict[str, Any] | None:
    date = _date_value(raw)
    if not date:
        return None
    segment = _market_summary_segment(_first_row_value(raw, ["market_segment", "segment", "market", "市場別", "市場"]))
    row = {
        "date": date,
        "market_segment": segment,
        "advance_count": _market_summary_number(raw, ["advance_count", "advance", "rising", "up", "上漲", "上漲家數"]),
        "unchanged_count": _market_summary_number(raw, ["unchanged_count", "unchanged", "flat", "平盤", "持平", "平盤家數"]),
        "decline_count": _market_summary_number(raw, ["decline_count", "decline", "falling", "down", "下跌", "下跌家數"]),
        "total_volume": _market_summary_number(raw, ["total_volume", "market_volume", "volume", "成交股數", "成交量", "總成交量"]),
        "total_value": _market_summary_number(raw, ["total_value", "market_value", "amount", "value", "成交金額", "成交值", "總成交額"]),
        "margin_buy_units": _market_summary_number(raw, ["margin_buy_units", "margin_buy", "融資買進", "融資買進(交易單位)"]),
        "margin_sell_units": _market_summary_number(raw, ["margin_sell_units", "margin_sell", "融資賣出", "融資賣出(交易單位)"]),
        "margin_return_units": _market_summary_number(raw, ["margin_return_units", "margin_return", "cash_redemption", "融資現償", "融資現金償還"]),
        "margin_balance_units": _market_summary_number(raw, ["margin_balance_units", "margin_balance", "margin_today_balance_units", "融資今日餘額", "融資餘額"]),
        "margin_buy_value": _market_summary_number(raw, ["margin_buy_value", "margin_buy_amount", "融資買進金額", "融資買進(仟元)"]),
        "margin_sell_value": _market_summary_number(raw, ["margin_sell_value", "margin_sell_amount", "融資賣出金額", "融資賣出(仟元)"]),
        "margin_return_value": _market_summary_number(raw, ["margin_return_value", "margin_return_amount", "融資現償金額", "融資現償(仟元)"]),
        "margin_balance_value": _market_summary_number(raw, ["margin_balance_value", "margin_balance_amount", "margin_today_balance_value", "融資金額", "融資金額(仟元)", "融資今日餘額金額"]),
        "margin_balance_change_pct": _market_summary_number(raw, ["margin_balance_change_pct", "margin_change_pct", "融資餘額變動率"]),
        "short_buy_units": _market_summary_number(raw, ["short_buy_units", "short_buy", "融券買進", "融券買進(交易單位)"]),
        "short_sell_units": _market_summary_number(raw, ["short_sell_units", "short_sell", "融券賣出", "融券賣出(交易單位)"]),
        "short_return_units": _market_summary_number(raw, ["short_return_units", "short_return", "short_cover", "融券現償", "融券償還"]),
        "short_balance_units": _market_summary_number(raw, ["short_balance_units", "short_balance", "short_today_balance_units", "融券今日餘額", "融券餘額"]),
        "short_balance_change_pct": _market_summary_number(raw, ["short_balance_change_pct", "short_change_pct", "融券餘額變動率"]),
        "source": source,
        "lineage_json": lineage,
        "as_of_date": generated_at[:10],
    }
    if all(row.get(key) is None for key in row.keys() - {"date", "market_segment", "source", "lineage_json", "as_of_date"}):
        return None
    return row


def _market_summary_rows_from_item_table(
    frame: pl.DataFrame,
    *,
    generated_at: str,
    source: str,
    lineage: str,
    start_date: str | None,
    end_date: str | None,
) -> list[dict[str, Any]]:
    frame = _filter_dates(frame, start_date=start_date, end_date=end_date) if "date" in frame.columns else frame
    if frame.is_empty():
        return []
    buckets: dict[tuple[str, str], dict[str, Any]] = {}
    for raw in _rows(frame):
        date = _date_value(raw)
        if not date:
            continue
        segment = _market_summary_segment(_first_row_value(raw, ["market_segment", "segment", "market", "市場別", "市場"]))
        field = _market_summary_field(_first_row_value(raw, ["item", "項目", "name", "category", "類別"]), kind="credit")
        if not field:
            continue
        bucket = buckets.setdefault((date, segment), {
            "date": date,
            "market_segment": segment,
            "advance_count": None,
            "unchanged_count": None,
            "decline_count": None,
            "total_volume": None,
            "total_value": None,
            "margin_buy_units": None,
            "margin_sell_units": None,
            "margin_return_units": None,
            "margin_balance_units": None,
            "margin_buy_value": None,
            "margin_sell_value": None,
            "margin_return_value": None,
            "margin_balance_value": None,
            "margin_balance_change_pct": None,
            "short_buy_units": None,
            "short_sell_units": None,
            "short_return_units": None,
            "short_balance_units": None,
            "short_balance_change_pct": None,
            "source": source,
            "lineage_json": lineage,
            "as_of_date": generated_at[:10],
        })
        multiplier = 1000 if field == "margin_value" else 1
        buy = _market_summary_number(raw, ["buy", "buy_amount", "買進"])
        sell = _market_summary_number(raw, ["sell", "sell_amount", "賣出"])
        returned = _market_summary_number(raw, ["return", "return_amount", "現金(券)償還", "現償", "償還"])
        today = _market_summary_number(raw, ["today_balance", "balance", "今日餘額", "今餘"])
        if field == "margin_value":
            bucket["margin_buy_value"] = None if buy is None else buy * multiplier
            bucket["margin_sell_value"] = None if sell is None else sell * multiplier
            bucket["margin_return_value"] = None if returned is None else returned * multiplier
            bucket["margin_balance_value"] = None if today is None else today * multiplier
        elif field == "margin_units":
            bucket["margin_buy_units"] = buy
            bucket["margin_sell_units"] = sell
            bucket["margin_return_units"] = returned
            bucket["margin_balance_units"] = today
        elif field == "short_units":
            bucket["short_buy_units"] = buy
            bucket["short_sell_units"] = sell
            bucket["short_return_units"] = returned
            bucket["short_balance_units"] = today
    return list(buckets.values())


def build_market_summary_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    specs = [
        ("market_summary", "market_summary_daily", "finlab.market_summary"),
        ("market_summary", "market_breadth_summary", "finlab.market_breadth"),
        ("market_summary", "twse_margin_trading_summary", "twse.mi_margn.official"),
        ("market_summary", "tpex_margin_trading_summary", "tpex.margin_balance.official"),
    ]
    rows: list[dict[str, Any]] = []
    for lane, filename, source in specs:
        frame = _read_parquet(artifact_root / "raw" / lane / f"{filename}.parquet")
        if frame.is_empty():
            continue
        frame = _filter_dates(frame, start_date=start_date, end_date=end_date) if "date" in frame.columns else frame
        lineage = _lineage(run_id, lane, list(frame.columns), artifact_root)
        direct_rows = [
            row
            for raw in _rows(frame)
            if (row := _market_summary_amount_row(raw, generated_at=generated_at, source=source, lineage=lineage)) is not None
        ]
        rows.extend(direct_rows)
        if not direct_rows:
            rows.extend(_market_summary_rows_from_item_table(
                frame,
                generated_at=generated_at,
                source=source,
                lineage=lineage,
                start_date=start_date,
                end_date=end_date,
            ))

    merged: dict[tuple[str, str], dict[str, Any]] = {}
    for row in rows:
        key = (row["date"], row["market_segment"])
        existing = merged.setdefault(key, {**row})
        if existing is row:
            continue
        for field, value in row.items():
            if field in {"date", "market_segment"}:
                continue
            if value is None:
                continue
            if field == "source":
                current = str(existing.get("source") or "")
                incoming = str(value)
                if incoming and incoming not in current.split(";"):
                    existing["source"] = ";".join(part for part in [current, incoming] if part)
                continue
            if field == "lineage_json":
                current = str(existing.get("lineage_json") or "")
                incoming = str(value)
                if incoming and incoming != current:
                    existing["lineage_json"] = _json({
                        "schema_version": SCHEMA_VERSION,
                        "dataset_lane": "market_summary",
                        "sources": [part for part in [current, incoming] if part],
                    })
                continue
            if existing.get(field) is None or (field in {"source", "lineage_json"} and row["source"].startswith("finlab.")):
                existing[field] = value
    output = list(merged.values())
    output.sort(key=lambda row: (row["date"], row["market_segment"]))
    return output[:limit] if limit and limit > 0 else output


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


def build_listed_broker_flow_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    lane = "broker_flow_diversity"
    broker = _read_parquet(artifact_root / "raw" / lane / "broker_daily.parquet")
    if broker.is_empty():
        return []
    broker = _filter_dates(broker, start_date=start_date, end_date=end_date)
    if broker.is_empty():
        return []

    close = _wide_field_to_long(
        artifact_root / "raw" / "daily_price" / "close.parquet",
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
        pl.lit("LISTED_OTC").alias("market_segment"),
        pl.lit("finlab.broker_transactions").alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).select([
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
    return _rows(broker, limit)


def build_broker_rank_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    lane: str,
    filename: str,
    market_segment: str,
    source: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    rank = _read_parquet(artifact_root / "raw" / lane / filename)
    if rank.is_empty():
        return []
    rank = _filter_dates(rank, start_date=start_date, end_date=end_date)
    if rank.is_empty():
        return []

    broker_name_expr = (
        pl.col("broker_name").cast(pl.Utf8, strict=False)
        if "broker_name" in rank.columns
        else pl.lit(None).cast(pl.Utf8)
    )
    lineage = _lineage(
        run_id,
        lane,
        ["rank_side", "rank_no", "broker_code", "broker_name", "buy_lots", "sell_lots", "net_lots"],
        artifact_root,
    )
    rank = rank.with_columns(
        pl.col("stock_id").map_elements(normalize_symbol, return_dtype=pl.Utf8).alias("stock_id"),
        _date_expr("date").alias("date"),
        pl.col("rank_side").cast(pl.Utf8).str.to_lowercase(),
        pl.col("rank_no").cast(pl.Int64, strict=False),
        pl.col("broker_code").cast(pl.Utf8, strict=False),
        broker_name_expr.alias("broker_name"),
        pl.col("buy_lots").cast(pl.Float64, strict=False),
        pl.col("sell_lots").cast(pl.Float64, strict=False),
        pl.col("net_lots").cast(pl.Float64, strict=False),
        pl.lit(market_segment).alias("market_segment"),
        pl.lit(source).alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).filter(
        pl.col("stock_id").is_not_null()
        & (pl.col("stock_id") != "")
        & pl.col("rank_side").is_in(["buy", "sell"])
        & pl.col("rank_no").is_between(1, 3)
    ).select([
        "stock_id",
        "date",
        "market_segment",
        "rank_side",
        "rank_no",
        "broker_code",
        "broker_name",
        "buy_lots",
        "sell_lots",
        "net_lots",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(rank, limit)


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
    fields = [
        "revenue",
        "previous_month_revenue",
        "last_year_month_revenue",
        "mom",
        "yoy",
        "cumulative_revenue",
        "last_year_cumulative_revenue",
        "previous_comparison_pct",
    ]
    df = _join_wide_fields(artifact_root / "raw" / lane, fields, start_date=start_date, end_date=end_date)
    if df.is_empty():
        return []
    missing_fields = [field for field in fields if field not in df.columns]
    if missing_fields:
        df = df.with_columns([pl.lit(None, dtype=pl.Float64).alias(field) for field in missing_fields])
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
        "previous_month_revenue",
        "last_year_month_revenue",
        "mom",
        "yoy",
        "cumulative_revenue",
        "last_year_cumulative_revenue",
        "previous_comparison_pct",
        "source",
        "lineage_json",
        "as_of_date",
    ])
    return _rows(df, limit)


def build_fundamental_rows(
    artifact_root: Path,
    *,
    run_id: str,
    generated_at: str,
    start_date: str | None,
    end_date: str | None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    fields = [
        "revenue_growth_yoy",
        "gross_margin",
        "operating_margin",
        "roe",
        "eps",
        "pe",
        "pb",
        "dividend_yield",
        "debt_ratio",
        "current_ratio",
        "operating_cash_flow",
        "roa",
        "roa_comprehensive",
        "roe_comprehensive",
        "ebitda",
        "free_cash_flow",
        "ebitda_margin",
        "pretax_margin",
        "net_margin",
        "non_operating_income_revenue_ratio",
        "berry_ratio",
        "operating_expense_ratio",
        "sales_expense_ratio",
        "admin_expense_ratio",
        "rd_expense_ratio",
        "cash_flow_ratio",
        "tax_rate",
        "sales_per_share",
        "operating_income_per_share",
        "comprehensive_income_per_share",
        "liabilities_to_equity",
        "equity_to_assets",
        "gross_margin_growth",
        "operating_income_growth",
        "pretax_income_growth",
        "net_income_growth",
        "recurring_income_growth",
        "total_assets_growth",
        "equity_growth",
        "quick_ratio",
        "interest_expense_ratio",
        "total_asset_turnover",
        "receivables_turnover",
        "inventory_turnover",
        "fixed_asset_turnover",
        "equity_turnover",
        "revenue",
        "operating_income",
        "net_income",
        "financial_cost",
        "operating_expenses",
        "cash_flow_per_share",
        "pretax_income_per_share",
        "property_plant_equipment",
        "working_capital",
        "current_liabilities",
        "operating_cash_flow_statement",
        "non_current_assets",
        "cash_and_cash_equivalents_increase_decrease",
        "other_payables",
        "capital_amount",
        "common_stock_capital",
        "preferred_stock_capital",
        "total_assets",
        "total_liabilities",
        "equity_parent",
    ]
    valuation_only_fields = {"pe", "pb", "dividend_yield"}
    canonical_presence_fields = [field for field in fields if field not in valuation_only_fields]
    single_day_snapshot = bool(start_date and end_date and start_date == end_date)
    df = (
        _join_wide_fields_asof_snapshot(
            artifact_root / "raw" / "fundamental_factor_diversity",
            fields,
            end_date=end_date or start_date or generated_at[:10],
        )
        if single_day_snapshot
        else _join_wide_fields(
            artifact_root / "raw" / "fundamental_factor_diversity",
            fields,
            start_date=start_date,
            end_date=end_date,
        )
    )
    if df.is_empty():
        return []
    missing_fields = [field for field in fields if field not in df.columns]
    if missing_fields:
        df = df.with_columns([pl.lit(None, dtype=pl.Float64).alias(field) for field in missing_fields])
    df = df.filter(pl.any_horizontal([
        pl.col(field).is_not_null() & ~pl.col(field).is_nan()
        for field in canonical_presence_fields
    ]))
    if df.is_empty():
        return []

    financial_statement_amount_fields = [
        "capital_amount",
        "common_stock_capital",
        "preferred_stock_capital",
        "total_assets",
        "total_liabilities",
        "equity_parent",
        "financial_cost",
        "operating_expenses",
        "revenue",
        "operating_income",
        "net_income",
        "property_plant_equipment",
        "non_current_assets",
        "cash_and_cash_equivalents_increase_decrease",
        "other_payables",
        "current_liabilities",
        "operating_cash_flow_statement",
    ]
    df = df.with_columns([
        (pl.col(field) * 1000).alias(field)
        for field in financial_statement_amount_fields
        if field in df.columns
    ])

    lineage = _lineage(run_id, "fundamental_factor_diversity", fields, artifact_root)
    period_preference_fields = [
        "eps",
        "roe",
        "gross_margin",
        "operating_margin",
        "revenue_growth_yoy",
        "revenue",
        "operating_income",
        "net_income",
        "total_assets",
        "capital_amount",
        "pe",
    ]
    if single_day_snapshot:
        date_exprs = [
            pl.col(f"{field}__date")
            for field in period_preference_fields
            if f"{field}__date" in df.columns
        ]
        period_expr = pl.coalesce(date_exprs) if date_exprs else pl.lit(end_date or generated_at[:10])
        df = df.with_columns(
            period_expr.alias("period"),
            period_expr.alias("report_date"),
            pl.lit(end_date or generated_at[:10]).alias("available_date"),
        )
    else:
        df = df.with_columns(
            pl.col("date").alias("period"),
            pl.col("date").alias("report_date"),
            pl.col("date").alias("available_date"),
        )
    df = df.with_columns(
        pl.lit("LISTED_OTC").alias("market_segment"),
        pl.lit("finlab.fundamental_factor_diversity").alias("source"),
        pl.lit(lineage).alias("lineage_json"),
        pl.lit(generated_at[:10]).alias("as_of_date"),
    ).select([
        "stock_id",
        "period",
        "market_segment",
        "report_date",
        "available_date",
        "revenue_growth_yoy",
        "gross_margin",
        "operating_margin",
        "roe",
        "eps",
        "pe",
        "pb",
        "dividend_yield",
        "revenue",
        "debt_ratio",
        "current_ratio",
        "operating_cash_flow",
        pl.lit(None, dtype=pl.Float64).alias("industry_quality_percentile"),
        "roa",
        "roa_comprehensive",
        "roe_comprehensive",
        "ebitda",
        "free_cash_flow",
        "ebitda_margin",
        "pretax_margin",
        "net_margin",
        "non_operating_income_revenue_ratio",
        "berry_ratio",
        "operating_expense_ratio",
        "sales_expense_ratio",
        "admin_expense_ratio",
        "rd_expense_ratio",
        "cash_flow_ratio",
        "tax_rate",
        "sales_per_share",
        "operating_income_per_share",
        "comprehensive_income_per_share",
        "liabilities_to_equity",
        "equity_to_assets",
        "gross_margin_growth",
        "operating_income_growth",
        "pretax_income_growth",
        "net_income_growth",
        "recurring_income_growth",
        "total_assets_growth",
        "equity_growth",
        "quick_ratio",
        "interest_expense_ratio",
        "total_asset_turnover",
        "receivables_turnover",
        "inventory_turnover",
        "fixed_asset_turnover",
        "equity_turnover",
        "operating_income",
        "net_income",
        "financial_cost",
        "operating_expenses",
        "cash_flow_per_share",
        "pretax_income_per_share",
        "property_plant_equipment",
        "working_capital",
        "current_liabilities",
        "operating_cash_flow_statement",
        "non_current_assets",
        "cash_and_cash_equivalents_increase_decrease",
        "other_payables",
        "capital_amount",
        "common_stock_capital",
        "preferred_stock_capital",
        "total_assets",
        "total_liabilities",
        "equity_parent",
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
    include_emerging: bool = True,
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
    ) if include_emerging and wants("canonical_market_daily") else []
    listed_chip = build_chip_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_chip_daily") else []
    institutional_amount = build_institutional_amount_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_institutional_amount_daily") else []
    market_index = build_market_index_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_market_index_daily") else []
    futures = build_futures_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_futures_daily") else []
    market_summary = build_market_summary_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_market_summary_daily") else []
    regime_context = build_regime_context_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_regime_context_daily") else []
    listed_broker_flow = build_listed_broker_flow_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_broker_flow_daily") else []
    listed_broker_rank = build_broker_rank_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        lane="broker_flow_diversity",
        filename="broker_rank_daily.parquet",
        market_segment="LISTED_OTC",
        source="finlab.broker_transactions",
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_broker_rank_daily") else []
    if include_emerging and (wants("canonical_chip_daily") or wants("canonical_broker_flow_daily")):
        emerging_chip, emerging_broker_flow = build_emerging_broker_rows(
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
            emerging_broker_flow = []
    else:
        emerging_chip, emerging_broker_flow = [], []
    emerging_broker_rank = build_broker_rank_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        lane="emerging_chip_diversity",
        filename="rotc_broker_rank_daily.parquet",
        market_segment="EMERGING",
        source="finlab.rotc_broker_transactions",
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if include_emerging and wants("canonical_broker_rank_daily") else []
    broker_flow = listed_broker_flow + emerging_broker_flow
    broker_rank = listed_broker_rank + emerging_broker_rank
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
    ) if include_emerging and wants("canonical_revenue_monthly") else []
    fundamentals = build_fundamental_rows(
        root,
        run_id=rid,
        generated_at=timestamp,
        start_date=start_date,
        end_date=end_date,
        limit=limit_per_dataset,
    ) if wants("canonical_fundamental_features") else []
    taxonomy = build_taxonomy_rows(root, generated_at=timestamp, limit=limit_per_dataset) if wants("finlab_taxonomy_tags") else []

    output_rows: dict[str, list[dict[str, Any]]] = {}
    if wants("canonical_market_daily"):
        output_rows["canonical_market_daily"] = listed_market + emerging_market
    if wants("canonical_chip_daily"):
        output_rows["canonical_chip_daily"] = listed_chip + emerging_chip
    if wants("canonical_institutional_amount_daily"):
        output_rows["canonical_institutional_amount_daily"] = institutional_amount
    if wants("canonical_market_index_daily"):
        output_rows["canonical_market_index_daily"] = market_index
    if wants("canonical_futures_daily"):
        output_rows["canonical_futures_daily"] = futures
    if wants("canonical_market_summary_daily"):
        output_rows["canonical_market_summary_daily"] = market_summary
    if wants("canonical_regime_context_daily"):
        output_rows["canonical_regime_context_daily"] = regime_context
    if wants("canonical_revenue_monthly"):
        output_rows["canonical_revenue_monthly"] = listed_revenue + emerging_revenue
    if wants("canonical_fundamental_features"):
        output_rows["canonical_fundamental_features"] = fundamentals
    if wants("canonical_broker_flow_daily"):
        output_rows["canonical_broker_flow_daily"] = broker_flow
    if wants("canonical_broker_rank_daily"):
        output_rows["canonical_broker_rank_daily"] = broker_rank
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
            "include_emerging": include_emerging,
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
        canonical_market_index_daily=output_rows.get("canonical_market_index_daily", []),
        canonical_futures_daily=output_rows.get("canonical_futures_daily", []),
        canonical_market_summary_daily=output_rows.get("canonical_market_summary_daily", []),
        canonical_regime_context_daily=output_rows.get("canonical_regime_context_daily", []),
        canonical_revenue_monthly=output_rows.get("canonical_revenue_monthly", []),
        canonical_fundamental_features=output_rows.get("canonical_fundamental_features", []),
        canonical_broker_flow_daily=output_rows.get("canonical_broker_flow_daily", []),
        canonical_broker_rank_daily=output_rows.get("canonical_broker_rank_daily", []),
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
    return [(sql, [_d1_param(row.get(column)) for column in columns]) for row in rows]


def _d1_param(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


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
        [
            "stock_id",
            "date",
            "market_segment",
            "open",
            "high",
            "low",
            "close",
            "adj_open",
            "adj_high",
            "adj_low",
            "adj_close",
            "volume",
            "trade_count",
            "value",
            "avg_price",
            "last_bid_price",
            "last_ask_price",
            "last_bid_volume",
            "last_ask_volume",
            "market_value",
            "source",
            "lineage_json",
            "as_of_date",
        ],
        ["stock_id", "date", "source"],
        [
            "market_segment",
            "open",
            "high",
            "low",
            "close",
            "adj_open",
            "adj_high",
            "adj_low",
            "adj_close",
            "volume",
            "trade_count",
            "value",
            "avg_price",
            "last_bid_price",
            "last_ask_price",
            "last_bid_volume",
            "last_ask_volume",
            "market_value",
            "lineage_json",
            "as_of_date",
        ],
    ))
    statements.extend(_row_statements(
        "canonical_chip_daily",
        outputs.canonical_chip_daily,
        [
            "stock_id",
            "date",
            "market_segment",
            "foreign_buy",
            "foreign_sell",
            "foreign_net",
            "foreign_dealer_buy",
            "foreign_dealer_sell",
            "foreign_dealer_net",
            "trust_buy",
            "trust_sell",
            "trust_net",
            "dealer_buy",
            "dealer_sell",
            "dealer_net",
            "dealer_self_buy",
            "dealer_self_sell",
            "dealer_hedge_buy",
            "dealer_hedge_sell",
            "margin_buy",
            "margin_sell",
            "margin_cash_repayment",
            "margin_prev_balance",
            "margin_balance",
            "margin_limit",
            "short_buy",
            "short_sell",
            "short_stock_repayment",
            "short_prev_balance",
            "short_balance",
            "short_limit",
            "margin_short_offset",
            "margin_usage_ratio",
            "short_usage_ratio",
            "margin_balance_total_buy",
            "margin_balance_total_sell",
            "margin_balance_total_repayment",
            "margin_balance_total_balance",
            "security_lending_prev_balance",
            "security_lending_borrow",
            "security_lending_return",
            "security_lending_delta",
            "security_lending_balance",
            "security_lending_sell",
            "security_lending_sell_return",
            "security_lending_sell_balance",
            "security_lending_sell_limit",
            "broker_top15_buy",
            "broker_top15_sell",
            "broker_buy_sell_ratio",
            "broker_balance_index",
            "source",
            "lineage_json",
            "as_of_date",
        ],
        ["stock_id", "date", "source"],
        [
            "market_segment",
            "foreign_buy",
            "foreign_sell",
            "foreign_net",
            "foreign_dealer_buy",
            "foreign_dealer_sell",
            "foreign_dealer_net",
            "trust_buy",
            "trust_sell",
            "trust_net",
            "dealer_buy",
            "dealer_sell",
            "dealer_net",
            "dealer_self_buy",
            "dealer_self_sell",
            "dealer_hedge_buy",
            "dealer_hedge_sell",
            "margin_buy",
            "margin_sell",
            "margin_cash_repayment",
            "margin_prev_balance",
            "margin_balance",
            "margin_limit",
            "short_buy",
            "short_sell",
            "short_stock_repayment",
            "short_prev_balance",
            "short_balance",
            "short_limit",
            "margin_short_offset",
            "margin_usage_ratio",
            "short_usage_ratio",
            "margin_balance_total_buy",
            "margin_balance_total_sell",
            "margin_balance_total_repayment",
            "margin_balance_total_balance",
            "security_lending_prev_balance",
            "security_lending_borrow",
            "security_lending_return",
            "security_lending_delta",
            "security_lending_balance",
            "security_lending_sell",
            "security_lending_sell_return",
            "security_lending_sell_balance",
            "security_lending_sell_limit",
            "broker_top15_buy",
            "broker_top15_sell",
            "broker_buy_sell_ratio",
            "broker_balance_index",
            "lineage_json",
            "as_of_date",
        ],
    ))
    statements.extend(_row_statements(
        "canonical_institutional_amount_daily",
        outputs.canonical_institutional_amount_daily,
        ["date", "market_segment", "investor", "category", "buy_amount", "sell_amount", "net_amount", "source", "lineage_json", "as_of_date"],
        ["date", "market_segment", "investor", "source"],
        ["category", "buy_amount", "sell_amount", "net_amount", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_market_index_daily",
        outputs.canonical_market_index_daily,
        ["symbol", "date", "name", "market_segment", "open", "high", "low", "close", "change", "change_pct", "volume", "value", "source", "lineage_json", "as_of_date"],
        ["symbol", "date", "source"],
        ["name", "market_segment", "open", "high", "low", "close", "change", "change_pct", "volume", "value", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_futures_daily",
        outputs.canonical_futures_daily,
        ["symbol", "date", "contract_month", "session", "open", "high", "low", "close", "change", "change_pct", "volume", "open_interest", "source", "lineage_json", "as_of_date"],
        ["symbol", "date", "contract_month", "session", "source"],
        ["open", "high", "low", "close", "change", "change_pct", "volume", "open_interest", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_market_summary_daily",
        outputs.canonical_market_summary_daily,
        [
            "date",
            "market_segment",
            "advance_count",
            "unchanged_count",
            "decline_count",
            "total_volume",
            "total_value",
            "margin_buy_units",
            "margin_sell_units",
            "margin_return_units",
            "margin_balance_units",
            "margin_buy_value",
            "margin_sell_value",
            "margin_return_value",
            "margin_balance_value",
            "margin_balance_change_pct",
            "short_buy_units",
            "short_sell_units",
            "short_return_units",
            "short_balance_units",
            "short_balance_change_pct",
            "source",
            "lineage_json",
            "as_of_date",
        ],
        ["date", "market_segment"],
        [
            "advance_count",
            "unchanged_count",
            "decline_count",
            "total_volume",
            "total_value",
            "margin_buy_units",
            "margin_sell_units",
            "margin_return_units",
            "margin_balance_units",
            "margin_buy_value",
            "margin_sell_value",
            "margin_return_value",
            "margin_balance_value",
            "margin_balance_change_pct",
            "short_buy_units",
            "short_sell_units",
            "short_return_units",
            "short_balance_units",
            "short_balance_change_pct",
            "source",
            "lineage_json",
            "as_of_date",
        ],
    ))
    statements.extend(_row_statements(
        "canonical_regime_context_daily",
        outputs.canonical_regime_context_daily,
        ["date", "dataset", "field", "category", "value", "text_value", "source", "lineage_json", "as_of_date"],
        ["date", "dataset", "field", "category", "source"],
        ["value", "text_value", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_revenue_monthly",
        outputs.canonical_revenue_monthly,
        [
            "stock_id",
            "revenue_month",
            "market_segment",
            "revenue",
            "previous_month_revenue",
            "last_year_month_revenue",
            "mom",
            "yoy",
            "cumulative_revenue",
            "last_year_cumulative_revenue",
            "previous_comparison_pct",
            "source",
            "lineage_json",
            "as_of_date",
        ],
        ["stock_id", "revenue_month", "source"],
        [
            "market_segment",
            "revenue",
            "previous_month_revenue",
            "last_year_month_revenue",
            "mom",
            "yoy",
            "cumulative_revenue",
            "last_year_cumulative_revenue",
            "previous_comparison_pct",
            "lineage_json",
            "as_of_date",
        ],
    ))
    statements.extend(_row_statements(
        "canonical_fundamental_features",
        outputs.canonical_fundamental_features,
        [
            "stock_id",
            "period",
            "market_segment",
            "report_date",
            "available_date",
            "revenue_growth_yoy",
            "gross_margin",
            "operating_margin",
            "roe",
            "eps",
            "pe",
            "pb",
            "dividend_yield",
            "revenue",
            "debt_ratio",
            "current_ratio",
            "operating_cash_flow",
            "industry_quality_percentile",
            "roa",
            "roa_comprehensive",
            "roe_comprehensive",
            "ebitda",
            "free_cash_flow",
            "ebitda_margin",
            "pretax_margin",
            "net_margin",
            "non_operating_income_revenue_ratio",
            "berry_ratio",
            "operating_expense_ratio",
            "sales_expense_ratio",
            "admin_expense_ratio",
            "rd_expense_ratio",
            "cash_flow_ratio",
            "tax_rate",
            "sales_per_share",
            "operating_income_per_share",
            "comprehensive_income_per_share",
            "liabilities_to_equity",
            "equity_to_assets",
            "gross_margin_growth",
            "operating_income_growth",
            "pretax_income_growth",
            "net_income_growth",
            "recurring_income_growth",
            "total_assets_growth",
            "equity_growth",
            "quick_ratio",
            "interest_expense_ratio",
            "total_asset_turnover",
            "receivables_turnover",
            "inventory_turnover",
            "fixed_asset_turnover",
            "equity_turnover",
            "operating_income",
            "net_income",
            "financial_cost",
            "operating_expenses",
            "cash_flow_per_share",
            "pretax_income_per_share",
            "property_plant_equipment",
            "working_capital",
            "current_liabilities",
            "operating_cash_flow_statement",
            "non_current_assets",
            "cash_and_cash_equivalents_increase_decrease",
            "other_payables",
            "capital_amount",
            "common_stock_capital",
            "preferred_stock_capital",
            "total_assets",
            "total_liabilities",
            "equity_parent",
            "source",
            "lineage_json",
            "as_of_date",
        ],
        ["stock_id", "period", "source"],
        [
            "market_segment",
            "report_date",
            "available_date",
            "revenue_growth_yoy",
            "gross_margin",
            "operating_margin",
            "roe",
            "eps",
            "pe",
            "pb",
            "dividend_yield",
            "revenue",
            "debt_ratio",
            "current_ratio",
            "operating_cash_flow",
            "industry_quality_percentile",
            "roa",
            "roa_comprehensive",
            "roe_comprehensive",
            "ebitda",
            "free_cash_flow",
            "ebitda_margin",
            "pretax_margin",
            "net_margin",
            "non_operating_income_revenue_ratio",
            "berry_ratio",
            "operating_expense_ratio",
            "sales_expense_ratio",
            "admin_expense_ratio",
            "rd_expense_ratio",
            "cash_flow_ratio",
            "tax_rate",
            "sales_per_share",
            "operating_income_per_share",
            "comprehensive_income_per_share",
            "liabilities_to_equity",
            "equity_to_assets",
            "gross_margin_growth",
            "operating_income_growth",
            "pretax_income_growth",
            "net_income_growth",
            "recurring_income_growth",
            "total_assets_growth",
            "equity_growth",
            "quick_ratio",
            "interest_expense_ratio",
            "total_asset_turnover",
            "receivables_turnover",
            "inventory_turnover",
            "fixed_asset_turnover",
            "equity_turnover",
            "operating_income",
            "net_income",
            "financial_cost",
            "operating_expenses",
            "cash_flow_per_share",
            "pretax_income_per_share",
            "property_plant_equipment",
            "working_capital",
            "current_liabilities",
            "operating_cash_flow_statement",
            "non_current_assets",
            "cash_and_cash_equivalents_increase_decrease",
            "other_payables",
            "capital_amount",
            "common_stock_capital",
            "preferred_stock_capital",
            "total_assets",
            "total_liabilities",
            "equity_parent",
            "lineage_json",
            "as_of_date",
        ],
    ))
    statements.extend(_row_statements(
        "canonical_broker_flow_daily",
        outputs.canonical_broker_flow_daily,
        ["stock_id", "date", "market_segment", "buy_shares", "sell_shares", "net_shares", "dominant_net_shares", "gross_imbalance_shares", "estimated_amount", "broker_count", "concentration", "source", "lineage_json", "as_of_date"],
        ["stock_id", "date", "source"],
        ["market_segment", "buy_shares", "sell_shares", "net_shares", "dominant_net_shares", "gross_imbalance_shares", "estimated_amount", "broker_count", "concentration", "lineage_json", "as_of_date"],
    ))
    statements.extend(_row_statements(
        "canonical_broker_rank_daily",
        outputs.canonical_broker_rank_daily,
        ["stock_id", "date", "market_segment", "rank_side", "rank_no", "broker_code", "broker_name", "buy_lots", "sell_lots", "net_lots", "source", "lineage_json", "as_of_date"],
        ["stock_id", "date", "source", "rank_side", "rank_no"],
        ["market_segment", "broker_code", "broker_name", "buy_lots", "sell_lots", "net_lots", "lineage_json", "as_of_date"],
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
