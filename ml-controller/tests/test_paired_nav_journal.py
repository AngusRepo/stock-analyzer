from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import sqlite3

import pytest

from services.paired_nav_journal import (digest, freeze_snapshot, materialize_pair, read_snapshot,
                                        replay_session, number, stage_execution_receipt, mature_staged_pairs)
from services.paired_nav_collection import run_and_capture_allocation, replay_frozen_allocation


class DB:
    def __init__(self, *, legacy_assessments=True):
        self.conn = sqlite3.connect(':memory:')
        self.conn.row_factory = sqlite3.Row
        migration = Path(__file__).parents[2] / 'worker/domain-migrations/learning/0040_paired_nav_shadow_journal.sql'
        self.conn.executescript(migration.read_text(encoding='utf-8'))
        self.conn.executescript(migration.with_name('0043_paired_nav_lifecycle.sql').read_text(encoding='utf-8'))
        if legacy_assessments:
            self.conn.executescript(migration.with_name('0042_paired_nav_assessment_reservations.sql').read_text(encoding='utf-8'))

    def query(self, sql, params):
        return [dict(row) for row in self.conn.execute(sql, params).fetchall()]

    def writer(self, statements):
        for sql, params in statements:
            self.conn.execute(sql, params)
        self.conn.commit()
        return {'success_count': len(statements), 'error_count': 0}


@pytest.fixture
def db():
    return DB()


FEES = {'commission': 0.001425, 'minCommission': 20, 'tax': 0.003, 'dayTradeTax': 0.0015}
INITIAL = {'cash': 100000.0, 'positions': {}, 'marks': {}, 'nav': 100000.0}
NOW = datetime(2026, 9, 9, 8, tzinfo=timezone.utc)


def packet(day='2026-09-08', previous=None):
    config = {'trading_config': {'fees': FEES}, 'risk_config': {'position': {'maxSingleNamePct': 0.25}},
              'allocator_source_identity': {'source.py': 'a' * 64}, 'fees': FEES}
    return {'pair_id': 'candidate-pair', 'candidate_checksum': 'c' * 64, 'baseline_checksum': 'b' * 64,
            'execution_owner_version': 'fixture-execution-only', 'configuration': config,
            'configuration_checksum': digest(config), 'fees': FEES, 'initial_account': INITIAL,
            'session_date': day, 'session_open_at': day + 'T01:00:00Z',
            'session_close_at': day + 'T05:30:00Z', 'previous_session_date': previous}


def seal(db, content, signal='2026-09-07'):
    return freeze_snapshot(signal_date=signal, source_run_id='fixture:' + signal,
        snapshot_kind='execution_pair', content=content, query=db.query, writer=db.writer,
        now=datetime.fromisoformat(signal + 'T14:00:00+00:00'))


def receipt(content, seal, *, fills=None, marks=None):
    return {**{k: content[k] for k in ('pair_id', 'candidate_checksum', 'baseline_checksum',
                                    'execution_owner_version', 'configuration_checksum', 'session_date')},
            'snapshot_id': seal['snapshot_id'], 'session_complete': True, 'corporate_actions_complete': True,
            'observed_at': content['session_date'] + 'T06:00:00Z', 'corporate_actions': [],
            'marks': marks or {}, 'arms': {'baseline': {'complete': True, 'fills': []},
                                          'candidate': {'complete': True, 'fills': fills or []}}}


def buy(day='2026-09-08'):
    return {'fill_id': 'buy1', 'symbol': '2330', 'side': 'buy', 'shares': 100, 'price': 100,
            'commission': 20, 'tax': 0, 'executed_at': day + 'T01:10:00Z'}


def mature(db, frozen, rec):
    return materialize_pair(snapshot_id=frozen['snapshot_id'], session_date=rec['session_date'],
                            execution=rec, query=db.query, writer=db.writer, now=NOW)


def test_cash_and_no_fill_are_observed_zero_not_missing(db):
    p = packet()
    s = seal(db, p)
    result = mature(db, s, receipt(p, s))
    assert result['net_return_delta'] == 0
    assert result['arms']['candidate']['nav'] == 100000
    assert result['promotion_allowed'] is False
    assert result['ev_prediction_dates_added'] == 0


def test_nightly_consumes_staged_receipts_in_date_order_and_retries(db):
    p1 = packet()
    s1 = seal(db, p1)
    r1 = receipt(p1, s1, fills=[buy()], marks={'2330': 110})
    p2 = packet('2026-09-09', '2026-09-08')
    s2 = seal(db, p2, '2026-09-08')
    r2 = receipt(p2, s2, marks={'2330': 90})
    # Deliberately enqueue backwards. Only the consumer imposes session order.
    for r in [r2, r1]:
        stage_execution_receipt(execution=r, query=db.query, writer=db.writer, now=NOW)
    kwargs = dict(business_date='2026-09-09', query=db.query, writer=db.writer, now=NOW)
    first = mature_staged_pairs(**kwargs)
    assert first['processed_pair_sessions'] == 2
    assert first['pair_count'] == 1
    assert mature_staged_pairs(**kwargs)['processed_pair_sessions'] == 0
    assert first['ev_prediction_dates_added'] == 0


def test_nightly_missing_execution_is_not_successful_zero_nav(db):
    result = mature_staged_pairs(business_date='2026-09-09', query=db.query, writer=db.writer, now=NOW)
    assert result['status'] == 'awaiting_execution_pairs'
    assert result['latest_nav_session'] is None
    assert result['promotion_allowed'] is False


def test_nightly_does_not_call_old_evidence_current_when_new_receipt_is_missing(db):
    p1 = packet()
    s1 = seal(db, p1)
    stage_execution_receipt(execution=receipt(p1, s1), query=db.query, writer=db.writer, now=NOW)
    kwargs = dict(business_date='2026-09-09', query=db.query, writer=db.writer, now=NOW)
    assert mature_staged_pairs(**kwargs)['processed_pair_sessions'] == 1
    p2 = packet('2026-09-09', '2026-09-08')
    s2 = seal(db, p2, '2026-09-08')
    with pytest.raises(RuntimeError, match='due_execution_receipt_missing'):
        mature_staged_pairs(**kwargs)
    assert db.query('SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1', [])[0]['n'] == 1
    stage_execution_receipt(execution=receipt(p2, s2), query=db.query, writer=db.writer, now=NOW)
    assert mature_staged_pairs(**kwargs)['processed_pair_sessions'] == 1
    assert mature_staged_pairs(**kwargs)['status'] == 'up_to_date'


def test_unfinished_session_is_waiting_not_failed_or_current(db):
    seal(db, packet())
    result = mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer,
                                now=datetime(2026, 9, 8, 2, tzinfo=timezone.utc))
    assert result['status'] == 'awaiting_session_close'
    assert result['open_pair_sessions'] == 1
    assert result['recorded_pair_sessions'] == 0


def test_nightly_failed_write_keeps_receipt_for_retry(db):
    p = packet()
    s = seal(db, p)
    stage_execution_receipt(execution=receipt(p, s), query=db.query, writer=db.writer, now=NOW)
    def failure(statements):
        return {'success_count': 0, 'error_count': len(statements)}
    with pytest.raises(RuntimeError, match='write_incomplete'):
        mature_staged_pairs(business_date='2026-09-09', query=db.query, writer=failure, now=NOW)
    assert mature_staged_pairs(business_date='2026-09-09', query=db.query, writer=db.writer, now=NOW)['processed_pair_sessions'] == 1


def test_continuous_nav_counts_actual_cost_once_and_keeps_positions(db):
    p = packet()
    s = seal(db, p)
    r = receipt(p, s, fills=[buy()], marks={'2330': 110})
    first = mature(db, s, r)
    assert first['arms']['candidate']['cash'] == 89980
    assert first['arms']['candidate']['nav'] == 100980
    assert first['net_return_delta'] == pytest.approx(0.0098)
    assert first['arms']['candidate']['costs'] == 20
    p2 = packet('2026-09-09', '2026-09-08')
    s2 = seal(db, p2, '2026-09-08')
    second = mature(db, s2, receipt(p2, s2, marks={'2330': 90}))
    assert second['arms']['candidate']['nav'] == 98980
    assert second['arms']['candidate']['costs'] == 0
    assert second['arms']['candidate']['daily_return'] == pytest.approx(98980 / 100980 - 1)
    assert second['arms']['candidate']['drawdown'] == pytest.approx(98980 / 100980 - 1)
    assert second['previous_checksum'] == digest(first)


def test_same_session_retry_does_not_add_maturity_or_spend_cost_twice(db):
    p = packet()
    s = seal(db, p)
    r = receipt(p, s, fills=[buy()], marks={'2330': 100})
    assert mature(db, s, r) == mature(db, s, r)
    assert db.query('SELECT COUNT(*) n FROM paired_nav_daily_journal_v1', [])[0]['n'] == 1


def test_different_execution_cannot_overwrite_mature_day(db):
    p = packet()
    s = seal(db, p)
    mature(db, s, receipt(p, s))
    with pytest.raises(RuntimeError, match='evidence_conflict'):
        mature(db, s, receipt(p, s, fills=[buy()], marks={'2330': 100}))


@pytest.mark.parametrize('mutation, error', [
    (lambda r: r['arms'].pop('baseline'), 'both_arms'),
    (lambda r: r.update(session_complete=False), 'session_incomplete'),
    (lambda r: r.update(corporate_actions_complete=False), 'session_incomplete'),
    (lambda r: r['arms']['candidate'].update(complete=False), 'arm_incomplete'),
    (lambda r: r.update(candidate_checksum='other'), 'identity_mismatch'),
    (lambda r: r.update(configuration_checksum='other'), 'identity_mismatch'),
    (lambda r: r.update(observed_at='2026-09-10T07:00:00Z'), 'close_not_observable'),
])
def test_incomplete_or_mismatched_pair_never_writes(db, mutation, error):
    p = packet()
    s = seal(db, p)
    r = receipt(p, s)
    mutation(r)
    with pytest.raises(ValueError, match=error):
        mature(db, s, r)
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


def test_changed_fee_claim_without_changed_config_is_rejected(db):
    p = deepcopy(packet())
    p['fees'] = {**FEES, 'commission': 0}
    s = seal(db, p)
    with pytest.raises(ValueError, match='full_configuration'):
        mature(db, s, receipt(p, s))


def test_missing_one_previous_session_cannot_restart_initial_cash(db):
    p = packet(previous='2026-09-07')
    s = seal(db, p)
    with pytest.raises(ValueError, match='previous_journal_missing'):
        mature(db, s, receipt(p, s))


def test_held_stock_missing_price_does_not_get_removed():
    previous = {'cash': 90000, 'positions': {'2330': 100}, 'nav': 100000}
    with pytest.raises(ValueError, match='2330.mark'):
        replay_session(previous=previous, fills=[], marks={}, corporate_actions=[],
                       session_date='2026-09-08', fees=FEES)


def test_corporate_action_preserves_economic_value_without_fake_price_return():
    previous = {'cash': 0, 'positions': {'2330': 100}, 'nav': 10000}
    out = replay_session(previous=previous, fills=[], marks={'2330': 49}, session_date='2026-09-08', fees=FEES,
        corporate_actions=[{'action_id': 'split', 'symbol': '2330', 'session_date': '2026-09-08',
                            'split_ratio': 2, 'cash_per_old_share': 2}])
    assert out['nav'] == 10000
    assert out['daily_return'] == 0
    assert out['positions']['2330'] == 200


def test_day_trade_tax_matches_execution_owner():
    sell = {**buy(), 'fill_id': 'sell1', 'side': 'sell', 'price': 110, 'commission': 20,
            'tax': 17, 'is_day_trade': True, 'executed_at': '2026-09-08T04:00:00Z'}
    out = replay_session(previous=INITIAL, fills=[buy(), sell], marks={}, corporate_actions=[],
                         session_date='2026-09-08', fees=FEES)
    assert out['costs'] == 57
    assert out['nav'] == 100943
    assert out['positions'] == {}


@pytest.mark.parametrize('value', [None, '', ' ', True, False, float('nan'), float('inf')])
def test_missing_or_invalid_numbers_never_become_zero(value):
    with pytest.raises(ValueError):
        number(value, 'test')


@pytest.mark.parametrize('mutation, error', [
    (lambda f: f.update(commission=0), 'cost_mismatch'),
    (lambda f: f.update(shares=1000, commission=143), 'negative_cash'),
    (lambda f: f.update(shares=1.5), 'quantity_or_price'),
    (lambda f: f.update(side='sell', tax=30), 'sell_without_position'),
    (lambda f: f.update(executed_at='2026-09-07T01:00:00Z'), 'identity_or_sequence'),
])
def test_invalid_execution_is_not_silently_adjusted(mutation, error):
    fill = buy()
    mutation(fill)
    with pytest.raises(ValueError, match=error):
        replay_session(previous=INITIAL, fills=[fill], marks={'2330': 100}, corporate_actions=[],
                       session_date='2026-09-08', fees=FEES)


def test_snapshot_chunks_retry_and_hash_readback(db):
    args = dict(signal_date='2026-09-07', source_run_id='big', snapshot_kind='allocation_context',
                content={'text': '中文📈' * 50000}, query=db.query, writer=db.writer,
                now=datetime(2026, 9, 7, 14, tzinfo=timezone.utc))
    first = freeze_snapshot(**args)
    assert first['part_count'] > 5
    assert freeze_snapshot(**args) == first
    assert read_snapshot(db.query, first['snapshot_id'])['payload']['content'] == args['content']
    with pytest.raises(RuntimeError, match='immutable_input_conflict'):
        freeze_snapshot(**{**args, 'content': {'text': 'changed'}})


def test_partial_ack_never_publishes_manifest_then_retry_closes(db):
    def partial(statements):
        db.writer(statements[:1])
        return {'success_count': 1, 'error_count': len(statements) - 1}
    args = dict(signal_date='2026-09-07', source_run_id='partial', snapshot_kind='allocation_context',
                content={'text': 'x' * 100000}, query=db.query,
                now=datetime(2026, 9, 7, 14, tzinfo=timezone.utc))
    with pytest.raises(RuntimeError, match='write_incomplete'):
        freeze_snapshot(**args, writer=partial)
    assert not db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])
    assert freeze_snapshot(**args, writer=db.writer)['part_count'] > 1


def test_late_historical_seal_never_credits_prospective(db):
    p = packet()
    s = freeze_snapshot(signal_date='2026-09-07', source_run_id='late', snapshot_kind='execution_pair',
        content=p, query=db.query, writer=db.writer, now=datetime(2026, 9, 8, 7, tzinfo=timezone.utc))
    assert s['prospective'] == 0
    with pytest.raises(ValueError, match='prospective_execution_pair'):
        mature(db, s, receipt(p, s))


def test_allocator_capture_precedes_mutation_and_records_real_result(db):
    def fake(**kwargs):
        rows = kwargs['recommendations']
        rows[0]['signal'] = 'BUY'
        rows[0]['allocation_weight'] = 0.2
        if kwargs.get('allocation_evidence_sink'):
            kwargs['allocation_evidence_sink']({'effective_weights': {'2330': 0.2}})
        return rows
    rows = [{'symbol': '2330', 'signal': 'HOLD'}]
    output, collected = run_and_capture_allocation(recommendations=rows, ranking_config={'enabled': True},
        ensemble_v2_cfg={}, regime_label='bull', regime_surface={}, alpha_policy={}, return_history={},
        opb_reward_ledger=[], trading_config={'fees': FEES}, risk_config=None, signal_date='2026-09-07',
        source_run_id='test-allocator', query=db.query, writer=db.writer, run_allocation=fake)
    assert output is rows
    content = read_snapshot(db.query, collected['snapshot_id'])['payload']['content']
    assert content['inputs']['recommendations'][0]['signal'] == 'HOLD'
    assert content['formal_output'][0]['signal'] == 'BUY'
    assert collected['nav_maturity_credit'] == 0
    replay = replay_frozen_allocation(snapshot_id=collected['snapshot_id'], query=db.query, run_allocation=fake)
    assert replay['allocation_replay_decision'] == 'PASS'
    assert replay['execution_parity_decision'] == 'MISSING'
    assert replay['promotion_allowed'] is False


def test_real_formal_sparse_capture_does_not_change_weights_or_admission(db, monkeypatch):
    from services import recommendation_service as service
    from test_allocator_direction_authority import _continuity_row
    from services.paired_nav_collection import allocation_projection
    # Only observation I/O is substituted. The real admission, regime, covariance,
    # sparse solver and exposure-cap code executes on both arms of this parity test.
    monkeypatch.setattr(service, 'load_inherited_paper_weights', lambda *a, **k:
        {'status': 'fixture', 'weights': {}, 'portfolio_value_twd': 100000})
    monkeypatch.setattr(service, 'build_portfolio_ml_shadow_inputs', lambda *a, **k: {})
    monkeypatch.setattr(service, 'build_rfs_implementable_frontier_shadow', lambda *a, **k:
        {'status': 'fixture_observer', 'weights': {}, 'metrics': {}})
    rows = [_continuity_row('2330'), _continuity_row('2317')]
    kwargs = dict(recommendations=rows, ranking_config={'enabled': True, 'promoteMinMlEdge': 0},
        ensemble_v2_cfg={}, regime_label='bull', regime_surface={},
        alpha_policy={'allocation': {'controller': 'SparseTangent', 'method': 'sparse_tangent_inverse_risk'}},
        return_history={'2330': [.01, -.01, .02, .00, -.02] * 10, '2317': [.02, .01, -.01, .00, -.02] * 10},
        opb_reward_ledger=[])
    expected = service.apply_sparse_tangent_allocation(**deepcopy(kwargs))
    output, collected = run_and_capture_allocation(**deepcopy(kwargs), trading_config={'fees': FEES},
        risk_config=None, signal_date='2026-09-07', source_run_id='real-sparse', query=db.query, writer=db.writer)
    assert allocation_projection(output) == allocation_projection(expected)
    assert replay_frozen_allocation(snapshot_id=collected['snapshot_id'], query=db.query)['allocation_replay_decision'] == 'PASS'
