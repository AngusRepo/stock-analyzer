"""Actual SQLite/EV allocation/journal transitions; synthetic prices, no ROI."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import sqlite3

import pytest

from services import paired_nav_candidate_collection as collection
from services.paired_nav_lifecycle import registered_pairs, resolve_pair_id, closure_for_pair, close_changed_comparisons, TABLE
from services.paired_nav_journal import (digest, freeze_snapshot, read_snapshot,
    stage_execution_receipt, mature_staged_pairs)
from services.paired_native_registration import register_allocation_pair
from test_paired_nav_candidate_collection import environment
from test_paired_nav_journal import packet, receipt, FEES
from test_native_paper_sandbox import native_runner


def stamp(day):
    return datetime.fromisoformat(day + 'T14:00:00+00:00')


def registered_old(environment, *, materialize=True):
    db, bucket, context, content = environment
    old = collection.collect_candidate_allocations(snapshot_id=context['snapshot_id'],
        query=db.query, writer=db.writer, bucket=bucket)
    registrations = []
    for item in old['plans']:
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        p = packet()
        p.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
        p.update(allocation_snapshot_id=item['snapshot_id'],
            configuration={**plan['configuration'], 'fees': FEES}, schedule=[{'observed_at': '2026-09-08T00:00:00Z'}])
        p['configuration_checksum'] = digest(p['configuration'])
        saved = freeze_snapshot(signal_date='2026-09-07', source_run_id=p['pair_id'], snapshot_kind='execution_pair',
            content=p, query=db.query, writer=db.writer, now=stamp('2026-09-07'))
        registrations.append(saved)
        if materialize:
            stage_execution_receipt(execution=receipt(p, saved), query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    if materialize:
        mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    return old, registrations


def successor_context(environment, monkeypatch, *, changed=True, execution_environment=None):
    db, _, _, content = environment
    new = deepcopy(content)
    if changed:
        new['risk_config']['maxSingleNamePct'] = .20
    if execution_environment is not None:
        new['native_execution_environment'] = deepcopy(execution_environment)
    saved = freeze_snapshot(signal_date='2026-09-08', source_run_id='new-context', snapshot_kind='allocation_context',
        content=new, query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    monkeypatch.setattr(collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp('2026-09-08')))
    return saved


def collect(environment, context, writer=None):
    db, bucket, *_ = environment
    return collection.collect_candidate_allocations(snapshot_id=context['snapshot_id'],
        query=db.query, writer=writer or db.writer, bucket=bucket)


def register_successors(db, plans):
    """Synthetic registration fixtures; actual native registration is tested below."""
    for item in plans:
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        p = packet('2026-09-09')
        p.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
        p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': '2026-09-09T00:00:00Z'}])
        p['configuration_checksum'] = digest(p['configuration'])
        freeze_snapshot(signal_date='2026-09-08', source_run_id=p['pair_id'], snapshot_kind='execution_pair',
            content=p, query=db.query, writer=db.writer, now=stamp('2026-09-08'))


def commit(db, result, writer=None):
    return close_changed_comparisons(plans=result['plans'], signal_date='2026-09-08',
        query=db.query, writer=writer or db.writer, now=stamp('2026-09-08'))


def test_daily_changed_config_closes_exact_prior_evidence_and_retry_keeps_it(environment, monkeypatch):
    db, *_ = environment
    old, registrations = registered_old(environment)
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
    new = collect(environment, successor_context(environment, monkeypatch))
    assert len(new['lifecycle_transition_plan']) == 2
    assert new['lifecycle_transitions'] == []
    register_successors(db, new['plans'])
    transitions = commit(db, new)
    for event in transitions:
        assert event['changed_fields'] == ['configuration_checksum']
        assert event['final_evidence']['accounted_sessions'] == 1
        assert event['final_evidence']['latest_session'] == event['final_session_date'] == '2026-09-08'
        assert event['inherited_mature_sessions'] == 0 and event['promotion_allowed'] is False
        assert event['pair_id'] in {p['pair_id'] for p in old['plans']}
        assert event['successor_pair_id'] in {p['pair_id'] for p in new['plans']}
        assert event['final_execution_snapshot_id'] in {p['snapshot_id'] for p in registrations}
    assert registered_pairs(signal_date='2026-09-08', query=db.query) == []
    # It is the newer prospective plan which continues; no old NAV rows are reset.
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == before
    assert collect(environment, successor_context_read(db), writer=db.writer) == new
    assert len(db.query(f'SELECT * FROM {TABLE}', [])) == 2
    for item in old['plans']:
        event = closure_for_pair(item['pair_id'], signal_date='2026-09-08', query=db.query)
        assert event
        assert closure_for_pair(item['pair_id'], signal_date='2026-09-07', query=db.query) is None
        assert resolve_pair_id(item['pair_id'], signal_date='2026-09-08', query=db.query) != item['pair_id']


def successor_context_read(db):
    return db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE source_run_id='new-context'", [])[0]


def test_collecting_successor_cannot_retire_old_lane_before_registration(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    collect(environment, successor_context(environment, monkeypatch))
    assert db.query(f'SELECT * FROM {TABLE}', []) == []
    assert len(registered_pairs(signal_date='2026-09-09', query=db.query)) == 2


@pytest.mark.parametrize('registered_count', [0, 1])
def test_partial_registration_cannot_commit_any_closure(environment, monkeypatch, registered_count):
    db, *_ = environment
    registered_old(environment)
    result = collect(environment, successor_context(environment, monkeypatch))
    register_successors(db, result['plans'][:registered_count])
    with pytest.raises(ValueError, match='successor_not_registered'):
        commit(db, result)
    assert db.query(f'SELECT * FROM {TABLE}', []) == []
    assert len(registered_pairs(signal_date='2026-09-08', query=db.query)) == 2


def test_missing_promised_session_cannot_be_retired_as_success(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment, materialize=False)
    context = successor_context(environment, monkeypatch)
    result = collect(environment, context)
    assert result['status'] == 'candidate_allocations_failed' and not result['plans']
    assert result['owner_failures']['expected_return']['reason'] == 'paired_nav_lifecycle_final_session_not_reconciled'
    assert not db.query(f'SELECT * FROM {TABLE}', [])


def test_unchanged_daily_comparison_keeps_identity_and_has_no_transition(environment, monkeypatch):
    db, *_ = environment
    old, _ = registered_old(environment)
    new = collect(environment, successor_context(environment, monkeypatch, changed=False))
    assert [p['pair_id'] for p in old['plans']] == [p['pair_id'] for p in new['plans']]
    assert new['lifecycle_transitions'] == []
    assert len(registered_pairs(signal_date='2026-09-08', query=db.query)) == 2


def test_partial_transition_write_retries_without_replacing_first_receipt(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    context = successor_context(environment, monkeypatch)
    result = collect(environment, context)
    register_successors(db, result['plans'])
    calls = 0
    def interrupted(statements):
        nonlocal calls
        if TABLE in statements[0][0]:
            calls += 1
            if calls == 2:
                raise RuntimeError('fixture_write_interrupted')
        return db.writer(statements)
    with pytest.raises(RuntimeError, match='fixture_write_interrupted'):
        commit(db, result, writer=interrupted)
    first = db.query(f'SELECT * FROM {TABLE}', [])
    assert len(first) == 1
    final = commit(db, result)
    assert len(final) == 2
    assert db.query(f'SELECT * FROM {TABLE} WHERE pair_id=?', [first[0]['pair_id']]) == first


def test_immutable_closure_and_closed_pair_registration_guard(environment, monkeypatch):
    db, *_ = environment
    old, _ = registered_old(environment)
    result = collect(environment, successor_context(environment, monkeypatch))
    register_successors(db, result['plans'])
    commit(db, result)
    row = db.query(f'SELECT * FROM {TABLE}', [])[0]
    for sql in (f'DELETE FROM {TABLE}', f"UPDATE {TABLE} SET payload_checksum='wrong'",
                f"INSERT OR REPLACE INTO {TABLE} SELECT pair_id,root_pair_id,successor_pair_id,successor_snapshot_id,transition_signal_date,final_session_date,payload_json,'wrong',recorded_at FROM {TABLE}"):
        with pytest.raises(sqlite3.IntegrityError, match='immutable_lifecycle'):
            db.conn.execute(sql)
    old_item = next(p for p in old['plans'] if p['pair_id'] == row['pair_id'])
    old_plan = read_snapshot(db.query, old_item['snapshot_id'])['payload']['content']
    stale = freeze_snapshot(signal_date='2026-09-08', source_run_id=old_plan['pair_id'], snapshot_kind='allocation_pair',
        content=old_plan, query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    with pytest.raises(ValueError, match='closed_pair_cannot_restart'):
        register_allocation_pair(snapshot_id=stale['snapshot_id'], query=db.query, writer=db.writer,
            domain_queries={}, kv_read=lambda key: None, objects=None, account_id=1,
            variables={}, kv_read_policy={}, now=stamp('2026-09-08'))


def test_missing_lifecycle_guard_blocks_new_plans_not_ordinary_accounting(environment):
    db, _, _, _ = environment
    db.conn.execute('DROP TRIGGER paired_nav_lifecycle_no_replace_v1')
    result = collect(environment, environment[2])
    assert result['status'] == 'candidate_allocations_failed' and not result['plans']
    assert result['owner_failures']['expected_return']['reason'] == 'paired_nav_lifecycle_immutability_missing'
    assert not db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", [])
    assert mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer,
        now=stamp('2026-09-08'))['paired_nav_evidence']['pairs'] == []


def test_named_but_ineffective_immutable_guard_is_not_accepted(environment):
    db, *_ = environment
    db.conn.execute('DROP TRIGGER paired_nav_lifecycle_no_update_v1')
    db.conn.execute(f"CREATE TRIGGER paired_nav_lifecycle_no_update_v1 BEFORE DELETE ON {TABLE} "
        "BEGIN SELECT RAISE(ABORT,'paired_nav_immutable_lifecycle'); END")
    result = collect(environment, environment[2])
    assert result['status'] == 'candidate_allocations_failed' and not result['plans']
    assert result['owner_failures']['expected_return']['reason'] == 'paired_nav_lifecycle_immutability_missing'


@pytest.mark.parametrize('interruption', [None, 'native_registration', 'lifecycle_commit'])
@pytest.mark.parametrize('extra_cohort', [False, True])
@pytest.mark.parametrize('change_kind', ['allocation', 'execution'])
def test_changed_comparison_reaches_real_native_registration_and_pipeline_receipt(environment, monkeypatch, native_runner, interruption, extra_cohort, change_kind):
    from services import paired_native_runtime as native
    from services.paired_nav_pipeline import complete_pipeline_shadow, pipeline_shadow_errors
    from services.native_paper_sandbox import native_runtime_manifest
    from services.native_paper_source_capture import ImmutableNativeObjects
    from test_native_paper_source_capture import Bucket
    from test_native_paper_bootstrap import fixture as source_fixture
    from test_paired_native_registration import calendar
    db, bucket, *_ = environment
    registered_old(environment)
    if extra_cohort:
        from test_paired_nav_ev_selection import add_new_cohort
        db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
        add_new_cohort(db, bucket)
    worker_context = {'schema_version': 'native-paper-source-context-v1',
        'observed_at': stamp('2026-09-08').isoformat(), 'variables': {},
        'frozen_kv': {'ml:config': '{}', 'ml:config.debate_max_rounds': '3', 'ml:adaptive_params': None}}
    captured_environment = None
    if change_kind == 'execution':
        from services.paired_nav_execution_environment import capture_execution_environment
        captured_environment = capture_execution_environment(context_reader=lambda: worker_context,
            runner=native_runner, clock=lambda: stamp('2026-09-08'))
    context = successor_context(environment, monkeypatch, changed=change_kind == 'allocation',
        execution_environment=captured_environment)
    source, source_query = source_fixture()
    try:
        source.execute("INSERT OR IGNORE INTO stocks(id,symbol,name,market) VALUES(2,'2317','fixture','TWSE')")
        for stock_id, symbol in [(1, '2330'), (2, '2317')]:
            source.execute('INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES(?,?,?,?,?,?,?)',
                ['2026-09-08', stock_id, symbol, symbol, stock_id, 50, 'synthetic-source-seed'])
        before_source = source.total_changes
        before_journal = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
        objects = ImmutableNativeObjects(Bucket())
        owners = native_runtime_manifest(native_runner)['tables']
        original = native.register_candidate_execution_plans
        monkeypatch.setattr(collection, '_bucket', lambda: bucket)
        def read_worker():
            assert change_kind == 'allocation', 'Sealed environment must not be replaced by a live read'
            return worker_context
        monkeypatch.setattr(native, 'register_candidate_execution_plans', lambda **kw: original(**kw,
            objects=objects, domain_queries={owner: source_query for owner in set(owners.values())},
            kv_read=calendar, runner=native_runner, clock=lambda: stamp('2026-09-08'),
            context_reader=read_worker))
        start = {'status': 'allocation_context_frozen', 'snapshot_id': context['snapshot_id']}
        if interruption:
            calls = 0
            def fail_once(statements):
                nonlocal calls
                if interruption == 'lifecycle_commit' and TABLE in statements[0][0]:
                    calls += 1
                    if calls == 2:
                        raise RuntimeError('fixture_closure_interrupted')
                if interruption == 'native_registration' and any(
                        'execution_pair' in params for _, params in statements):
                    raise RuntimeError('fixture_registration_interrupted')
                return db.writer(statements)
            start = complete_pipeline_shadow(start, query=db.query, writer=fail_once)
            assert start['status'] == 'failed' and start['stage'] == interruption
            assert pipeline_shadow_errors(start)
            assert len(db.query(f'SELECT * FROM {TABLE}', [])) == (1 if interruption == 'lifecycle_commit' else 0)
            assert len(registered_pairs(signal_date='2026-09-08', query=db.query)) == (1 if interruption == 'lifecycle_commit' else 2)
        result = complete_pipeline_shadow(start, query=db.query, writer=db.writer)
        assert result['status'] == 'native_execution_pairs_registered', result
        assert len(result['native_execution']['registrations']) == (4 if extra_cohort else 2)
        assert pipeline_shadow_errors(result) == []
        assert len(result['candidate_allocations']['lifecycle_transitions']) == 2
        for registration in result['native_execution']['registrations']:
            p = read_snapshot(db.query, registration['snapshot_id'])['payload']['content']
            if change_kind == 'execution':
                assert p['source_context'] == captured_environment['source_context']
                assert p['configuration']['native_execution_policy']['execution_owner_version'] == p['execution_owner_version']
            assert p['session_date'] == '2026-09-09' and p['previous_session_date'] is None
            assert p['initial_account']['nav'] == 100000
            # Plans intentionally differ. Only opening financial books must match.
            financials = []
            for arm in ('baseline', 'candidate'):
                with sqlite3.connect(':memory:') as account:
                    account.executescript(objects.get(p['initial_state_objects'][arm])['state_sql'])
                    financials.append((account.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone(),
                        account.execute('SELECT * FROM paper_positions WHERE account_id=1 ORDER BY id').fetchall(),
                        account.execute('SELECT * FROM paper_settlements WHERE account_id=1 ORDER BY id').fetchall()))
            assert financials[0] == financials[1]
        assert complete_pipeline_shadow(result, query=db.query, writer=db.writer) == result
        assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == before_journal
        assert source.total_changes == before_source
    finally:
        source.close()
