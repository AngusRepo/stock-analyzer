"""Dated candidate + held-only risk inputs; never enlarge the L3 decision pool."""
from datetime import date
import math


def load_held_risk_payloads(*, holdings, payloads, signal_date, lookback):
    from services.domain_stock_read_models import load_core_stock_identities
    from services.payload_builder import _bulk_load_prices
    present = {str(row.get("symbol") or row.get("stock_id")) for row in payloads}
    needed = sorted({row["symbol"] for row in holdings} - present)
    if not needed:
        return []
    identities = load_core_stock_identities(tradable_only=False)
    by_symbol = {row["symbol"]: sid for sid, row in identities.items()}
    if any(symbol not in by_symbol for symbol in needed):
        raise ValueError("l4_risk_held_identity_missing")
    prices = _bulk_load_prices([by_symbol[s] for s in needed], limit=lookback + 1, as_of_date=signal_date)
    return [{"symbol": s, "stock_id": by_symbol[s], "prices": prices.get(by_symbol[s], []),
             "source": "market.stock_prices.adj_close", "as_of_date": signal_date,
             "role": "held_only_risk_not_l3_candidate"} for s in needed]


def aligned_dated_history(payloads, *, signal_date, lookback):
    """Match exact return intervals; tail lengths cannot establish time alignment."""
    cutoff = date.fromisoformat(signal_date)
    series = {}
    for payload in payloads:
        symbol = str(payload.get("symbol") or payload.get("stock_id") or "")
        if not symbol or symbol in series:
            raise ValueError("l4_risk_duplicate_or_missing_symbol")
        prices = {}
        for row in payload.get("prices") or []:
            day = str(row.get("date") or "")[:10]
            if date.fromisoformat(day) > cutoff:
                raise ValueError("paired_nav_allocator_history_future_price")
            value = float(row.get("adj_close") or 0)
            if day in prices or not math.isfinite(value) or value <= 0:
                raise ValueError("l4_risk_adjusted_price_invalid")
            prices[day] = value
        days = sorted(prices)[-(lookback + 1):]
        series[symbol] = {(left, right): round(prices[right] / prices[left] - 1, 8)
                          for left, right in zip(days, days[1:])}
    common = sorted(set.intersection(*(set(values) for values in series.values()))) if series else []
    if len(common) < 20:
        raise ValueError("l4_risk_aligned_history_insufficient")
    return {symbol: [values[interval] for interval in common] for symbol, values in series.items()}, [list(x) for x in common]


def load_canonical_risk_payloads(*,payloads,held_payloads,signal_date,lookback,query=None):
    """Read the canonical owner on every new decision, including later backfills.

    Risk inputs are separate from L3 feature payloads. A legacy mirror gap or
    raw-price overwrite cannot prevent an available canonical quote being used.
    """
    from services.d1_domain_client import client_proxy_for_domain
    all_rows=[*payloads,*held_payloads];symbols=[str(p.get('symbol') or '') for p in all_rows]
    if any(not s for s in symbols) or len(set(symbols))!=len(symbols):raise ValueError('l4_risk_duplicate_or_missing_symbol')
    date.fromisoformat(signal_date)
    days=sorted({str(r['date'])[:10] for p in all_rows for r in p.get('prices') or [] if str(r['date'])[:10]<=signal_date})
    if len(days)<21:raise ValueError('l4_risk_calendar_insufficient')
    first=days[-min(len(days),lookback+1)]
    read=query or client_proxy_for_domain('market').query
    canonical={s:{} for s in symbols}
    for offset in range(0,len(symbols),60):
        chunk=symbols[offset:offset+60];marks=','.join('?' for _ in chunk)
        rows=read(f"SELECT stock_id,date,adj_close,source FROM canonical_market_daily WHERE stock_id IN ({marks}) "
            "AND date>=? AND date<=? AND source IN ('finlab.price','finlab.rotc_price') ORDER BY stock_id,date,source",
            [*chunk,first,signal_date],timeout=120.0)
        for row in rows:
            symbol=str(row['stock_id']);day=str(row['date'])[:10]
            if symbol not in chunk or not first<=day<=signal_date:raise ValueError('l4_risk_canonical_read_boundary')
            value=row.get('adj_close');valid=value is not None and math.isfinite(float(value)) and float(value)>0
            current=canonical[symbol].get(day)
            priority=0 if row['source']=='finlab.price' else 1
            if current is None or priority<current['priority']:
                canonical[symbol][day]={'date':day,'adj_close':float(value) if valid else None,'priority':priority}
            elif priority==current['priority'] and current['adj_close']!=(float(value) if valid else None):
                raise ValueError('l4_risk_conflicting_canonical_price')
    output=[]
    for original in all_rows:
        symbol=str(original['symbol']);rows=canonical[symbol]
        # Keep calendar rows even where neither source has a valid price.
        risk_days=sorted(set(rows)|{str(p['date'])[:10] for p in original.get('prices') or [] if first<=str(p['date'])[:10]<=signal_date})
        output.append({'symbol':symbol,'stock_id':original.get('stock_id'),
            'prices':[{'date':d,'adj_close':rows.get(d,{}).get('adj_close')} for d in risk_days],
            'source':'market.canonical_market_daily.adj_close','as_of_date':signal_date,'role':'canonical_risk_only',
            'canonical_rows':len(rows),'legacy_price_fallback':False})
    return output
