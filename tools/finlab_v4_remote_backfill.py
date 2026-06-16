from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
for candidate in (ROOT, ROOT / "ml-controller"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))


@dataclass(frozen=True)
class DatasetSpec:
    lane: str
    kind: str
    keys: dict[str, str]


CORE_SPECS = [
    DatasetSpec(
        lane="daily_price",
        kind="wide_fields",
        keys={
            "open": "price:開盤價",
            "high": "price:最高價",
            "low": "price:最低價",
            "close": "price:收盤價",
            "volume": "price:成交股數",
            "value": "price:成交金額",
        },
    ),
    DatasetSpec(
        lane="chip_diversity",
        kind="wide_fields",
        keys={
            "foreign_net": "institutional_investors_trading_summary:外陸資買賣超股數(不含外資自營商)",
            "trust_net": "institutional_investors_trading_summary:投信買賣超股數",
            "dealer_self_net": "institutional_investors_trading_summary:自營商買賣超股數(自行買賣)",
            "dealer_hedge_net": "institutional_investors_trading_summary:自營商買賣超股數(避險)",
            "margin_balance": "margin_transactions:融資今日餘額",
            "short_balance": "margin_transactions:融券今日餘額",
        },
    ),
    DatasetSpec(
        lane="broker_flow_diversity",
        kind="broker_aggregate",
        keys={"broker_transactions": "broker_transactions"},
    ),
    DatasetSpec(
        lane="institutional_amount_summary",
        kind="wide_fields",
        keys={
            "buy_amount": "institutional_investors_trading_all_market_summary:買進金額",
            "sell_amount": "institutional_investors_trading_all_market_summary:賣出金額",
            "net_amount": "institutional_investors_trading_all_market_summary:買賣超",
        },
    ),
    DatasetSpec(
        lane="revenue",
        kind="wide_fields",
        keys={
            "revenue": "monthly_revenue:當月營收",
            "mom": "monthly_revenue:上月比較增減(%)",
            "yoy": "monthly_revenue:去年同月增減(%)",
        },
    ),
    DatasetSpec(
        lane="emerging_price_diversity",
        kind="wide_fields",
        keys={
            "open": "rotc_price:開盤價",
            "high": "rotc_price:最高價",
            "low": "rotc_price:最低價",
            "close": "rotc_price:收盤價",
            "volume": "rotc_price:成交股數",
            "value": "rotc_price:成交金額",
        },
    ),
    DatasetSpec(
        lane="emerging_revenue_diversity",
        kind="wide_fields",
        keys={
            "revenue": "rotc_monthly_revenue:當月營收",
            "mom": "rotc_monthly_revenue:上月比較增減(%)",
            "yoy": "rotc_monthly_revenue:去年同月增減(%)",
        },
    ),
    DatasetSpec(
        lane="global_context",
        kind="wide_fields",
        keys={
            "world_open": "world_index:open",
            "world_high": "world_index:high",
            "world_low": "world_index:low",
            "world_close": "world_index:close",
            "world_volume": "world_index:volume",
        },
    ),
    DatasetSpec(
        lane="security_master",
        kind="table",
        keys={"security_categories": "security_categories"},
    ),
    DatasetSpec(
        lane="taxonomy_expansion",
        kind="table",
        keys={"security_industry_themes": "security_industry_themes"},
    ),
    DatasetSpec(
        lane="trading_restrictions",
        kind="table",
        keys={"trading_attention": "trading_attention"},
    ),
    DatasetSpec(
        lane="emerging_chip_diversity",
        kind="rotc_broker_aggregate",
        keys={"rotc_broker_transactions": "rotc_broker_transactions"},
    ),
]

TRADING_RESTRICTION_RETENTION_DAYS = int(os.environ.get("FINLAB_TRADING_RESTRICTION_RETENTION_DAYS", "31"))
TRADING_RESTRICTION_CLEANUP_ENABLED = str(
    os.environ.get("FINLAB_TRADING_RESTRICTION_CLEANUP_ENABLED", "0")
).strip().lower() in {"1", "true", "yes", "on"}
DEFAULT_CANONICAL_DATASETS = [
    "canonical_market_daily",
    "canonical_chip_daily",
    "canonical_institutional_amount_daily",
    "canonical_revenue_monthly",
    "canonical_broker_flow_daily",
    "finlab_taxonomy_tags",
]

OPTIONAL_NEWS_SPECS = [
    DatasetSpec(
        lane="tw_news_cnyes",
        kind="table",
        keys={"tw_news_cnyes": "tw_news_cnyes"},
    ),
]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def start_date_for_years(years: int) -> str:
    today = datetime.now(timezone.utc).date()
    return today.replace(year=today.year - years).isoformat()


def d1_request(sql: str, params: list[Any] | None = None) -> dict[str, Any]:
    proxied = controller_d1_request(sql, params)
    if proxied is not None:
        return proxied

    token = os.environ["CF_API_TOKEN"]
    account = os.environ["CF_ACCOUNT_ID"]
    db = os.environ["CF_D1_DB_ID"]
    url = f"https://api.cloudflare.com/client/v4/accounts/{account}/d1/database/{db}/query"
    body: dict[str, Any] = {"sql": sql}
    if params:
        body["params"] = params
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode("utf-8")[:500]) from exc
    if not payload.get("success"):
        raise RuntimeError(str(payload.get("errors") or payload)[:500])
    result = payload.get("result") or []
    return result[0] or {}


def controller_proxy_token() -> str:
    return (
        os.environ.get("FINLAB_CONTROLLER_TOKEN", "").strip()
        or os.environ.get("ML_CONTROLLER_TOKEN", "").strip()
        or os.environ.get("ML_CONTROLLER_SECRET", "").strip()
    )


def controller_d1_query_url() -> str:
    return (
        os.environ.get("FINLAB_CONTROLLER_D1_QUERY_URL", "").strip()
        or os.environ.get("ML_CONTROLLER_D1_QUERY_URL", "").strip()
    )


def controller_d1_batch_url() -> str:
    return (
        os.environ.get("FINLAB_CONTROLLER_D1_BATCH_URL", "").strip()
        or os.environ.get("ML_CONTROLLER_D1_BATCH_URL", "").strip()
    )


def controller_d1_proxy_configured() -> bool:
    return bool(controller_proxy_token() and controller_d1_query_url())


def controller_d1_request(sql: str, params: list[Any] | None = None) -> dict[str, Any] | None:
    url = controller_d1_query_url()
    token = controller_proxy_token()
    if not url or not token:
        return None
    body = {"sql": sql, "params": params or []}
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "X-Controller-Token": token,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(exc.read().decode("utf-8")[:800]) from exc
    if not payload.get("success"):
        raise RuntimeError(str(payload.get("errors") or payload)[:800])
    result = payload.get("result") or []
    return result[0] or {}


def controller_d1_batch_execute(
    statements: list[tuple[str, list[Any]]],
    *,
    timeout: float = 120.0,
    chunk_size: int = 250,
) -> dict[str, Any] | None:
    url = controller_d1_batch_url()
    token = controller_proxy_token()
    if not url or not token:
        return None
    chunk = max(1, min(int(chunk_size or 250), 500))
    total = 0
    success_count = 0
    error_count = 0
    changes_total = 0
    first_error: str | None = None
    for i in range(0, len(statements), chunk):
        part = statements[i:i + chunk]
        body = {
            "statements": [{"sql": sql, "params": params or []} for sql, params in part],
            "chunk_size": chunk,
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "X-Controller-Token": token,
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            raise RuntimeError(exc.read().decode("utf-8")[:800]) from exc
        if not payload.get("ok"):
            raise RuntimeError(str(payload)[:800])
        total += int(payload.get("total") or len(part))
        success_count += int(payload.get("success_count") or len(part))
        error_count += int(payload.get("error_count") or 0)
        changes_total += int(payload.get("changes_total") or 0)
        if payload.get("first_error") and first_error is None:
            first_error = str(payload["first_error"])
    return {
        "total": total,
        "success_count": success_count,
        "error_count": error_count,
        "changes_total": changes_total,
        "first_error": first_error,
        "partial_failure": error_count > 0 and success_count > 0,
        "mode": "controller_d1_batch_proxy",
        "chunk_size": chunk,
        "chunk_count": (len(statements) + chunk - 1) // chunk,
    }


def d1_query(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    return d1_request(sql, params).get("results") or []


def d1_exec(sql: str, params: list[Any] | None = None) -> dict[str, Any]:
    return d1_request(sql, params)


def d1_batch_execute(
    statements: list[tuple[str, list[Any]]],
    *,
    timeout: float = 120.0,
    chunk_size: int = 250,
) -> dict[str, Any]:
    proxied = controller_d1_batch_execute(statements, timeout=timeout, chunk_size=chunk_size)
    if proxied is not None:
        return proxied
    from services.d1_client import batch_execute

    return batch_execute(statements, timeout=timeout, chunk_size=chunk_size)


def normalize_wide_index(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(df).copy()
    out.index = pd.to_datetime(out.index, errors="coerce")
    out = out[~out.index.isna()]
    out = out.sort_index()
    out.columns = [str(col).strip() for col in out.columns]
    return out


def filter_years(df: pd.DataFrame, years: int) -> pd.DataFrame:
    start = pd.Timestamp(start_date_for_years(years))
    return df[df.index >= start]


def non_null_cells(df: pd.DataFrame) -> int:
    return int(df.notna().sum().sum())


def latest_index(df: pd.DataFrame) -> str | None:
    if df.empty:
        return None
    return str(df.index.max().date())


def write_parquet(path: Path, df: pd.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(path, compression="zstd")


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True, default=str), encoding="utf-8")


def upload_dir_to_gcs(local_dir: Path, *, bucket_name: str, prefix: str) -> dict[str, Any]:
    from google.cloud import storage

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    uploaded = 0
    bytes_total = 0
    for path in local_dir.rglob("*"):
        if not path.is_file():
            continue
        rel = path.relative_to(local_dir).as_posix()
        blob = bucket.blob(f"{prefix.rstrip('/')}/{rel}")
        blob.upload_from_filename(str(path))
        uploaded += 1
        bytes_total += path.stat().st_size
    return {
        "bucket": bucket_name,
        "prefix": prefix.rstrip("/"),
        "objects": uploaded,
        "bytes": bytes_total,
    }


def d1_counts(start: str) -> dict[str, int]:
    queries = {
        "daily_price": "SELECT COUNT(*) AS n FROM stock_prices WHERE date >= ?",
        "chip_diversity": "SELECT COUNT(*) AS n FROM chip_data WHERE date >= ?",
        "revenue": "SELECT COUNT(*) AS n FROM monthly_revenue WHERE date >= ?",
        "canonical_market_daily": "SELECT COUNT(*) AS n FROM canonical_market_daily WHERE date >= ?",
        "canonical_chip_daily": "SELECT COUNT(*) AS n FROM canonical_chip_daily WHERE date >= ?",
        "canonical_institutional_amount_daily": "SELECT COUNT(*) AS n FROM canonical_institutional_amount_daily WHERE date >= ?",
        "canonical_revenue_monthly": "SELECT COUNT(*) AS n FROM canonical_revenue_monthly WHERE revenue_month >= ?",
        "canonical_broker_flow_daily": "SELECT COUNT(*) AS n FROM canonical_broker_flow_daily WHERE date >= ?",
    }
    counts: dict[str, int] = {}
    for key, sql in queries.items():
        rows = d1_query(sql, [start])
        counts[key] = int((rows[0] if rows else {}).get("n") or 0)
    return counts


def stockvision_count_for_lane(counts: dict[str, int], lane: str) -> int:
    if lane in {"daily_price", "emerging_price_diversity", "global_context"}:
        return counts.get("daily_price", 0)
    if lane in {"chip_diversity", "emerging_chip_diversity"}:
        return counts.get("chip_diversity", 0)
    if lane == "broker_flow_diversity":
        return counts.get("canonical_broker_flow_daily", 0)
    if lane == "institutional_amount_summary":
        return counts.get("canonical_institutional_amount_daily", 0)
    if lane in {"revenue", "emerging_revenue_diversity"}:
        return counts.get("revenue", 0)
    return 0


def table_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    data = pd.DataFrame(df).copy()
    for col in data.columns:
        if pd.api.types.is_datetime64_any_dtype(data[col]):
            data[col] = data[col].astype(str)
        elif str(data[col].dtype) == "category":
            data[col] = data[col].astype(str)
    return data.to_dict(orient="records")


def _row_value(row: dict[str, Any], names: list[str]) -> Any:
    lowered = {str(k).strip().lower(): v for k, v in row.items()}
    for name in names:
        key = name.strip().lower()
        if key in lowered and pd.notna(lowered[key]):
            return lowered[key]
    return None


def _clean_symbol(value: Any, row: dict[str, Any] | None = None) -> str:
    import re

    text = str(value or "").strip()
    match = re.search(r"\b(\d{4,6})\b", text)
    if match:
        return match.group(1)
    if row:
        joined = " ".join(str(v) for v in row.values() if pd.notna(v))
        match = re.search(r"\b(\d{4,6})\b", joined)
        if match:
            return match.group(1)
    return ""


def _clean_date(value: Any, fallback: str) -> str:
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return fallback
    return str(parsed.date())


def _add_days(value: str, days: int) -> str:
    parsed = datetime.fromisoformat(value)
    return (parsed + timedelta(days=days)).date().isoformat()


def _source_url(value: Any, fallback: str) -> str:
    text = str(value or "").strip()
    if text.startswith("http://") or text.startswith("https://"):
        return text
    return fallback


def _first_existing_column(frame: pd.DataFrame, candidates: tuple[str, ...]) -> str | None:
    columns = [str(col) for col in frame.columns]
    lowered = {col.lower(): col for col in columns}
    for candidate in candidates:
        direct = lowered.get(candidate.lower())
        if direct:
            return direct
    for col in columns:
        text = col.lower()
        if any(candidate.lower() in text for candidate in candidates):
            return col
    return None


def normalize_broker_transactions_daily(frame: pd.DataFrame, start: str) -> pd.DataFrame:
    """Normalize FinLab broker_transactions into daily symbol broker-flow evidence."""
    if frame.empty:
        return pd.DataFrame()
    date_col = _first_existing_column(frame, ("date", "日期", "trade_date"))
    stock_col = _first_existing_column(frame, ("stock_id", "symbol", "股票代號", "證券代號"))
    broker_col = _first_existing_column(frame, ("broker", "broker_code", "securities_broker", "分點", "券商", "證券商"))
    buy_col = _first_existing_column(frame, ("buy_shares", "buy_volume", "buy_qty", "buy", "買進股數", "買進張數"))
    sell_col = _first_existing_column(frame, ("sell_shares", "sell_volume", "sell_qty", "sell", "賣出股數", "賣出張數"))
    if not date_col or not stock_col or not buy_col or not sell_col:
        missing = {
            "date": not bool(date_col),
            "stock_id": not bool(stock_col),
            "buy_shares": not bool(buy_col),
            "sell_shares": not bool(sell_col),
        }
        print(f"[finlab-backfill] broker_transactions schema unsupported missing={missing} columns={list(frame.columns)[:12]}", flush=True)
        return pd.DataFrame()

    out = frame.copy()
    out["date"] = pd.to_datetime(out[date_col], errors="coerce")
    out = out[out["date"] >= pd.Timestamp(start)]
    out["stock_id"] = [
        _clean_symbol(row.get(stock_col), row)
        for row in out.to_dict(orient="records")
    ]
    out["broker_code"] = out[broker_col].astype(str).str.strip() if broker_col else "unknown"
    out["buy_shares_raw"] = pd.to_numeric(out[buy_col], errors="coerce").fillna(0)
    out["sell_shares_raw"] = pd.to_numeric(out[sell_col], errors="coerce").fillna(0)
    out["broker_net"] = out["buy_shares_raw"] - out["sell_shares_raw"]
    out = out[(out["stock_id"] != "") & out["date"].notna()]
    if out.empty:
        return pd.DataFrame()

    broker_daily = out.groupby(["date", "stock_id", "broker_code"], observed=True).agg(
        broker_buy_shares=("buy_shares_raw", "sum"),
        broker_sell_shares=("sell_shares_raw", "sum"),
        broker_net=("broker_net", "sum"),
    ).reset_index()
    broker_daily["abs_broker_net"] = broker_daily["broker_net"].abs()
    dominant = (
        broker_daily.sort_values(["date", "stock_id", "abs_broker_net"], ascending=[True, True, False])
        .groupby(["date", "stock_id"], observed=True)
        .head(1)[["date", "stock_id", "broker_code", "broker_net", "abs_broker_net"]]
        .rename(columns={
            "broker_code": "dominant_broker_code",
            "broker_net": "dominant_net_shares",
            "abs_broker_net": "dominant_abs_net_shares",
        })
    )
    pressure = broker_daily.groupby(["date", "stock_id"], observed=True).agg(
        gross_imbalance_shares=("abs_broker_net", "sum"),
        directional_broker_count=("abs_broker_net", lambda values: int((values > 0).sum())),
    ).reset_index()
    grouped = out.groupby(["date", "stock_id"], observed=True).agg(
        buy_shares=("buy_shares_raw", "sum"),
        sell_shares=("sell_shares_raw", "sum"),
        broker_count=("broker_code", "nunique"),
    ).reset_index()
    grouped = grouped.merge(dominant, on=["date", "stock_id"], how="left").merge(pressure, on=["date", "stock_id"], how="left")
    grouped["buy_sell_net"] = grouped["dominant_net_shares"].fillna(0)
    grouped["source"] = "finlab.broker_transactions"
    grouped["market_segment"] = "LISTED_OTC"
    return grouped


def materialize_specs(*, years: int, run_dir: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from finlab import data, login

    api_key = os.environ["FINLAB_API_KEY"]
    login(api_key)
    start = start_date_for_years(years)
    counts = d1_counts(start)
    dataset_summaries: list[dict[str, Any]] = []
    diff_reports: list[dict[str, Any]] = []

    specs = list(CORE_SPECS)
    if os.environ.get("INCLUDE_FINLAB_CNYES_NEWS", "0").lower() in {"1", "true", "yes"}:
        specs.extend(OPTIONAL_NEWS_SPECS)

    for spec in specs:
        t0 = time.time()
        print(f"[finlab-backfill] start lane={spec.lane} kind={spec.kind}", flush=True)
        lane_dir = run_dir / "raw" / spec.lane
        artifacts: list[dict[str, Any]] = []
        finlab_rows = 0
        latest = None
        schema_fields: list[str] = []

        if spec.kind == "wide_fields":
            for field, api_key_name in spec.keys.items():
                frame = filter_years(normalize_wide_index(data.get(api_key_name)), years)
                finlab_rows = max(finlab_rows, int(frame.notna().any(axis=1).sum() * frame.shape[1]))
                latest = max([x for x in [latest, latest_index(frame)] if x], default=None)
                schema_fields.append(field)
                path = lane_dir / f"{field}.parquet"
                write_parquet(path, frame)
                artifacts.append({"field": field, "api_key": api_key_name, "path": str(path), "shape": list(frame.shape), "non_null_cells": non_null_cells(frame)})
        elif spec.kind == "table":
            frame = pd.DataFrame(data.get(next(iter(spec.keys.values()))))
            path = lane_dir / "table.parquet"
            write_parquet(path, frame)
            finlab_rows = int(len(frame))
            latest = utc_now()
            schema_fields = [str(col) for col in frame.columns]
            artifacts.append({"field": next(iter(spec.keys)), "api_key": next(iter(spec.keys.values())), "path": str(path), "shape": list(frame.shape)})
        elif spec.kind == "broker_aggregate":
            frame = pd.DataFrame(data.get("broker_transactions"))
            grouped = normalize_broker_transactions_daily(frame, start)
            path = lane_dir / "broker_daily.parquet"
            write_parquet(path, grouped)
            finlab_rows = int(len(grouped))
            latest = str(grouped["date"].max().date()) if len(grouped) and "date" in grouped.columns else None
            schema_fields = [
                "buy_shares",
                "sell_shares",
                "buy_sell_net",
                "broker_count",
                "dominant_broker_code",
                "dominant_net_shares",
                "dominant_abs_net_shares",
                "gross_imbalance_shares",
                "directional_broker_count",
                "source",
                "market_segment",
            ]
            artifacts.append({"field": "broker_daily", "api_key": "broker_transactions", "path": str(path), "shape": list(grouped.shape)})
        elif spec.kind == "rotc_broker_aggregate":
            frame = pd.DataFrame(data.get("rotc_broker_transactions"))
            frame["date"] = pd.to_datetime(frame["date"], errors="coerce")
            frame = frame[frame["date"] >= pd.Timestamp(start)]
            frame["buy_shares_raw"] = pd.to_numeric(frame["買進股數"], errors="coerce").fillna(0)
            frame["sell_shares_raw"] = pd.to_numeric(frame["賣出股數"], errors="coerce").fillna(0)
            frame["broker_net"] = frame["buy_shares_raw"] - frame["sell_shares_raw"]
            broker_daily = frame.groupby(["date", "stock_id", "證券商代號"], observed=True).agg(
                broker_buy_shares=("buy_shares_raw", "sum"),
                broker_sell_shares=("sell_shares_raw", "sum"),
                broker_net=("broker_net", "sum"),
            ).reset_index()
            broker_daily["abs_broker_net"] = broker_daily["broker_net"].abs()
            dominant = (
                broker_daily.sort_values(["date", "stock_id", "abs_broker_net"], ascending=[True, True, False])
                .groupby(["date", "stock_id"], observed=True)
                .head(1)[["date", "stock_id", "證券商代號", "broker_net", "abs_broker_net"]]
                .rename(columns={
                    "證券商代號": "dominant_broker_code",
                    "broker_net": "dominant_net_shares",
                    "abs_broker_net": "dominant_abs_net_shares",
                })
            )
            pressure = broker_daily.groupby(["date", "stock_id"], observed=True).agg(
                gross_imbalance_shares=("abs_broker_net", "sum"),
                directional_broker_count=("abs_broker_net", lambda values: int((values > 0).sum())),
            ).reset_index()
            grouped = frame.groupby(["date", "stock_id"], observed=True).agg(
                buy_shares=("buy_shares_raw", "sum"),
                sell_shares=("sell_shares_raw", "sum"),
                broker_count=("證券商代號", "nunique"),
            ).reset_index()
            grouped = grouped.merge(dominant, on=["date", "stock_id"], how="left").merge(pressure, on=["date", "stock_id"], how="left")
            # Backward-compatible field consumed by older previews. The all-broker
            # net is always zero by market mechanics, so V4.1 uses the dominant
            # broker imbalance as the signed proxy instead.
            grouped["buy_sell_net"] = grouped["dominant_net_shares"].fillna(0)
            path = lane_dir / "rotc_broker_daily.parquet"
            write_parquet(path, grouped)
            finlab_rows = int(len(grouped))
            latest = str(grouped["date"].max().date()) if len(grouped) else None
            schema_fields = [
                "buy_shares",
                "sell_shares",
                "buy_sell_net",
                "broker_count",
                "dominant_broker_code",
                "dominant_net_shares",
                "dominant_abs_net_shares",
                "gross_imbalance_shares",
                "directional_broker_count",
            ]
            artifacts.append({"field": "rotc_broker_daily", "api_key": "rotc_broker_transactions", "path": str(path), "shape": list(grouped.shape)})
        else:
            raise ValueError(f"unsupported spec kind: {spec.kind}")

        stockvision_rows = stockvision_count_for_lane(counts, spec.lane)
        missing = max(finlab_rows - stockvision_rows, 0)
        conflicts = 0
        diff = {
            "schema_version": "finlab-remote-diff-aggregate-v1",
            "run_id": run_dir.name,
            "dataset_lane": spec.lane,
            "source": "finlab",
            "generated_at": utc_now(),
            "primary_keys": ["stock_id", "date"],
            "compare_fields": schema_fields,
            "aggregate_diff": True,
            "summary": {
                "finlab_rows": finlab_rows,
                "stockvision_rows": stockvision_rows,
                "matched": min(finlab_rows, stockvision_rows),
                "missing_in_stockvision": missing,
                "missing_in_finlab": max(stockvision_rows - finlab_rows, 0),
                "value_conflicts": conflicts,
                "schema_extra_fields": schema_fields,
            },
        }
        diff_reports.append(diff)
        dataset_summaries.append({
            "lane": spec.lane,
            "kind": spec.kind,
            "finlab_rows": finlab_rows,
            "stockvision_rows": stockvision_rows,
            "latest": latest,
            "seconds": round(time.time() - t0, 2),
            "artifacts": artifacts,
        })
        write_json(run_dir / "diff" / f"{spec.lane}.json", diff)
        print(
            f"[finlab-backfill] done lane={spec.lane} rows={finlab_rows} latest={latest} seconds={round(time.time() - t0, 2)}",
            flush=True,
        )

    return dataset_summaries, diff_reports


def insert_d1_summary(manifest: dict[str, Any]) -> None:
    run_id = manifest["run_id"]
    generated_at = manifest["generated_at"]
    summary = manifest["summary"]
    d1_exec(
        """
        INSERT OR REPLACE INTO finlab_backfill_runs (
          run_id, generated_at, lookback_years, dataset_count, finlab_rows,
          gap_fill_rows, value_conflicts, checksum, status, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            run_id,
            generated_at,
            manifest["lookback_years"],
            summary["dataset_count"],
            summary["finlab_rows"],
            summary["gap_fill_rows"],
            summary["value_conflicts"],
            manifest["checksum"],
            "ready",
            json.dumps({"artifact_root": manifest["artifact_root"], "mode": manifest["mode"]}, ensure_ascii=False, sort_keys=True),
        ],
    )

    for diff in manifest["diff_reports"]:
        diff_summary = diff["summary"]
        d1_exec(
            """
            INSERT INTO source_diff_report (
              run_id, dataset_lane, source, generated_at, finlab_rows, stockvision_rows,
              matched_rows, missing_in_stockvision, missing_in_finlab, value_conflicts,
              schema_extra_fields, report_json, checksum
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [
                run_id,
                diff["dataset_lane"],
                "finlab",
                diff["generated_at"],
                diff_summary["finlab_rows"],
                diff_summary["stockvision_rows"],
                diff_summary["matched"],
                diff_summary["missing_in_stockvision"],
                diff_summary["missing_in_finlab"],
                diff_summary["value_conflicts"],
                json.dumps(diff_summary["schema_extra_fields"], ensure_ascii=False),
                json.dumps(diff, ensure_ascii=False, sort_keys=True, default=str),
                f"{run_id}:{diff['dataset_lane']}",
            ],
        )
        d1_exec(
            """
            INSERT INTO source_quality_metrics (
              source, dataset, as_of_date, freshness_status, missing_rate, duplicate_rate,
              schema_drift_status, entity_link_confidence, latest_materialization, metrics_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, dataset, as_of_date) DO UPDATE SET
              freshness_status=excluded.freshness_status,
              missing_rate=excluded.missing_rate,
              duplicate_rate=excluded.duplicate_rate,
              schema_drift_status=excluded.schema_drift_status,
              entity_link_confidence=excluded.entity_link_confidence,
              latest_materialization=excluded.latest_materialization,
              metrics_json=excluded.metrics_json
            """,
            [
                "finlab",
                diff["dataset_lane"],
                generated_at[:10],
                "ok",
                0.0 if diff_summary["finlab_rows"] else 1.0,
                0.0,
                "aggregate_diff",
                0.95,
                generated_at,
                json.dumps(diff_summary, ensure_ascii=False, sort_keys=True),
            ],
        )
        if diff_summary["missing_in_stockvision"] > 0:
            d1_exec(
                """
                INSERT INTO gap_fill_candidates (
                  run_id, dataset_lane, canonical_table, stock_id, symbol, date, market_segment,
                  field, finlab_value, stockvision_value, source, lineage_json, decision, generated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    run_id,
                    diff["dataset_lane"],
                    canonical_table_for_lane(diff["dataset_lane"]),
                    None,
                    None,
                    generated_at[:10],
                    None,
                    "__aggregate_missing_rows__",
                    str(diff_summary["missing_in_stockvision"]),
                    str(diff_summary["stockvision_rows"]),
                    "finlab",
                    json.dumps({"aggregate_diff": True, "run_id": run_id, "dataset_lane": diff["dataset_lane"]}, ensure_ascii=False),
                    "candidate",
                    generated_at,
                ],
            )


def _artifact_path(manifest: dict[str, Any], lane: str) -> Path | None:
    for dataset in manifest.get("datasets") or []:
        if dataset.get("lane") != lane:
            continue
        artifacts = dataset.get("artifacts") or []
        if not artifacts:
            return None
        path = artifacts[0].get("path")
        return Path(path) if path else None
    return None


def insert_finlab_trading_restrictions(
    manifest: dict[str, Any],
    *,
    lookback_days: int = TRADING_RESTRICTION_RETENTION_DAYS,
    max_rows: int = 1200,
) -> int:
    path = _artifact_path(manifest, "trading_restrictions")
    if not path or not path.exists():
        return 0
    generated_date = str(manifest.get("generated_at") or utc_now())[:10]
    cutoff = (datetime.fromisoformat(generated_date) - timedelta(days=lookback_days)).date().isoformat()
    rows = pd.read_parquet(path).to_dict(orient="records")
    prepared: list[tuple[str, dict[str, Any]]] = []
    for row in rows:
        source_date = _clean_date(_row_value(row, ["date", "日期", "公布日期", "created_at", "updated_at"]), generated_date)
        if source_date < cutoff:
            continue
        prepared.append((source_date, row))
    prepared.sort(key=lambda item: item[0], reverse=True)

    batch_sql = """
        INSERT INTO canonical_trading_restrictions (
          symbol, restriction_type, market_segment, start_date, end_date, source,
          source_date, title, source_url, lineage_json, active, updated_at
        )
        VALUES (?, ?, NULL, ?, ?, 'finlab.trading_attention', ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(symbol, restriction_type, source, source_date) DO UPDATE SET
          title=excluded.title,
          end_date=excluded.end_date,
          source_url=excluded.source_url,
          lineage_json=excluded.lineage_json,
          active=excluded.active,
          updated_at=CURRENT_TIMESTAMP
    """.strip()
    batch_statements: list[tuple[str, list[Any]]] = []
    for source_date, row in prepared[:max_rows]:
        symbol = _clean_symbol(_row_value(row, ["stock_id", "symbol", "code"]), row)
        if not symbol:
            continue
        raw_type = str(_row_value(row, ["type", "restriction_type"]) or "attention")
        restriction_type = "disposition" if any(word in raw_type.lower() for word in ["punish", "disposition"]) else "attention"
        title = str(_row_value(row, ["title", "name", "reason"]) or f"{restriction_type}:{symbol}")[:240]
        url = _source_url(_row_value(row, ["url", "source_url", "link"]), "https://www.finlab.tw/")
        end_date = _add_days(source_date, lookback_days)
        batch_statements.append((batch_sql, [
            symbol,
            restriction_type,
            source_date,
            end_date,
            source_date,
            title,
            url,
            json.dumps({"schema_version": "finlab-trading-attention-v1", "run_id": manifest["run_id"], "raw": row}, ensure_ascii=False, default=str),
        ]))
    if batch_statements:
        d1_batch_execute(batch_statements, timeout=120.0, chunk_size=250)
    return len(batch_statements)

    inserted = 0
    for source_date, row in prepared[:max_rows]:
        symbol = _clean_symbol(_row_value(row, ["stock_id", "symbol", "證券代號", "股票代號", "code"]), row)
        if not symbol:
            continue
        raw_type = str(_row_value(row, ["type", "restriction_type", "類別", "處置類別", "注意處置"]) or "attention")
        restriction_type = "disposition" if any(word in raw_type for word in ["處置", "punish", "disposition"]) else "attention"
        title = str(_row_value(row, ["title", "name", "股票名稱", "證券名稱", "說明", "reason"]) or f"{restriction_type}:{symbol}")[:240]
        url = _source_url(_row_value(row, ["url", "source_url", "link"]), "https://www.finlab.tw/")
        end_date = _add_days(source_date, lookback_days)
        d1_exec(
            """
            INSERT INTO canonical_trading_restrictions (
              symbol, restriction_type, market_segment, start_date, end_date, source,
              source_date, title, source_url, lineage_json, active, updated_at
            )
            VALUES (?, ?, NULL, ?, ?, 'finlab.trading_attention', ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
            ON CONFLICT(symbol, restriction_type, source, source_date) DO UPDATE SET
              title=excluded.title,
              end_date=excluded.end_date,
              source_url=excluded.source_url,
              lineage_json=excluded.lineage_json,
              active=excluded.active,
              updated_at=CURRENT_TIMESTAMP
            """,
            [
                symbol,
                restriction_type,
                source_date,
                end_date,
                source_date,
                title,
                url,
                json.dumps({"schema_version": "finlab-trading-attention-v1", "run_id": manifest["run_id"], "raw": row}, ensure_ascii=False, default=str),
            ],
        )
        inserted += 1
    return inserted


def cleanup_finlab_trading_restrictions(*, retention_days: int = TRADING_RESTRICTION_RETENTION_DAYS) -> int:
    if not TRADING_RESTRICTION_CLEANUP_ENABLED:
        return 0
    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).date().isoformat()
    result = d1_exec(
        """
        DELETE FROM canonical_trading_restrictions
         WHERE source = 'finlab.trading_attention'
           AND source_date < ?
        """,
        [cutoff],
    )
    return int((result or {}).get("meta", {}).get("changes") or 0)


def insert_finlab_cnyes_evidence(manifest: dict[str, Any], *, max_rows: int = 800) -> int:
    path = _artifact_path(manifest, "tw_news_cnyes")
    if not path or not path.exists():
        return 0
    generated_date = str(manifest.get("generated_at") or utc_now())[:10]
    frame = pd.read_parquet(path)
    if frame.empty:
        return 0
    records = table_rows(frame)
    records.sort(
        key=lambda row: str(_row_value(row, ["published_at", "date", "日期", "time", "datetime"]) or ""),
        reverse=True,
    )
    batch_sql = """
        INSERT INTO external_evidence_items (
          source_id, source_kind, title, published_at, source_url, symbols_json, themes_json,
          allowed_use, decision_effect, source_quality_score, entity_linking_confidence,
          spam_filter_status, accepted, packet_checksum, raw_json
        )
        SELECT 'anue', 'finlab_tw_news_cnyes', ?, ?, ?, ?, '[]',
               'theme_context', 'theme_context', 0.86, ?, 'clean', 1, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM external_evidence_items
           WHERE source_id='anue' AND source_url=? AND published_at=?
        )
    """.strip()
    batch_statements: list[tuple[str, list[Any]]] = []
    for row in records[:max_rows]:
        symbol = _clean_symbol(_row_value(row, ["stock_id", "symbol", "code"]), row)
        title = str(_row_value(row, ["title", "headline", "name"]) or "").strip()
        url = _source_url(_row_value(row, ["url", "source_url", "link"]), "")
        published_at = _clean_date(_row_value(row, ["published_at", "date", "time", "datetime"]), generated_date)
        if not title or not url:
            continue
        symbols_json = json.dumps([symbol], ensure_ascii=False) if symbol else json.dumps([], ensure_ascii=False)
        batch_statements.append((batch_sql, [
            title[:240],
            published_at,
            url,
            symbols_json,
            0.9 if symbol else 0.35,
            f"finlab_tw_news_cnyes:{manifest['run_id']}:{url}:{published_at}",
            json.dumps({"schema_version": "finlab-cnyes-news-v1", "run_id": manifest["run_id"], "raw": row}, ensure_ascii=False, default=str),
            url,
            published_at,
        ]))
    if batch_statements:
        d1_batch_execute(batch_statements, timeout=120.0, chunk_size=250)
    return len(batch_statements)

    inserted = 0
    for row in records[:max_rows]:
        symbol = _clean_symbol(_row_value(row, ["stock_id", "symbol", "股票代號", "code"]), row)
        title = str(_row_value(row, ["title", "標題", "headline", "name"]) or "").strip()
        url = _source_url(_row_value(row, ["url", "source_url", "link", "連結"]), "")
        published_at = _clean_date(_row_value(row, ["published_at", "date", "日期", "time", "datetime"]), generated_date)
        if not title or not url:
            continue
        symbols_json = json.dumps([symbol], ensure_ascii=False) if symbol else json.dumps([], ensure_ascii=False)
        d1_exec(
            """
            INSERT INTO external_evidence_items (
              source_id, source_kind, title, published_at, source_url, symbols_json, themes_json,
              allowed_use, decision_effect, source_quality_score, entity_linking_confidence,
              spam_filter_status, accepted, packet_checksum, raw_json
            )
            SELECT 'anue', 'finlab_tw_news_cnyes', ?, ?, ?, ?, '[]',
                   'theme_context', 'theme_context', 0.86, ?, 'clean', 1, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM external_evidence_items
               WHERE source_id='anue' AND source_url=? AND published_at=?
            )
            """,
            [
                title[:240],
                published_at,
                url,
                symbols_json,
                0.9 if symbol else 0.35,
                f"finlab_tw_news_cnyes:{manifest['run_id']}:{url}:{published_at}",
                json.dumps({"schema_version": "finlab-cnyes-news-v1", "run_id": manifest["run_id"], "raw": row}, ensure_ascii=False, default=str),
                url,
                published_at,
            ],
        )
        inserted += 1
    return inserted


def insert_finlab_runtime_tables(manifest: dict[str, Any]) -> dict[str, int]:
    return {
        "canonical_trading_restrictions": insert_finlab_trading_restrictions(manifest),
        "canonical_trading_restrictions_deleted_old": cleanup_finlab_trading_restrictions(),
        "external_evidence_items": insert_finlab_cnyes_evidence(manifest),
    }


def parse_canonical_datasets(raw: str | None) -> list[str]:
    if not raw:
        return list(DEFAULT_CANONICAL_DATASETS)
    values = [item.strip() for item in raw.split(",") if item.strip()]
    return values or list(DEFAULT_CANONICAL_DATASETS)


def default_canonical_window(*, generated_at: str, window_days: int) -> tuple[str, str]:
    end = datetime.fromisoformat(generated_at).date()
    start = end - timedelta(days=max(0, window_days))
    return start.isoformat(), end.isoformat()


def materialize_canonical_to_d1(
    manifest: dict[str, Any],
    *,
    start_date: str | None,
    end_date: str | None,
    datasets: list[str],
    limit_per_dataset: int | None = None,
    chunk_size: int = 250,
    dry_run: bool = False,
) -> dict[str, Any]:
    from services.finlab_canonical_materializer import build_d1_upsert_statements, materialize_finlab_canonical_outputs

    outputs = materialize_finlab_canonical_outputs(
        manifest["artifact_root"],
        run_id=manifest["run_id"],
        generated_at=manifest["generated_at"],
        start_date=start_date,
        end_date=end_date,
        limit_per_dataset=limit_per_dataset,
        datasets=datasets,
    )
    statements = build_d1_upsert_statements(outputs)
    apply_result = {"total": len(statements), "success_count": 0, "error_count": 0, "changes_total": 0, "dry_run": True}
    if not dry_run and statements:
        apply_result = controller_d1_batch_execute(statements, timeout=120.0, chunk_size=chunk_size)
        if apply_result is None:
            from services.d1_client import batch_execute

            apply_result = batch_execute(statements, timeout=120.0, chunk_size=chunk_size)
    return {
        "schema_version": "finlab-canonical-d1-apply-v1",
        "run_id": manifest["run_id"],
        "generated_at": manifest["generated_at"],
        "artifact_root": manifest["artifact_root"],
        "start_date": start_date,
        "end_date": end_date,
        "datasets": datasets,
        "row_counts": outputs.manifest.get("row_counts", {}),
        "statement_count": len(statements),
        "apply_result": apply_result,
        "checksum": outputs.manifest.get("checksum"),
    }


def canonical_table_for_lane(lane: str) -> str:
    if "price" in lane or lane == "global_context":
        return "canonical_market_daily"
    if "chip" in lane:
        return "canonical_chip_daily"
    if "revenue" in lane:
        return "canonical_revenue_monthly"
    return "data_source_inventory"


def checksum_manifest(payload: dict[str, Any]) -> str:
    import hashlib

    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run FinLab V4 remote backfill and D1 summary writeback.")
    parser.add_argument("--years", type=int, choices=[3, 5], required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--output-dir", default=str(ROOT / "data" / "finlab_remote_backfill"))
    parser.add_argument("--write-d1", action="store_true")
    parser.add_argument("--gcs-bucket", default=os.environ.get("GCS_BUCKET_NAME", ""))
    parser.add_argument("--gcs-prefix", default="finlab/v4/backfill")
    parser.add_argument("--apply-canonical-d1", action="store_true", help="Materialize row-level canonical tables from this run and upsert them to D1.")
    parser.add_argument("--canonical-start-date", default="", help="Inclusive canonical materialization start date. Defaults to generated_at - window days.")
    parser.add_argument("--canonical-end-date", default="", help="Inclusive canonical materialization end date. Defaults to generated_at date.")
    parser.add_argument("--canonical-window-days", type=int, default=7, help="Daily incremental canonical window when explicit dates are omitted.")
    parser.add_argument("--canonical-datasets", default=",".join(DEFAULT_CANONICAL_DATASETS), help="Comma-separated canonical output datasets.")
    parser.add_argument("--canonical-limit-per-dataset", type=int, default=0)
    parser.add_argument("--canonical-d1-chunk-size", type=int, default=250)
    parser.add_argument("--canonical-dry-run", action="store_true")
    args = parser.parse_args()

    required_env = ["FINLAB_API_KEY"]
    if not controller_d1_proxy_configured():
        required_env.extend(["CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"])
    missing = [key for key in required_env if not os.environ.get(key)]
    if missing:
        raise SystemExit(f"missing env vars: {','.join(missing)}")

    run_id = args.run_id
    if run_id == "auto":
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        run_id = f"finlab-v4-{args.years}y-{stamp}"

    run_dir = Path(args.output_dir) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    generated_at = utc_now()
    dataset_summaries, diff_reports = materialize_specs(years=args.years, run_dir=run_dir)
    summary = {
        "dataset_count": len(dataset_summaries),
        "finlab_rows": sum(int(item["finlab_rows"]) for item in dataset_summaries),
        "gap_fill_rows": sum(1 for item in diff_reports if item["summary"]["missing_in_stockvision"] > 0),
        "value_conflicts": sum(int(item["summary"]["value_conflicts"]) for item in diff_reports),
        "missing_in_stockvision": sum(int(item["summary"]["missing_in_stockvision"]) for item in diff_reports),
    }
    manifest = {
        "schema_version": "finlab-v4-remote-backfill-v1",
        "run_id": run_id,
        "generated_at": generated_at,
        "lookback_years": args.years,
        "mode": "remote_summary_writeback_full_artifacts",
        "artifact_root": str(run_dir),
        "summary": summary,
        "datasets": dataset_summaries,
        "diff_reports": diff_reports,
    }
    manifest["checksum"] = checksum_manifest({"run_id": run_id, "summary": summary, "datasets": dataset_summaries})
    write_json(run_dir / "manifest.json", manifest)

    if args.gcs_bucket:
        gcs = upload_dir_to_gcs(
            run_dir,
            bucket_name=args.gcs_bucket,
            prefix=f"{args.gcs_prefix.rstrip('/')}/{run_id}",
        )
        manifest["gcs_upload"] = gcs
        write_json(run_dir / "manifest.json", manifest)

    if args.write_d1:
        insert_d1_summary(manifest)
        print("[finlab-backfill] runtime_table_writeback start", file=sys.stderr, flush=True)
        manifest["runtime_table_writeback"] = insert_finlab_runtime_tables(manifest)
        print("[finlab-backfill] runtime_table_writeback done", file=sys.stderr, flush=True)
        if args.apply_canonical_d1:
            default_start, default_end = default_canonical_window(
                generated_at=generated_at,
                window_days=args.canonical_window_days,
            )
            print("[finlab-backfill] canonical_d1_apply start", file=sys.stderr, flush=True)
            manifest["canonical_d1_apply"] = materialize_canonical_to_d1(
                manifest,
                start_date=args.canonical_start_date or default_start,
                end_date=args.canonical_end_date or default_end,
                datasets=parse_canonical_datasets(args.canonical_datasets),
                limit_per_dataset=args.canonical_limit_per_dataset or None,
                chunk_size=args.canonical_d1_chunk_size,
                dry_run=args.canonical_dry_run,
            )
            print("[finlab-backfill] canonical_d1_apply done", file=sys.stderr, flush=True)
        write_json(run_dir / "manifest.json", manifest)

    print(json.dumps({
        "run_id": run_id,
        "years": args.years,
        "summary": summary,
        "artifact_root": str(run_dir),
        "gcs_upload": manifest.get("gcs_upload"),
        "runtime_table_writeback": manifest.get("runtime_table_writeback"),
        "canonical_d1_apply": manifest.get("canonical_d1_apply"),
    }, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
