from datetime import date, timedelta
from routers import retrain_trigger as rt
from services import dataset_snapshots, payload_builder


def test_expanded_snapshot_preserves_older_institution_and_broker_observations(monkeypatch):
    days = [(date(2025, 1, 1) + timedelta(days=i)).isoformat() for i in range(330)]
    sources = {'prices': [], 'indicators': [],
        'chips': [{'symbol': 'TEST', 'date': d, 'foreign_net': i} for i, d in enumerate(days)],
        'broker_flows': [{'symbol': 'TEST', 'date': d, 'as_of_date': d, 'net_shares': i + 1}
                         for i, d in enumerate(days)]}
    monkeypatch.setattr(dataset_snapshots, 'latest_dataset_snapshot', lambda **kw: {'snapshot_id': 'test'})
    monkeypatch.setattr(rt, '_snapshot_component_uris', lambda snapshot: {k: k for k in sources})
    monkeypatch.setattr(rt, '_read_gcs_parquet_rows', lambda key: sources[key])
    expanded = rt._load_training_maps_from_snapshot(stock_ids=[1], symbols=['TEST'], prices_lookback=504)[2]['TEST']
    short = rt._load_training_maps_from_snapshot(stock_ids=[1], symbols=['TEST'], prices_lookback=252)[2]['TEST']
    assert len(expanded) == 330
    assert expanded[0]['date'] == days[0]
    assert expanded[0]['foreign_net'] == 0
    assert expanded[0]['broker_net_shares'] == 1
    assert len(short) == 252
    assert short == expanded[-252:]


def test_direct_chip_loader_extended_window_is_opt_in_and_keeps_cutoff(monkeypatch):
    import sqlite3
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE chip_data(symbol,date,foreign_net,trust_net,dealer_net,margin_balance,short_balance)')
    db.executemany("INSERT INTO chip_data VALUES ('TEST',?,1,2,3,4,5)",
                   [('2024-05-01',), ('2026-05-01',), ('2026-10-01',)])

    class Client:
        def query(self, sql, params, **kwargs):
            if 'FROM chip_data ' not in sql:
                return []
            return [dict(row) for row in db.execute(sql, params)]

    monkeypatch.setattr(payload_builder, 'MARKET_D1_CLIENT', Client())
    ordinary = payload_builder._bulk_load_chips(['TEST'], limit=504, as_of_date='2026-09-18')['TEST']
    expanded = payload_builder._bulk_load_chips(['TEST'], limit=504, as_of_date='2026-09-18', lookback_years=3)['TEST']
    assert [row['date'] for row in ordinary] == ['2026-05-01']
    assert [row['date'] for row in expanded] == ['2024-05-01', '2026-05-01']
