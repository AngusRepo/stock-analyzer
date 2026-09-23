from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import domain_stock_read_models as read_models  # noqa: E402


class _QueryStub:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def query(self, sql, params=None, timeout=60.0):
        self.calls.append((sql, params, timeout))
        return list(self.rows)


def test_market_prices_join_core_identity_in_memory(monkeypatch):
    from services import retention_market_history
    monkeypatch.setattr(retention_market_history, 'archived_market_projection', lambda *a, **k: iter(()))
    core = _QueryStub([
        {"id": 1, "symbol": "AAA", "sector": "Tech", "market": "TWSE", "delisted_date": None},
    ])
    market = _QueryStub([
        {"stock_id": 1, "date": "2026-08-24", "close": 100.0},
        {"stock_id": 2, "date": "2026-08-24", "close": 50.0},
    ])
    monkeypatch.setattr(read_models, "CORE_D1_CLIENT", core)
    monkeypatch.setattr(read_models, "MARKET_D1_CLIENT", market)

    rows = read_models.load_market_price_rows_with_identity(
        start_date="2026-08-01",
        end_date="2026-08-24",
        fields=("date", "close"),
        require_sector=True,
    )

    assert rows == [{
        "stock_id": 1,
        "date": "2026-08-24",
        "close": 100.0,
        "symbol": "AAA",
        "sector": "Tech",
        "market": "TWSE",
    }]
    assert "JOIN stocks" not in market.calls[0][0]


def test_learning_predictions_join_core_symbol_in_memory(monkeypatch):
    monkeypatch.setattr(read_models, "CORE_D1_CLIENT", _QueryStub([
        {"id": 1, "symbol": "AAA", "sector": "Tech", "market": "TWSE", "delisted_date": None},
    ]))
    learning = _QueryStub([
        {"stock_id": 1, "forecast_data": "{}"},
        {"stock_id": 999, "forecast_data": "{}"},
    ])
    monkeypatch.setattr(read_models, "LEARNING_D1_CLIENT", learning)

    rows = read_models.load_learning_rows_with_symbol(
        "SELECT stock_id, forecast_data FROM predictions",
    )

    assert rows == [{"stock_id": 1, "forecast_data": "{}", "symbol": "AAA"}]
    assert "stocks" not in learning.calls[0][0].lower()


def test_market_research_history_includes_cold_dates_before_hot_window(monkeypatch):
    from services import retention_market_history
    monkeypatch.setattr(read_models, 'CORE_D1_CLIENT', _QueryStub([
        {'id':1,'symbol':'AAA','sector':'Tech','market':'TWSE','delisted_date':None}]))
    monkeypatch.setattr(read_models, 'MARKET_D1_CLIENT', _QueryStub([
        {'stock_id':1,'date':'2026-01-01','close':110.}]))
    calls=[]
    def cold(*args, **kwargs):
        calls.append(args)
        yield {'stock_id':1,'date':'2020-01-01','close':100.}
    monkeypatch.setattr(retention_market_history, 'archived_market_projection', cold)
    rows=read_models.load_market_price_rows_with_identity(start_date='2020-01-01',end_date='2026-01-01')
    assert [row['close'] for row in rows]==[100.,110.]
    assert len(calls)==1 and calls[0][3:5]==('2020-01-01','2026-01-01')
