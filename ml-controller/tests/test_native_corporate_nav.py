import json
import sqlite3
import pytest

from services.paired_nav_journal import replay_session
from services.paired_native_session import validate_native_account
from test_native_paper_sandbox import native_runner, snapshot_state, run, frame, snapshot_input
from test_paired_nav_journal import FEES


def test_native_known_zero_snapshot_reconciles_without_fake_daily_return(native_runner):
    # Synthetic zero capital state; actual Worker snapshot/account-value owner.
    with sqlite3.connect(':memory:') as db:
        db.executescript(snapshot_state())
        db.execute('UPDATE paper_accounts SET cash=0 WHERE id=2')
        db.execute('DELETE FROM paper_positions WHERE account_id=2')
        db.execute('DELETE FROM paper_settlements WHERE account_id=2')
        raw = '\n'.join(db.iterdump())
    close = snapshot_input()
    native = run(native_runner, raw, [frame(), close],
        inputs={frame()['input_id']: frame(), close['input_id']: close})
    ledger = replay_session(previous={'cash': 0, 'positions': {}, 'nav': 0, 'peak_nav': 20},
        fills=[], marks={}, corporate_actions=[], session_date='2026-09-07', fees=FEES)
    validate_native_account(native['frames'][-1]['result']['valuation'], ledger)
    assert ledger['nav'] == 0 and ledger['daily_return'] is None and ledger['drawdown'] == -1
    assert native['nav_maturity_credit'] == 0  # A snapshot alone is not a complete session.


def test_old_conversion_attachment_does_not_block_or_reapply_on_new_exchange_date():
    actions = [{'action_id': 'old', 'symbol': '2330', 'kind': 'exchange', 'ex_date': '2026-09-04',
                'payable_date': '2026-09-04', 'cash_per_share': 0., 'stock_per_share': 2.},
               {'action_id': 'new', 'symbol': '2330', 'kind': 'exchange', 'ex_date': '2026-09-07',
                'payable_date': '2026-09-07', 'cash_per_share': 0., 'stock_per_share': .5}]
    previous = {'cash': 0., 'nav': 1000., 'positions': {'2330': 10}}
    ledger = replay_session(previous=previous, fills=[], marks={'2330': 200}, corporate_actions=actions,
                            session_date='2026-09-07', fees=FEES)
    assert ledger['positions'] == {'2330': 5} and ledger['nav'] == 1000.
    actions[1]['capital_return_per_share'] = 2.
    with pytest.raises(ValueError, match='capital_cash_leg_missing'):
        replay_session(previous=previous, fills=[], marks={'2330': 200}, corporate_actions=actions,
                       session_date='2026-09-07', fees=FEES)


@pytest.mark.parametrize('ratio,capital_return,official_ratio', [(22., 0., None), (.75, 2.5, None),
                                                              (.7296441479, 0., .72964415)])
def test_native_delivered_conversion_and_deferred_refund_match_independent_journal(native_runner, ratio, capital_return, official_ratio):
    day = '2026-09-07'
    actions = [{'action_id': 'exchange', 'symbol': '2330', 'kind': 'exchange', 'ex_date': day,
                'payable_date': day, 'cash_per_share': 0., 'stock_per_share': ratio,
                'capital_return_per_share': capital_return}]
    if official_ratio is not None:
        actions[0].update(official_share_ratio=official_ratio, fractional_treatment='book_entry_fee')
    if capital_return:
        actions.append({'action_id': 'refund', 'symbol': '2330', 'kind': 'cash', 'ex_date': day,
                        'payable_date': None, 'cash_per_share': capital_return, 'stock_per_share': 0.})
    price = (100 - capital_return) / ratio
    with sqlite3.connect(':memory:') as db:
        db.executescript(snapshot_state())
        db.execute("INSERT INTO stock_prices VALUES(1,'2026-09-04',100)")
        db.execute("UPDATE stock_prices SET close=? WHERE stock_id=1 AND date<>'2026-09-04'", (price,))
        key = 'market:corporate_actions:v1:' + day
        source = json.loads(db.execute('SELECT value FROM _native_private_kv WHERE key=?', (key,)).fetchone()[0])
        source['actions'] = actions
        db.execute('UPDATE _native_private_kv SET value=? WHERE key=?', (json.dumps(source), key))
        raw = '\n'.join(db.iterdump())
    close = {**snapshot_input(), **frame(day, 'snapshot'), 'observed_at': day + 'T06:00:00Z'}
    native = run(native_runner, raw, [frame(day), close], inputs={frame(day)['input_id']: frame(day), close['input_id']: close})
    previous = {'cash': 99000., 'positions': {'2330': 100}, 'nav': 109000.}
    ledger = replay_session(previous=previous, fills=[], marks={'2330': price},
                            corporate_actions=actions, session_date=day, fees=FEES)
    validate_native_account(native['frames'][-1]['result']['valuation'], ledger)
    assert ledger['cash'] == 99000
    delivered = int(100 * ratio)
    assert ledger['nav'] == pytest.approx(99000 + delivered * price + 100 * capital_return)
    assert ledger['positions']['2330'] == delivered


def test_fraction_cash_and_capital_refund_keep_separate_due_dates_across_native_sessions(native_runner):
    actions = [
        {'action_id': 'exchange', 'symbol': '2330', 'kind': 'exchange', 'ex_date': '2026-09-07',
         'payable_date': '2026-09-07', 'cash_per_share': 0., 'stock_per_share': .75, 'capital_return_per_share': 2.5},
        {'action_id': 'refund', 'symbol': '2330', 'kind': 'cash', 'ex_date': '2026-09-07',
         'payable_date': '2026-09-08', 'cash_per_share': 2.5, 'stock_per_share': 0., 'cash_rounding': 'floor_twd'},
        {'action_id': 'fraction', 'symbol': '2330', 'kind': 'cash', 'ex_date': '2026-09-07',
         'payable_date': '2026-09-09', 'cash_per_share': 100., 'stock_per_share': 0., 'cash_rounding': 'floor_twd',
         'cash_quantity_basis': 'exchange_fraction', 'share_conversion_ratio': .75, 'related_exchange_action_id': 'exchange'},
    ]
    with sqlite3.connect(':memory:') as db:
        db.executescript(snapshot_state())
        db.execute('UPDATE paper_positions SET shares=101 WHERE account_id=2')
        db.execute("INSERT INTO stock_prices VALUES(1,'2026-09-04',100)")
        db.execute("UPDATE stock_prices SET close=130 WHERE stock_id=1 AND date<>'2026-09-04'")
        for day in ('2026-09-07', '2026-09-08', '2026-09-09'):
            key = 'market:corporate_actions:v1:' + day
            source = json.loads(db.execute('SELECT value FROM _native_private_kv WHERE key=?', (key,)).fetchone()[0])
            source['actions'] = actions
            db.execute('UPDATE _native_private_kv SET value=? WHERE key=?', (json.dumps(source), key))
        raw = '\n'.join(db.iterdump())
    previous = {'cash': 99000., 'positions': {'2330': 101}, 'nav': 109100.}
    for day, cash, n_rights in [('2026-09-07', 99000, 2), ('2026-09-08', 99252, 1), ('2026-09-09', 99327, 0)]:
        close = {**snapshot_input(), **frame(day, 'snapshot'), 'observed_at': day + 'T06:00:00Z'}
        native = run(native_runner, raw, [frame(day), close], inputs={frame(day)['input_id']: frame(day), close['input_id']: close})
        ledger = replay_session(previous=previous, fills=[], marks={'2330': 130},
                                corporate_actions=actions, session_date=day, fees=FEES)
        validate_native_account(native['frames'][-1]['result']['valuation'], ledger)
        assert ledger['cash'] == cash and len(ledger['corporate_receivables']) == n_rights
        assert ledger['positions']['2330'] == 75 and ledger['nav'] == pytest.approx(109077)
        previous, raw = ledger, native['state_sql']


@pytest.mark.parametrize('dividend,rounding', [(2., None), (.7207, 'floor_twd'), (.29, None)])
@pytest.mark.parametrize('shares', [100, 1000, 3000], ids=['odd-lot-100-shares', 'one-lot-1000-shares', 'three-lots-3000-shares'])
def test_original_native_exdate_and_actual_payment_reconcile_to_journal(native_runner, dividend, rounding, shares):
    action = {'action_id': 'dividend', 'symbol': '2330', 'kind': 'cash',
        'ex_date': '2026-09-07', 'payable_date': '2026-09-08', 'cash_per_share': dividend, 'stock_per_share': 0.,
        'cash_rounding': rounding}
    with sqlite3.connect(':memory:') as db:
        db.executescript(snapshot_state())
        db.execute("UPDATE paper_positions SET shares=? WHERE account_id=2 AND symbol='2330'", (shares,))
        db.execute("INSERT INTO stock_prices VALUES(1,'2026-09-04',100)")
        db.execute('UPDATE stock_prices SET close=? WHERE stock_id=1', (100 - dividend,))
        db.execute("UPDATE stock_prices SET close=100 WHERE stock_id=1 AND date='2026-09-04'")
        for day in ('2026-09-07', '2026-09-08'):
            key = 'market:corporate_actions:v1:' + day
            source = json.loads(db.execute('SELECT value FROM _native_private_kv WHERE key=?', (key,)).fetchone()[0])
            source['actions'] = [action]
            db.execute('UPDATE _native_private_kv SET value=? WHERE key=?', (json.dumps(source), key))
        raw = '\n'.join(db.iterdump())
    opening_nav = 99000. + shares * 100.
    previous = {'cash': 99000., 'positions': {'2330': shares}, 'nav': opening_nav}
    for day in ('2026-09-07', '2026-09-08'):
        close = {**snapshot_input(), **frame(day, 'snapshot')}
        close['observed_at'] = day + 'T06:00:00Z'
        native = run(native_runner, raw, [frame(day), close], inputs={frame(day)['input_id']: frame(day), close['input_id']: close})
        valuation = native['frames'][-1]['result']['valuation']
        ledger = replay_session(previous=previous, fills=[], marks={'2330': 100 - dividend}, corporate_actions=[action], session_date=day, fees=FEES)
        validate_native_account(valuation, ledger)
        from decimal import Decimal
        due = Decimal(str(dividend)) * shares
        payment = int(due) if rounding else float(due)
        assert ledger['nav'] == pytest.approx(opening_nav - float(due) + payment)
        if day == '2026-09-08':
            assert ledger['daily_return'] == 0
        assert valuation['cash'] == (99000 if day == '2026-09-07' else 99000 + payment)
        assert len(valuation['corporate_receivables']) == (1 if day == '2026-09-07' else 0)
        previous, raw = ledger, native['state_sql']


@pytest.mark.parametrize('ratio,treatment,delivered', [(.29, None, 29), (.105, 'book_entry_fee', 10)])
def test_original_stock_delivery_and_fractional_expense_reconcile(native_runner, ratio, treatment, delivered):
    action = {'action_id': 'stock-dividend', 'symbol': '2330', 'kind': 'stock',
        'ex_date': '2026-09-07', 'payable_date': '2026-09-08', 'cash_per_share': 0.,
        'stock_per_share': ratio, 'fractional_treatment': treatment}
    with sqlite3.connect(':memory:') as db:
        db.executescript(snapshot_state())
        db.execute("INSERT INTO stock_prices VALUES(1,'2026-09-04',100)")
        db.execute("UPDATE stock_prices SET close=? WHERE stock_id=1 AND date<>'2026-09-04'", (100 / (1 + ratio),))
        for day in ('2026-09-07', '2026-09-08'):
            key = 'market:corporate_actions:v1:' + day
            source = json.loads(db.execute('SELECT value FROM _native_private_kv WHERE key=?', (key,)).fetchone()[0])
            source['actions'] = [action]
            db.execute('UPDATE _native_private_kv SET value=? WHERE key=?', (json.dumps(source), key))
        raw = '\n'.join(db.iterdump())
    previous = {'cash': 99000., 'positions': {'2330': 100}, 'nav': 109000.}
    for day in ('2026-09-07', '2026-09-08'):
        close = {**snapshot_input(), **frame(day, 'snapshot')}
        close['observed_at'] = day + 'T06:00:00Z'
        native = run(native_runner, raw, [frame(day), close], inputs={frame(day)['input_id']: frame(day), close['input_id']: close})
        valuation = native['frames'][-1]['result']['valuation']
        ledger = replay_session(previous=previous, fills=[], marks={'2330': 100 / (1 + ratio)},
            corporate_actions=[action], session_date=day, fees=FEES)
        validate_native_account(valuation, ledger)
        assert valuation['cash'] == 99000
        assert valuation['positions']['2330'] == (100 if day == '2026-09-07' else 100 + delivered)
        assert ledger['nav'] == pytest.approx(99000 + (100 + delivered) * 100 / (1 + ratio))
        if day == '2026-09-08':
            assert ledger['daily_return'] == pytest.approx(0)
        previous, raw = ledger, native['state_sql']
