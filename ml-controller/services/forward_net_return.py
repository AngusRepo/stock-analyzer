"""Five-session forward net return of one target-weight vector.

Same label semantics as `l4_forward_materialization`: enter at adj_open on
session d+1, exit at adj_close on session d+5, known once d+5 has closed.
Prices and the session calendar come from `canonical_market_daily`
(finlab.price first, then finlab.rotc_price). The rebalance from current to
target weights pays the actual single-side fees. A missing price yields no
value, never zero.
"""
from __future__ import annotations

from datetime import date
import math

from services.l4_numeric_contract import WEIGHT_SUPPORT

HORIZON_SESSIONS = 5
PRICE_SOURCES = ('finlab.price', 'finlab.rotc_price')


def forward_sessions(signal_date, *, query):
    """Sessions d+1..d+5 from the 0050 finlab.price calendar, or None if immature."""
    date.fromisoformat(signal_date)
    rows = query("SELECT date FROM canonical_market_daily WHERE stock_id='0050' AND source='finlab.price' "
                 "AND date>? ORDER BY date LIMIT ?", [signal_date, HORIZON_SESSIONS])
    sessions = [str(row['date'])[:10] for row in rows]
    if len(sessions) < HORIZON_SESSIONS:
        return None
    if sessions != sorted(set(sessions)) or sessions[0] <= signal_date:
        raise ValueError('forward_net_return_calendar_invalid')
    return sessions


def load_prices(symbols, *, entry_date, exit_date, query):
    """{symbol: (adj_open on entry, adj_close on exit)}; absent when either is missing."""
    symbols = sorted(set(symbols))
    best = {}
    for offset in range(0, len(symbols), 60):
        chunk = symbols[offset:offset + 60]
        marks = ','.join('?' for _ in chunk)
        rows = query(f"SELECT stock_id,date,source,adj_open,adj_close FROM canonical_market_daily "
                     f"WHERE stock_id IN ({marks}) AND date IN (?,?) AND source IN ('finlab.price','finlab.rotc_price')",
                     [*chunk, entry_date, exit_date])
        for row in rows:
            key = (str(row['stock_id']), str(row['date'])[:10])
            priority = PRICE_SOURCES.index(row['source'])
            field = 'adj_open' if key[1] == entry_date else 'adj_close'
            value = row.get(field)
            value = float(value) if value is not None and math.isfinite(float(value)) and float(value) > 0 else None
            current = best.get(key)
            if current is None or priority < current[0]:
                best[key] = (priority, value)
            elif priority == current[0] and current[1] != value:
                raise ValueError('forward_net_return_conflicting_price')
    prices = {}
    for symbol in symbols:
        entry, exit_ = best.get((symbol, entry_date), (0, None))[1], best.get((symbol, exit_date), (0, None))[1]
        if entry is not None and exit_ is not None:
            prices[symbol] = (entry, exit_)
    return prices


def net_return(weights, current, *, prices, buy_cost, sell_cost):
    """Σw·(exit/entry−1) − (buy·Σ(w−c)⁺ + sell·Σ(c−w)⁺); None when a held price is missing."""
    symbols = set(weights) | set(current)
    gross = 0.
    for symbol, weight in weights.items():
        if weight > WEIGHT_SUPPORT:
            if symbol not in prices:
                return None
            entry, exit_ = prices[symbol]
            gross += weight * (exit_ / entry - 1.)
    cost = sum(buy_cost * max(weights.get(s, 0.) - current.get(s, 0.), 0.)
               + sell_cost * max(current.get(s, 0.) - weights.get(s, 0.), 0.) for s in symbols)
    return gross - cost
