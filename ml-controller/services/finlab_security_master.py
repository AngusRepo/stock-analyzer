"""FinLab company listing facts; never infer an IPO date from price history."""
from datetime import date, datetime, timezone
from urllib.parse import urlparse
from services.paired_nav_journal import digest

SOURCE = 'finlab.company_basic_info'
FIELDS = {'symbol', '公司簡稱', '市場別', '上市日期', '上櫃日期', '興櫃日期'}
MARKETS = {'sii': ('TWSE', '上市日期'), 'otc': ('OTC', '上櫃日期'), 'rotc': ('ROTC', '興櫃日期')}
ETF_FIELDS = {'symbol', '證券簡稱', '上市日期', 'ETF詳情頁'}


def _observed_clock(value):
    observed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if observed.tzinfo is None:
        raise ValueError('finlab_security_master_observed_clock_invalid')
    return observed.astimezone(timezone.utc).isoformat(timespec='microseconds')


def normalize_security_master(frame, observed_at):
    observed_at = _observed_clock(observed_at)
    if frame.is_empty() or not FIELDS <= set(frame.columns):
        raise ValueError('finlab_security_master_schema_invalid')
    rows, seen = [], set()
    for row in frame.select(sorted(FIELDS)).iter_rows(named=True):
        symbol = str(row['symbol']).strip()
        if symbol in seen or not symbol.isalnum() or not 4 <= len(symbol) <= 8:
            raise ValueError('finlab_security_master_symbol_invalid')
        seen.add(symbol)
        market, field = MARKETS.get(str(row['市場別']), (None, None))
        if market is None:
            raise ValueError('finlab_security_master_market_unknown:' + symbol)
        raw = str(row[field]).strip()
        try:
            listed = date.fromisoformat(raw).isoformat()
        except ValueError as exc:
            raise ValueError('finlab_security_master_listing_missing:' + symbol) from exc
        if not row['公司簡稱']:
            raise ValueError('finlab_security_master_name_missing:' + symbol)
        # Legacy Core market is an exchange-family routing enum. Preserve it
        # while retaining the exact FinLab venue, including emerging ROTC.
        rows.append({'symbol': symbol, 'name': str(row['公司簡稱']),
            'market': 'OTC' if market == 'ROTC' else market, 'listing_market': market,
            'listed_date': listed, 'listed_date_source': SOURCE + ':' + field,
            'listing_observed_at': observed_at, 'listing_checksum': digest(row),
            'in_current_watchlist': 0, 'source': 'finlab_security_master'})
    return sorted(rows, key=lambda r: r['symbol'])


def normalize_etf_master(frame, observed_at):
    observed_at = _observed_clock(observed_at)
    if frame.is_empty() or not ETF_FIELDS <= set(frame.columns):
        raise ValueError('finlab_etf_master_schema_invalid')
    rows, seen = [], set()
    for row in frame.select(sorted(ETF_FIELDS)).iter_rows(named=True):
        symbol = str(row['symbol']).strip()
        if symbol in seen or not symbol.isalnum() or not 4 <= len(symbol) <= 8:
            raise ValueError('finlab_etf_master_symbol_invalid')
        seen.add(symbol)
        url = urlparse(str(row['ETF詳情頁']))
        # This verified feed is TWSE only; never infer a TPEx listing from its name.
        if (url.scheme != 'https' or url.netloc != 'www.twse.com.tw'
                or url.path != '/zh/ETFortune-institute/etfInfo/' + symbol):
            raise ValueError('finlab_etf_master_market_unverified:' + symbol)
        raw_date = row['上市日期']
        listed = raw_date.date() if isinstance(raw_date, datetime) else raw_date
        try:
            listed = date.fromisoformat(str(listed)).isoformat()
        except ValueError as exc:
            raise ValueError('finlab_etf_master_listing_missing:' + symbol) from exc
        if not row['證券簡稱']:
            raise ValueError('finlab_etf_master_name_missing:' + symbol)
        canonical = {**row, '上市日期': listed}
        rows.append({'symbol': symbol, 'name': str(row['證券簡稱']), 'market': 'TWSE', 'listing_market': 'TWSE',
            'listed_date': listed, 'listed_date_source': 'finlab.tw_etf_basic_info:上市日期',
            'listing_observed_at': observed_at, 'listing_checksum': digest(canonical),
            'in_current_watchlist': 0, 'source': 'finlab_security_master'})
    return sorted(rows, key=lambda r: r['symbol'])


def merge_security_masters(*groups):
    rows = [row for group in groups for row in group]
    if len({row['symbol'] for row in rows}) != len(rows):
        raise ValueError('finlab_security_master_duplicate_owner')
    return sorted(rows, key=lambda r: r['symbol'])
