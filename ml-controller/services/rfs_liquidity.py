"""Freeze last twenty reported TWD turnovers within sixty sessions.

Missing days remain recorded; never infer zero or guess a volume unit. A current
report and twenty observations are required for each tradable name.
"""
from copy import deepcopy
import math
from services.l4_distribution import digest


def with_liquidity(rows, symbols, signal_date, market):
    days = market.query("SELECT date FROM canonical_market_daily WHERE date<=? AND source IN ('finlab.price','finlab.rotc_price') GROUP BY date HAVING count(DISTINCT stock_id)>=100 ORDER BY date DESC LIMIT 60", [signal_date])
    dates = sorted(row['date'] for row in days)
    if len(dates) < 20:
        raise ValueError('rfs_twenty_session_liquidity_window_missing')
    values = {}
    conflicts = set()
    # D1 bind limit: bounded chunks, using its indexed stock_id/date prefix.
    for offset in range(0, len(symbols), 50):
        subset = symbols[offset:offset+50]
        records = market.query('SELECT stock_id,date,value,source FROM canonical_market_daily WHERE stock_id IN ('+','.join('?' for _ in subset)+") AND date>=? AND date<=? AND source IN ('finlab.price','finlab.rotc_price')", [*subset, dates[0], dates[-1]])
        for row in records:
            key = (str(row['stock_id']), row['date'])
            if row['date'] not in dates:
                continue
            if key in values and values[key] != row['value']:
                conflicts.add(key)
            values[key] = row['value']
    enriched = {str(row['symbol']): deepcopy(row) for row in rows}
    evidence = {}
    for symbol in symbols:
        observations = [(day,values.get((symbol,day))) for day in dates]
        observed = [(day,v) for day,v in observations if isinstance(v,(int,float)) and math.isfinite(v) and v>=0 and (symbol,day) not in conflicts][-20:]
        valid = len(observed)==20 and observed[-1][0]==signal_date
        adv = sum(v for _,v in observed)/20 if valid else None
        row = enriched.setdefault(symbol, {'symbol': symbol})
        # Missing canonical data must not fall back to an unverified volume unit.
        for key in ('adv_twd', 'adtv_twd', 'avg_volume_20', 'average_volume_20'):
            row.pop(key, None)
        row['avg_daily_turnover_twd'] = adv
        evidence[symbol] = {'observed': observed, 'missing_recent_dates':[day for day,v in observations[-20:] if v is None or (symbol,day) in conflicts], 'current_report': bool(observed and observed[-1][0]==signal_date)}
    return list(enriched.values()), {
        'source': 'canonical_market_daily.value/finlab.price|finlab.rotc_price',
        'unit': 'TWD', 'dates': dates, 'signal_date': signal_date,
        'method':'mean_last_20_reported_values_within_60_sessions_current_report_required',
        'checksum': digest(evidence), 'by_symbol': evidence,
    }
