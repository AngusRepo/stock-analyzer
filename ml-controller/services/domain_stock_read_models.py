"""Reusable cross-D1 stock read models.

Core owns stock identity, Market owns OHLCV, and Learning owns predictions.
Every bridge is read-only and joins by ``stock_id`` in memory; no caller may
fall back to the legacy monolithic D1 join.
"""

from __future__ import annotations

from typing import Any, Iterable

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain


CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)
MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)
LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)


def load_core_stock_identities(*, tradable_only: bool = False) -> dict[int, dict[str, Any]]:
    where = "WHERE delisted_date IS NULL" if tradable_only else ""
    rows = CORE_D1_CLIENT.query(
        f"SELECT id, symbol, sector, market, delisted_date FROM stocks {where}",
        timeout=30.0,
    )
    return {
        int(row["id"]): dict(row)
        for row in rows
        if row.get("id") is not None and str(row.get("symbol") or "").strip()
    }


def load_market_price_rows_with_identity(
    *,
    start_date: str,
    end_date: str,
    fields: Iterable[str] = ("date", "close"),
    require_sector: bool = False,
) -> list[dict[str, Any]]:
    allowed = {"date", "open", "high", "low", "close", "volume", "adj_close"}
    selected = [field for field in fields if field in allowed]
    if not selected:
        raise ValueError("market_price_fields_missing")
    identities = load_core_stock_identities(tradable_only=True)
    rows = MARKET_D1_CLIENT.query(
        f"SELECT stock_id, {', '.join(selected)} FROM stock_prices "
        "WHERE date BETWEEN ? AND ? ORDER BY stock_id, date",
        [start_date, end_date],
        timeout=60.0,
    )
    out: list[dict[str, Any]] = []
    for row in rows:
        stock_id = row.get("stock_id")
        identity = identities.get(int(stock_id)) if stock_id is not None else None
        if not identity or (require_sector and not str(identity.get("sector") or "").strip()):
            continue
        out.append({
            **row,
            "symbol": identity["symbol"],
            "sector": identity.get("sector"),
            "market": identity.get("market"),
        })
    return out


def load_learning_rows_with_symbol(
    sql: str,
    params: list[Any] | None = None,
    *,
    timeout: float = 60.0,
) -> list[dict[str, Any]]:
    rows = LEARNING_D1_CLIENT.query(sql, params, timeout=timeout)
    identities = load_core_stock_identities()
    return [
        {**row, "symbol": identities[int(row["stock_id"])]["symbol"]}
        for row in rows
        if row.get("stock_id") is not None and int(row["stock_id"]) in identities
    ]


def load_top_active_stocks_with_prices(
    *,
    min_rows: int,
    top_n: int,
    limit_per_stock: int | None = None,
) -> list[dict[str, Any]]:
    identities = load_core_stock_identities(tradable_only=True)
    counts = MARKET_D1_CLIENT.query(
        "SELECT stock_id, COUNT(*) cnt FROM stock_prices "
        "GROUP BY stock_id HAVING COUNT(*) >= ? ORDER BY cnt DESC",
        [max(1, int(min_rows))],
        timeout=60.0,
    )
    selected = [
        (int(row["stock_id"]), identities[int(row["stock_id"])], int(row.get("cnt") or 0))
        for row in counts
        if row.get("stock_id") is not None and int(row["stock_id"]) in identities
    ][: max(1, int(top_n))]
    out: list[dict[str, Any]] = []
    for stock_id, identity, count in selected:
        limit_sql = " LIMIT ?" if limit_per_stock is not None else ""
        params: list[Any] = [stock_id]
        if limit_per_stock is not None:
            params.append(max(1, int(limit_per_stock)))
        rows = MARKET_D1_CLIENT.query(
            "SELECT date, open, high, low, close, volume FROM stock_prices "
            "WHERE stock_id=? ORDER BY date ASC" + limit_sql,
            params,
            timeout=60.0,
        )
        if len(rows) >= min_rows:
            out.append({"id": stock_id, "symbol": identity["symbol"], "cnt": count, "rows": rows})
    return out
