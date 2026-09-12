import sqlite3
from copy import deepcopy

import pytest

from services.native_paper_state import prepare_native_state
from services.recommendation_service import build_recommendation_update_statements
from test_native_paper_sandbox import ROOT, checksum


def fixture():
    db = sqlite3.connect(':memory:')
    db.executescript((ROOT / 'worker/domain-migrations/core/0001_core_baseline.sql').read_text(encoding='utf-8'))
    db.executescript((ROOT / 'worker/domain-migrations/paper/0001_paper_baseline.sql').read_text(encoding='utf-8'))
    db.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','TSMC','TWSE'),(2,'2317','Hon Hai','TWSE')")
    db.execute('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(2,100000,100000)')
    raw = '\n'.join(db.iterdump())
    db.close()
    seeds = [{'date': '2026-09-07', 'stock_id': 1, 'symbol': '2330', 'name': 'TSMC', 'rank': 1,
              'score': 50, 'reason': 'screener_seed', 'created_at': '2026-09-07 13:00:00'}]
    recs = [{'stock_id': 1, 'symbol': '2330', 'score': 60, 'signal': 'BUY', 'has_buy_signal': 1,
             'score_seed_inputs': {'chipFlowSeed40': 20, 'technicalSeed30': 15, 'screenerMomentumSeed20': 10, 'mlEdgeSeed30': 15},
             'eligible_for_pending_buy': True, 'alpha_allocation': {'selected': True, 'engine': 'sparse_tangent_inverse_risk'}}]
    return dict(base_state={'state_sql': raw, 'state_checksum': checksum(raw)}, seed_rows=seeds,
                recommendations=recs, signal_date='2026-09-07', trading_config={'fees': {'tax': .003}},
                risk_config={'system': {'killSwitch': False}})


def test_private_state_uses_original_serializer_preserves_account_and_seed_ownership():
    args = fixture()
    original = deepcopy(args)
    prepared = prepare_native_state(**args)
    expected = build_recommendation_update_statements(args['recommendations'], args['signal_date'])
    assert len(expected) == 1
    with sqlite3.connect(':memory:') as db:
        db.executescript(prepared['state_sql'])
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 100000
        assert db.execute('SELECT symbol,has_buy_signal,eligible_for_pending_buy FROM daily_recommendations').fetchone() == ('2330', 1, 1)
        assert db.execute("SELECT json_extract(alpha_allocation,'$.selected') FROM daily_recommendations").fetchone()[0] == 1
    assert args == original
    assert prepare_native_state(**args)['state_checksum'] == prepared['state_checksum']


def test_nonseed_ml_only_rows_are_not_created_and_missing_seed_fails():
    args = fixture()
    args['recommendations'].append({**args['recommendations'][0], 'stock_id': 2, 'symbol': '2317'})
    prepared = prepare_native_state(**args)
    assert prepared['ignored_nonseed_symbols'] == ['2317']
    with sqlite3.connect(':memory:') as db:
        db.executescript(prepared['state_sql'])
        assert db.execute('SELECT COUNT(*) FROM daily_recommendations').fetchone()[0] == 1
    args['seed_rows'] = []
    with pytest.raises(ValueError, match='screener_seed_missing'):
        prepare_native_state(**args)


def test_stale_selected_flag_cleared_by_same_formal_serializer():
    args = fixture()
    args['recommendations'][0]['signal'] = 'HOLD'
    prepared = prepare_native_state(**args)
    with sqlite3.connect(':memory:') as db:
        db.executescript(prepared['state_sql'])
        assert db.execute("SELECT json_extract(alpha_allocation,'$.selected') FROM daily_recommendations").fetchone()[0] == 0


def test_empty_candidate_slate_cannot_inherit_incumbent_buy_from_source_seed():
    args = fixture()
    args['seed_rows'][0].update(signal='BUY', has_buy_signal=1, eligible_for_pending_buy=1,
                               alpha_allocation='{"selected":true}')
    args['recommendations'] = []
    original = deepcopy(args)
    prepared = prepare_native_state(**args)
    with sqlite3.connect(':memory:') as db:
        db.executescript(prepared['state_sql'])
        assert db.execute('SELECT signal,has_buy_signal,eligible_for_pending_buy FROM daily_recommendations').fetchone() == ('HOLD', 0, 0)
        assert db.execute("SELECT json_extract(alpha_allocation,'$.selected') FROM daily_recommendations").fetchone()[0] == 0
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 100000
    assert args == original


def test_recommendation_cannot_overwrite_seed_stock_identity():
    args = fixture()
    args['recommendations'][0]['symbol'] = '2317'
    with pytest.raises(ValueError, match='recommendation_stock_identity_mismatch'):
        prepare_native_state(**args)


def test_carried_state_accepts_new_frozen_stock_but_never_reassigns_an_old_identity():
    args = fixture()
    args['seed_rows'][0].update(stock_id=3, symbol='new')
    args['recommendations'][0].update(stock_id=3, symbol='new')
    args['stock_rows'] = [{'id': 3, 'symbol': 'new', 'name': 'New stock', 'market': 'TWSE',
                          'added_at': '2026-09-07 01:00:00', 'updated_at': '2026-09-07 01:00:00'}]
    prepared = prepare_native_state(**args)
    with sqlite3.connect(':memory:') as db:
        db.executescript(prepared['state_sql'])
        assert db.execute('SELECT COUNT(*) FROM stocks').fetchone()[0] == 3
        assert db.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 100000
    args['stock_rows'].append({'id': 1, 'symbol': 'changed'})
    with pytest.raises(ValueError, match='identity_reassigned'):
        prepare_native_state(**args)
