import random
import sqlite3
import threading

from services import dataset_snapshot_exporter as exporter

SOURCES = ('finlab.fundamental_factor_diversity', 'finlab.daily_valuation', 'finlab.other')


class SqliteClient:
    def __init__(self, rows):
        self.db = sqlite3.connect(':memory:', check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.Lock()
        self.calls = []
        self.db.execute("""CREATE TABLE canonical_fundamental_features (stock_id TEXT, period TEXT,
            available_date TEXT, eps REAL, roe REAL, pe REAL, pb REAL, dividend_yield REAL,
            revenue_growth_yoy REAL, source TEXT, as_of_date TEXT, PRIMARY KEY(stock_id, period, source))""")
        self.db.executemany('INSERT INTO canonical_fundamental_features VALUES (?,?,?,?,?,?,?,?,?,?,?)', rows)

    def query(self, sql, params, timeout=None):
        with self.lock:
            self.calls.append((sql, list(params)))
            return [dict(r) for r in self.db.execute(sql, params)]


def _rows(n=4000, seed=7):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        day = f'2023-{rng.randint(8, 12):02d}-{rng.randint(1, 28):02d}' if i % 5 == 0 else \
            f'202{rng.randint(4, 6)}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}'
        as_of = day if i % 7 else '2026-12-31'
        out.append((f'{rng.randint(1000, 1060)}', f'p{i}', day, rng.random(), rng.random(), rng.random(),
                    rng.random(), rng.random(), rng.random(), SOURCES[i % 3], as_of))
    return out


def test_windowed_hot_read_matches_single_query(monkeypatch):
    client = SqliteClient(_rows())
    monkeypatch.setattr(exporter, 'MARKET_D1_CLIENT', client)
    monkeypatch.setattr('services.retention_market_history.archived_market_projection',
                        lambda *a, **k: iter(()))
    end = '2026-06-15'
    sql = """
        SELECT stock_id, period, available_date, eps, roe, pe, pb,
               dividend_yield, revenue_growth_yoy, source
        FROM canonical_fundamental_features
        WHERE available_date <= ?
          AND as_of_date <= ?
          AND source IN ('finlab.fundamental_factor_diversity', 'finlab.daily_valuation')
        ORDER BY stock_id, available_date, period
        """
    single = client.query(sql, [end, end])
    client.calls.clear()
    windowed = exporter._query_canonical_fundamentals(end)
    key = lambda r: (r['stock_id'], r['available_date'], r['period'])
    assert sorted(single, key=key) == windowed.to_dicts()
    assert len(windowed) > 1000
    reads = [c for c in client.calls if 'available_date >= ?' in c[0]]
    assert len(reads) > 1 and all(p[2] == end for _, p in reads)
    assert reads[0][1][0] == min(r[2] for r in _rows())
    assert max(p[1] for _, p in reads) == end


def test_windowed_hot_read_empty_table(monkeypatch):
    client = SqliteClient([])
    monkeypatch.setattr(exporter, 'MARKET_D1_CLIENT', client)
    monkeypatch.setattr('services.retention_market_history.archived_market_projection',
                        lambda *a, **k: iter(()))
    assert exporter._query_canonical_fundamentals('2026-06-15').is_empty()
    assert len(client.calls) == 1
