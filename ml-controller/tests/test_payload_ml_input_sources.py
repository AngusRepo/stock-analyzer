"""Data-owner regressions: null overwrite, broker semantics and adjusted basis."""
import sqlite3
import pytest
from services import payload_builder as builder


@pytest.fixture
def market(monkeypatch):
    db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
    db.executescript('''
      CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,open REAL,high REAL,low REAL,
        close REAL,volume REAL,adj_close REAL,avg_price REAL);
      CREATE TABLE canonical_market_daily(stock_id TEXT,date TEXT,close REAL,adj_close REAL,source TEXT,as_of_date TEXT);
      CREATE TABLE chip_data(symbol TEXT,date TEXT,foreign_net REAL,trust_net REAL,dealer_net REAL,margin_balance REAL,short_balance REAL);
      CREATE TABLE canonical_chip_daily(stock_id TEXT,date TEXT,market_segment TEXT,foreign_net REAL,trust_net REAL,dealer_net REAL,
        margin_balance REAL,short_balance REAL,source TEXT,as_of_date TEXT);
      CREATE TABLE canonical_broker_flow_daily(stock_id TEXT,date TEXT,market_segment TEXT,net_shares REAL,
        estimated_amount REAL,broker_count REAL,concentration REAL,source TEXT,as_of_date TEXT);
    ''')
    def query(sql,params,**kwargs):return [dict(row) for row in db.execute(sql,params)]
    monkeypatch.setattr(builder.MARKET_D1_CLIENT,'query',query)
    yield db
    db.close()


@pytest.mark.parametrize('reverse',[False,True])
def test_margin_fallback_preserves_observed_institutions_and_broker_is_separate(market,reverse):
    rows=[('2236','2026-10-07','LISTED',921050,0,-30836,12782,2,'finlab.institutional_investors_trading_summary','2026-10-07'),
          ('2236','2026-10-07','LISTED',None,None,None,12782,2,'twse.tpex.official_margin_fallback','2026-10-07')]
    market.executemany('INSERT INTO canonical_chip_daily VALUES(?,?,?,?,?,?,?,?,?,?)',rows[::-1] if reverse else rows)
    market.execute("INSERT INTO canonical_broker_flow_daily VALUES('2236','2026-10-07','LISTED_OTC',-1310,-110433000,30,.19,'finlab.broker_transactions','2026-10-07')")
    row=builder._bulk_load_chips(['2236'],as_of_date='2026-10-07')['2236'][0]
    assert (row['foreign_net'],row['trust_net'],row['dealer_net'])==(921050,0,-30836)
    assert row['broker_net_shares']==-1310
    assert row['chip_field_sources']['dealer_net']=='finlab.institutional_investors_trading_summary'


def test_emerging_broker_proxy_still_replaces_not_doubles(market):
    market.execute("INSERT INTO canonical_chip_daily VALUES('7000','2026-10-07','EMERGING',NULL,NULL,100,NULL,NULL,'finlab.rotc_broker_transactions','2026-10-07')")
    market.execute("INSERT INTO canonical_broker_flow_daily VALUES('7000','2026-10-07','EMERGING',100,1000,1,.1,'finlab.rotc_broker_transactions','2026-10-07')")
    row=builder._bulk_load_chips(['7000'],as_of_date='2026-10-07')['7000'][0]
    assert row['dealer_net']==100 and row['broker_net_shares']==100


def test_future_chip_source_does_not_overwrite_current_zero(market):
    market.execute("INSERT INTO chip_data VALUES('2236','2026-10-07',0,0,0,10,0)")
    market.execute("INSERT INTO canonical_chip_daily VALUES('2236','2026-10-07','LISTED',999,999,999,10,0,'finlab.institutional_investors_trading_summary','2026-10-08')")
    row=builder._bulk_load_chips(['2236'],as_of_date='2026-10-07')['2236'][0]
    assert (row['foreign_net'],row['trust_net'],row['dealer_net'])==(0,0,0)


def prices(market,*,adjusted=235.04936140394656,close=120,observed='2026-09-01'):
    market.execute("INSERT INTO stock_prices VALUES(2349,'2026-09-01',120,121.5,120,120,1000000,120,NULL)")
    market.execute("INSERT INTO canonical_market_daily VALUES('2236','2026-09-01',?,?,'finlab.price',?)",(close,adjusted,observed))
    return lambda:builder._bulk_load_prices([2349],as_of_date='2026-10-07',stock_symbols={2349:'2236'})[2349][0]


def test_canonical_adjustment_repairs_legacy_raw_substitute_without_changing_raw_ohlcv(market):
    row=prices(market)()
    assert row['close']==120 and row['high']==121.5 and row['volume']==1000000
    assert row['adj_close']==235.04936140394656
    assert row['adj_close_source']=='canonical_market_daily:finlab.price'
    assert row['adj_close_as_of_date']=='2026-09-01'


def test_late_canonical_adjustment_is_not_backdated_into_old_input(market):
    row=prices(market,observed='2026-10-08')()
    assert row['adj_close']==120 and row['adj_close_source']=='legacy.stock_prices'


@pytest.mark.parametrize('kwargs',[{'adjusted':-1},{'adjusted':float('inf')},{'close':121}])
def test_invalid_or_different_raw_basis_is_rejected(market,kwargs):
    with pytest.raises(ValueError,match='payload_canonical_adjusted_price_basis_invalid'):
        prices(market,**kwargs)()


def test_canonical_source_failure_is_not_a_successful_legacy_price_fallback(market):
    load=prices(market)
    market.execute('DROP TABLE canonical_market_daily')
    with pytest.raises(sqlite3.OperationalError):load()
