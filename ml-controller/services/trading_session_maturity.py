"""Point-in-time maturity cutoffs derived from the canonical Market calendar."""

from __future__ import annotations

from typing import Any, Callable

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain

MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)


def fifth_session_maturity_cutoff(
    cutoff: str,
    *,
    query_fn: Callable[[str, list[Any]], list[dict[str, Any]]] | None = None,
) -> str | None:
    """Return the latest signal date whose fifth following market session is known."""

    query = query_fn or MARKET_D1_CLIENT.query
    rows = query(
        """
        SELECT DISTINCT date(date) AS session_date
        FROM stock_prices
        WHERE date(date) <= date(?)
        ORDER BY date(date) DESC
        LIMIT 6
        """,
        [cutoff],
    )
    sessions = [
        str(row.get("session_date") or "")[:10]
        for row in rows
        if str(row.get("session_date") or "").strip()
    ]
    if len(sessions) < 6:
        return None
    return sessions[5]
