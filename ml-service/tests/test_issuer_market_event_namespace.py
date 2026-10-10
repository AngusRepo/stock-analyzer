import numpy as np
import pytest
from app.features import build_feature_matrix
from datetime import date, timedelta


def prices(n):
    start = date(2026, 1, 1)
    days = [start + timedelta(days=i) for i in range(n * 2)]
    return [{'date':str(d),'open':100+i*.2,'high':102+i*.2,'low':99+i*.2,
             'close':101+i*.2,'adj_close':101+i*.2,'volume':10000+i*100}
            for i,d in enumerate(d for d in days if d.weekday()<5)][:n]


@pytest.mark.parametrize('history', [False, True])
def test_market_breadth_cannot_fill_missing_issuer_event(history):
    p = prices(60)
    env = {'history':{r['date']:{'limit_down_count':321} for r in p}} if history else {}
    df = build_feature_matrix(p,[],[],[],env,historical_training=True)
    assert df['tech_limit_down_count_10'].to_list() == [0.] * len(p)
    assert df['_source_missing__tech_limit_down_count_10'].all()
    if history:
        assert df['limit_down_count'].to_list() == [321.] * len(p)


def test_issuer_history_preserves_zero_and_does_not_overwrite_market_breadth():
    p = prices(60)
    env = {'history':{r['date']:{'limit_down_count':321} for r in p},
           'per_stock_ts':{p[20]['date']:{'limit_down_count':0},p[30]['date']:{'limit_down_count':2}}}
    df = build_feature_matrix(p,[],[],[],env,historical_training=True)
    # Numerical causal imputation remains the existing recipe; source masks must
    # distinguish those imputed values from genuine exact-day observations.
    assert df['tech_limit_down_count_10'].to_list() == [0.]*30 + [2.]*30
    missing = [True]*60; missing[20] = missing[30] = False
    assert df['_source_missing__tech_limit_down_count_10'].to_list() == missing
    assert df['limit_down_count'].to_list() == [321.]*60


def test_future_issuer_event_does_not_change_earlier_values_or_masks():
    p = prices(60)
    a = build_feature_matrix(p,[],[],[],historical_training=True)
    b = build_feature_matrix(p,[],[],[],{'per_stock_ts':{p[40]['date']:{'limit_down_count':3}}},historical_training=True)
    np.testing.assert_array_equal(a['tech_limit_down_count_10'][:40],b['tech_limit_down_count_10'][:40])
    assert a['_source_missing__tech_limit_down_count_10'][:40].equals(b['_source_missing__tech_limit_down_count_10'][:40])
