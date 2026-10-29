"""Read side of Paper for the Live intake (R33-NEW-37 §2, Wei D-6): committed Paper orders and
the portfolio value each auto_ml buy was sized against (paper_order_sizing_v1, Wei 10/29 A).

Read-only. Paper never reads anything Live writes.
"""

from __future__ import annotations

import math
from typing import Any, Callable, Mapping

PAPER_ACCOUNT_ID = 1  # Worker routes/paper.ts ACCOUNT_ID: the single AI Paper account
SIZED_SOURCE = "auto_ml"  # the only buy writer that records paper_order_sizing_v1

_ORDER_COLUMNS = ("id", "symbol", "side", "shares", "price", "source", "created_at")


class PaperDenominatorNotReady(Exception):
    """The sizing row is not readable yet (missing or read failed); the intake retries later."""


class D1PaperReader:
    def __init__(self, *, query: Callable[[str, list[Any], float], list[Mapping[str, Any]]] | None = None) -> None:
        if query is None:
            from services.d1_domain_client import D1DataDomain, DomainD1Client

            query = DomainD1Client(D1DataDomain.PAPER, require_specific=True).query
        self._query = query

    def orders(self) -> list[dict[str, Any]]:
        """Every committed order of the Paper account, oldest first (full history: Paper holdings)."""
        rows = self._query(f"SELECT {','.join(_ORDER_COLUMNS)} FROM paper_orders WHERE account_id=? ORDER BY id",
                           [PAPER_ACCOUNT_ID], 20.0)
        return [{column: row[column] for column in _ORDER_COLUMNS} for row in rows]

    def portfolio_value(self, order: Mapping[str, Any]) -> float | None:
        """The Paper portfolio value the buy was sized against.

        None: there will never be one (not a buy, or not an auto_ml buy), or the stored value is
        unusable; the intake then blocks the buy. Raises PaperDenominatorNotReady while the row
        is missing or unreadable, since Paper writes it just after the order.
        """
        if order.get("side") != "buy" or order.get("source") != SIZED_SOURCE:
            return None
        try:
            rows = self._query("SELECT portfolio_value FROM paper_order_sizing_v1 WHERE order_id=?",
                               [int(order["id"])], 5.0)
        except Exception as exc:
            raise PaperDenominatorNotReady(f"read_failed:{type(exc).__name__}") from None
        if not rows:
            raise PaperDenominatorNotReady("missing")
        value = rows[0].get("portfolio_value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            return None
        return float(value)
