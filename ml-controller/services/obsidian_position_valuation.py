"""Point-in-time Paper position valuation across split D1 owners."""
from __future__ import annotations

from typing import Any, Awaitable, Callable

QueryFn = Callable[..., Awaitable[list[dict]]]


def _finite_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


async def hydrate_position_valuations(
    query: QueryFn,
    client: Any,
    positions: list[dict],
    *,
    as_of_date: str,
    core_domain: Any,
    market_domain: Any,
) -> list[dict]:
    """Attach Market closes no later than as_of_date without a cross-D1 join."""
    output = [dict(position) for position in positions]
    symbols = sorted({
        str(position.get("symbol") or "").strip()
        for position in output
        if str(position.get("symbol") or "").strip()
    })
    if not symbols:
        return output

    symbol_to_id: dict[str, Any] = {}
    for offset in range(0, len(symbols), 80):
        chunk = symbols[offset:offset + 80]
        placeholders = ",".join("?" for _ in chunk)
        identities = await query(
            client,
            f"SELECT id, symbol FROM stocks WHERE symbol IN ({placeholders})",
            chunk,
            domain=core_domain,
        )
        for row in identities:
            symbol = str(row.get("symbol") or "").strip()
            stock_id = row.get("id")
            if symbol and stock_id is not None:
                symbol_to_id[symbol] = stock_id

    latest_close_by_id: dict[str, tuple[str, float]] = {}
    stock_ids = sorted(set(symbol_to_id.values()), key=str)
    for offset in range(0, len(stock_ids), 80):
        chunk = stock_ids[offset:offset + 80]
        placeholders = ",".join("?" for _ in chunk)
        prices = await query(
            client,
            f"""
            SELECT stock_id, date, close
              FROM stock_prices
             WHERE stock_id IN ({placeholders})
               AND date <= ?
               AND date >= date(?, '-40 days')
               AND close IS NOT NULL
               AND close > 0
             ORDER BY stock_id ASC, date DESC
            """,
            [*chunk, as_of_date, as_of_date],
            domain=market_domain,
        )
        for row in prices:
            stock_id = str(row.get("stock_id"))
            close = _finite_number(row.get("close"))
            if stock_id not in latest_close_by_id and close is not None and close > 0:
                latest_close_by_id[stock_id] = (str(row.get("date") or ""), close)

    for position in output:
        stock_id = symbol_to_id.get(str(position.get("symbol") or "").strip())
        valuation = latest_close_by_id.get(str(stock_id)) if stock_id is not None else None
        current_price = valuation[1] if valuation else None
        shares = _finite_number(position.get("shares"))
        avg_cost = _finite_number(position.get("avg_cost"))
        position["current_price"] = round(current_price, 4) if current_price is not None else None
        position["price_date"] = valuation[0] if valuation else None
        if current_price is None or shares is None or avg_cost is None or avg_cost <= 0:
            position["unrealized_pnl"] = None
            position["unrealized_pnl_pct"] = None
            continue
        position["unrealized_pnl"] = round((current_price - avg_cost) * shares)
        position["unrealized_pnl_pct"] = round(((current_price - avg_cost) / avg_cost) * 100, 2)
    return output