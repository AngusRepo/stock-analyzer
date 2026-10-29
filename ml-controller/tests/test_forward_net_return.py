import pytest

from services.forward_net_return import forward_sessions, load_prices, net_return
from services.l4_forward_materialization import digest, materialize

CALENDAR = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-12']


class Market:
    """canonical_market_daily rows answering the two queries forward_net_return issues."""
    def __init__(self, rows, calendar=CALENDAR):
        self.rows, self.calendar = rows, calendar

    def query(self, sql, params):
        if "stock_id='0050'" in sql:
            after, limit = params
            return [{'date': d} for d in self.calendar if d > after][:limit]
        *symbols, entry, exit_ = params
        return [r for r in self.rows if r['stock_id'] in symbols and r['date'] in (entry, exit_)]


def row(symbol, day, source='finlab.price', adj_open=None, adj_close=None):
    return {'stock_id': symbol, 'date': day, 'source': source, 'adj_open': adj_open, 'adj_close': adj_close}


def materialized_gross(symbol, entry_open, exit_close):
    rows = [dict(symbol=symbol, features={'x': 1}, l3_baseline={'x': 1})]
    snapshot = dict(signal_date='2026-10-01', frozen_at='2026-10-01T23:00:00+08:00', snapshot_id='t',
        original_sha256='a' * 64, verified_original_sha256='a' * 64, feature_rows=rows,
        features_checksum=digest(rows), eligible_symbols=[symbol], l3_identity={'id': 1},
        pool_contract='native-v1', feature_schema='t', l3_training_label_known_max='2026-09-30')
    prices = {('2026-10-02', symbol): dict(adj_open=entry_open, source_sha256='b' * 64),
              ('2026-10-08', symbol): dict(adj_close=exit_close, source_sha256='c' * 64)}
    out, receipt = materialize(snapshot, calendar=CALENDAR, prices=prices, cutoff='2026-10-09T10:00:00+08:00',
                               expected_identity={'id': 1}, pool_contract='native-v1')
    return out[0]['gross_return'], receipt


def test_same_label_as_l4_forward_materialization():
    market = Market([row('1101', '2026-10-02', adj_open=100.), row('1101', '2026-10-08', adj_close=110.),
                     row('2330', '2026-10-02', adj_open=50.), row('2330', '2026-10-08', adj_close=45.)])
    sessions = forward_sessions('2026-10-01', query=market.query)
    prices = load_prices({'1101', '2330'}, entry_date=sessions[0], exit_date=sessions[-1], query=market.query)
    for symbol, (entry, exit_) in prices.items():
        gross, receipt = materialized_gross(symbol, entry, exit_)
        assert (sessions[0], sessions[-1]) == (receipt['entry_date'], receipt['label_known_date'])
        assert exit_ / entry - 1 == gross
        assert net_return({symbol: 1.}, {symbol: 1.}, prices=prices, buy_cost=.001425, sell_cost=.004425) == gross
    # Weighted target vs current pays the single-side fee on each leg.
    value = net_return({'1101': .5}, {'2330': .3}, prices=prices, buy_cost=.001425, sell_cost=.004425)
    assert value == pytest.approx(.5 * .1 - (.001425 * .5 + .004425 * .3))


def test_immature_calendar_and_missing_price_are_none_not_zero():
    assert forward_sessions('2026-10-06', query=Market([]).query) is None
    market = Market([row('1101', '2026-10-02', adj_open=100.)])
    prices = load_prices({'1101'}, entry_date='2026-10-02', exit_date='2026-10-08', query=market.query)
    assert prices == {}
    assert net_return({'1101': .2}, {}, prices=prices, buy_cost=.001425, sell_cost=.004425) is None
    # A sold-out name needs no exit price; only held weights are priced.
    assert net_return({}, {'1101': .2}, prices={}, buy_cost=.001425, sell_cost=.004425) == pytest.approx(-.2 * .004425)


def test_price_source_priority_and_conflict():
    market = Market([row('6488', '2026-10-02', 'finlab.rotc_price', adj_open=90.),
                     row('6488', '2026-10-02', adj_open=100.), row('6488', '2026-10-08', 'finlab.rotc_price', adj_close=99.)])
    assert load_prices({'6488'}, entry_date='2026-10-02', exit_date='2026-10-08', query=market.query) == {'6488': (100., 99.)}
    clash = Market([row('6488', '2026-10-02', adj_open=100.), row('6488', '2026-10-02', adj_open=101.)])
    with pytest.raises(ValueError, match='forward_net_return_conflicting_price'):
        load_prices({'6488'}, entry_date='2026-10-02', exit_date='2026-10-08', query=clash.query)
