from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SYMBOLS = ["00981A", "00631L", "00403A"]
PRICE_KEYS = {
    "open": "price:開盤價",
    "high": "price:最高價",
    "low": "price:最低價",
    "close": "price:收盤價",
    "volume": "price:成交股數",
    "value": "price:成交金額",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"missing env {name}")
    return value


def d1_query(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    token = require_env("CF_API_TOKEN")
    account = require_env("CF_ACCOUNT_ID")
    db = require_env("CF_D1_DB_ID")
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
        raise RuntimeError(exc.read().decode("utf-8")[:800]) from exc
    if not payload.get("success"):
        raise RuntimeError(str(payload.get("errors") or payload)[:800])
    result = payload.get("result") or []
    return (result[0] or {}).get("results") or []


def d1_exec(sql: str, params: list[Any] | None = None) -> None:
    d1_query(sql, params)


def login_finlab() -> None:
    from finlab import login

    login(require_env("FINLAB_API_KEY"))


def get_finlab_wide(key: str) -> pd.DataFrame:
    from finlab import data

    df = pd.DataFrame(data.get(key)).copy()
    df.index = pd.to_datetime(df.index, errors="coerce")
    df = df[~df.index.isna()].sort_index()
    df.columns = [str(col).strip() for col in df.columns]
    return df


def load_price_rows(symbols: list[str], days: int) -> list[dict[str, Any]]:
    start = (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()
    frames = {field: get_finlab_wide(key) for field, key in PRICE_KEYS.items()}
    rows: list[dict[str, Any]] = []
    for symbol in symbols:
        if symbol not in frames["close"].columns:
            print(f"[skip] {symbol} missing in FinLab price:收盤價")
            continue
        close_series = frames["close"][symbol].dropna()
        close_series = close_series[close_series.index.strftime("%Y-%m-%d") >= start]
        for ts, _close in close_series.items():
            date = pd.Timestamp(ts).strftime("%Y-%m-%d")
            row = {"symbol": symbol, "date": date}
            for field, frame in frames.items():
                value = frame.at[ts, symbol] if symbol in frame.columns and ts in frame.index else None
                row[field] = None if pd.isna(value) else float(value)
            if row.get("close") is not None:
                rows.append(row)
    return rows


def ensure_stock(symbol: str) -> int:
    existing = d1_query("SELECT id FROM stocks WHERE symbol = ? ORDER BY id LIMIT 1", [symbol])
    if existing:
        return int(existing[0]["id"])
    d1_exec(
        "INSERT INTO stocks (symbol, name, market, sector, in_current_watchlist, source, added_at, updated_at) "
        "VALUES (?, ?, 'TWSE', 'ETF', 0, 'finlab.paper_benchmark', datetime('now'), datetime('now'))",
        [symbol, symbol],
    )
    created = d1_query("SELECT id FROM stocks WHERE symbol = ? ORDER BY id DESC LIMIT 1", [symbol])
    if not created:
        raise RuntimeError(f"failed to create stock row for {symbol}")
    return int(created[0]["id"])


def chunked(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def sql_quote(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def write_sql_file(rows: list[dict[str, Any]], path: Path) -> dict[str, int]:
    path.parent.mkdir(parents=True, exist_ok=True)
    as_of = datetime.now(timezone.utc).date().isoformat()
    lineage = json.dumps({"source": "finlab.price", "job": "paper_benchmark_backfill", "generated_at": utc_now()}, ensure_ascii=False)
    lines: list[str] = []
    for symbol in sorted({row["symbol"] for row in rows}):
        lines.append(
            "INSERT INTO stocks (symbol, name, market, sector, in_current_watchlist, source, added_at, updated_at) "
            f"SELECT {sql_quote(symbol)}, {sql_quote(symbol)}, 'TWSE', 'ETF', 0, 'finlab.paper_benchmark', datetime('now'), datetime('now') "
            f"WHERE NOT EXISTS (SELECT 1 FROM stocks WHERE symbol = {sql_quote(symbol)});"
        )
    for row in rows:
        avg_price = (row.get("value") / row.get("volume")) if row.get("value") and row.get("volume") else row.get("close")
        lines.append(
            "INSERT OR REPLACE INTO stock_prices "
            "(stock_id, date, open, high, low, close, adj_close, volume, avg_price) VALUES ("
            f"(SELECT id FROM stocks WHERE symbol = {sql_quote(row['symbol'])} ORDER BY id DESC LIMIT 1), "
            f"{sql_quote(row['date'])}, {sql_quote(row.get('open'))}, {sql_quote(row.get('high'))}, "
            f"{sql_quote(row.get('low'))}, {sql_quote(row.get('close'))}, {sql_quote(row.get('close'))}, "
            f"{sql_quote(int(row['volume']) if row.get('volume') is not None else None)}, {sql_quote(avg_price)});"
        )
        lines.append(
            "INSERT INTO canonical_market_daily "
            "(stock_id, date, market_segment, open, high, low, close, volume, value, source, lineage_json, as_of_date) VALUES ("
            f"{sql_quote(row['symbol'])}, {sql_quote(row['date'])}, 'ETF', {sql_quote(row.get('open'))}, "
            f"{sql_quote(row.get('high'))}, {sql_quote(row.get('low'))}, {sql_quote(row.get('close'))}, "
            f"{sql_quote(row.get('volume'))}, {sql_quote(row.get('value'))}, 'finlab.price.paper_benchmark', "
            f"{sql_quote(lineage)}, {sql_quote(as_of)}) "
            "ON CONFLICT(stock_id, date, source) DO UPDATE SET "
            "open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, "
            "volume=excluded.volume, value=excluded.value, lineage_json=excluded.lineage_json, as_of_date=excluded.as_of_date;"
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return {"sql_statements": len(lines), "rows": len(rows)}


def upsert_prices(rows: list[dict[str, Any]]) -> dict[str, int]:
    by_symbol = {symbol: ensure_stock(symbol) for symbol in sorted({row["symbol"] for row in rows})}
    inserted_stock_prices = 0
    inserted_canonical = 0
    as_of = datetime.now(timezone.utc).date().isoformat()
    lineage = json.dumps({"source": "finlab.price", "job": "paper_benchmark_backfill", "generated_at": utc_now()}, ensure_ascii=False)

    for batch in chunked(rows, 25):
        values = []
        params: list[Any] = []
        for row in batch:
            stock_id = by_symbol[row["symbol"]]
            values.append("(?, ?, ?, ?, ?, ?, ?, ?, ?)")
            params.extend([
                stock_id,
                row["date"],
                row.get("open"),
                row.get("high"),
                row.get("low"),
                row.get("close"),
                row.get("close"),
                int(row["volume"]) if row.get("volume") is not None else None,
                (row.get("value") / row.get("volume")) if row.get("value") and row.get("volume") else row.get("close"),
            ])
        d1_exec(
            "INSERT OR REPLACE INTO stock_prices "
            "(stock_id, date, open, high, low, close, adj_close, volume, avg_price) VALUES "
            + ",".join(values),
            params,
        )
        inserted_stock_prices += len(batch)

    for batch in chunked(rows, 20):
        values = []
        params = []
        for row in batch:
            values.append("(?, ?, 'ETF', ?, ?, ?, ?, ?, ?, 'finlab.price.paper_benchmark', ?, ?)")
            params.extend([
                row["symbol"],
                row["date"],
                row.get("open"),
                row.get("high"),
                row.get("low"),
                row.get("close"),
                row.get("volume"),
                row.get("value"),
                lineage,
                as_of,
            ])
        d1_exec(
            "INSERT INTO canonical_market_daily "
            "(stock_id, date, market_segment, open, high, low, close, volume, value, source, lineage_json, as_of_date) VALUES "
            + ",".join(values)
            + " ON CONFLICT(stock_id, date, source) DO UPDATE SET "
              "open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, "
              "volume=excluded.volume, value=excluded.value, lineage_json=excluded.lineage_json, as_of_date=excluded.as_of_date",
            params,
        )
        inserted_canonical += len(batch)

    return {"stock_prices": inserted_stock_prices, "canonical_market_daily": inserted_canonical}


def main() -> int:
    parser = argparse.ArgumentParser(description="Backfill approved paper benchmark ETF prices from FinLab into D1.")
    parser.add_argument("--symbols", default=",".join(DEFAULT_SYMBOLS))
    parser.add_argument("--days", type=int, default=504)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--sql-out", default="")
    args = parser.parse_args()

    symbols = [item.strip() for item in args.symbols.split(",") if item.strip()]
    login_finlab()
    rows = load_price_rows(symbols, args.days)
    summary = {
        "symbols": symbols,
        "rows": len(rows),
        "min_date": min((row["date"] for row in rows), default=None),
        "max_date": max((row["date"] for row in rows), default=None),
    }
    print(json.dumps(summary, ensure_ascii=False))
    if args.dry_run:
        return 0
    if args.sql_out:
        result = write_sql_file(rows, ROOT / args.sql_out)
        print(json.dumps({"sql_out": args.sql_out, **result}, ensure_ascii=False))
        return 0
    result = upsert_prices(rows)
    print(json.dumps({"upserted": result}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
