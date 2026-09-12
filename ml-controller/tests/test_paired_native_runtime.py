from datetime import datetime, timezone
import json

import pytest

from services.paired_native_runtime import register_candidate_execution_plans, collect_due_execution_frames
from services.paired_nav_journal import freeze_snapshot, digest, read_snapshot
from services.native_paper_source_capture import ImmutableNativeObjects
from services.native_paper_sandbox import native_runtime_manifest, PrivatePaperStore
from test_paired_nav_journal import DB
from test_native_paper_bootstrap import fixture as source_fixture
from test_native_paper_state import fixture as state_fixture
from test_native_paper_source_capture import Bucket
from test_native_paper_sandbox import native_runner
from test_paired_native_registration import calendar, NOW, freeze_model_context


def test_daily_plan_reaches_real_native_registration_with_frozen_worker_policies(native_runner):
    source, source_query = source_fixture()
    db, objects = DB(), ImmutableNativeObjects(Bucket())
    try:
        config = {'trading_config': {'fees': {'commission': .001425, 'minCommission': 20,
            'tax': .003, 'dayTradeTax': .0015}}, 'risk_config': {'system': {'killSwitch': True}}}
        recs = state_fixture()['recommendations']
        allocation = {'pair_id': 'c' * 64, 'owner': 'l4_alpha_ev', 'candidate_checksum': 'c' * 64,
            'baseline_checksum': 'b' * 64, 'configuration': config, 'configuration_checksum': digest(config),
            'baseline': {'recommendations': recs}, 'candidate': {'recommendations': recs}}
        freeze_model_context(db, allocation)
        seal = freeze_snapshot(signal_date='2026-09-07', source_run_id=allocation['pair_id'],
            snapshot_kind='allocation_pair', content=allocation, query=db.query, writer=db.writer, now=NOW)
        reads = []
        context = {'schema_version': 'native-paper-source-context-v1', 'observed_at': NOW.isoformat(),
            'variables': {'FINLAB_L5_MARKET_DATA_ENABLED': '1', 'S12_INTRADAY_GATE_MODE': 'assist_entry'},
            'frozen_kv': {'ml:config': '{}', 'ml:config.debate_max_rounds': '3', 'ml:adaptive_params': None}}
        def context_reader():
            reads.append('context')
            return context
        owners = native_runtime_manifest(native_runner)['tables']
        args = dict(collection={'plans': [{'snapshot_id': seal['snapshot_id'], 'pair_id': allocation['pair_id'], 'owner': 'l4_alpha_ev'}]},
            query=db.query, writer=db.writer, objects=objects, domain_queries={d: source_query for d in set(owners.values())},
            kv_read=calendar, context_reader=context_reader, runner=native_runner, clock=lambda: NOW)
        before = source.total_changes
        result = register_candidate_execution_plans(**args)
        assert source.total_changes == before
        packet = read_snapshot(db.query, result['registrations'][0]['snapshot_id'])['payload']['content']
        assert packet['source_context'] == context and packet['model_predictions'] == {}
        state = objects.get(packet['initial_state_objects']['baseline'])
        private = PrivatePaperStore(**state, inputs={})
        try:
            assert private.db.execute("SELECT value FROM _native_private_kv WHERE key='ml:config.debate_max_rounds'").fetchone()[0] == '3'
        finally:
            private.db.close()
        assert register_candidate_execution_plans(**args) == result
        assert reads == ['context']
    finally:
        source.close()


def test_no_candidates_does_not_contact_production_sources():
    def forbidden(*args):
        raise AssertionError('unexpected query')
    result = register_candidate_execution_plans(collection={'plans': []}, query=forbidden, writer=forbidden)
    assert result['status'] == 'no_allocation_pairs'


def test_actual_tick_only_due_frames_and_rejects_late_empty_account_backfill(native_runner):
    from test_paired_native_collector import fixture
    db, args, objects, packet, snapshot_id = fixture(native_runner)
    # The fixture includes another pair without object references. Scope this
    # query to the independently registered execution pair under test.
    def query(sql, values):
        if "signal_date<?" in sql:
            return [{'snapshot_id': snapshot_id}]
        return db.query(sql, values)
    calls = []
    def capture_factory(**request):
        calls.append(request['snapshot_id'])
        return None  # Explicit all-cash fixture; no external source read occurs.
    params = dict(session_date=packet['session_date'], query=query, writer=db.writer,
        objects=objects, runner=native_runner, capture_factory=capture_factory)
    result = collect_due_execution_frames(**params,
        clock=lambda: datetime(2026, 9, 6, 23, 14, tzinfo=timezone.utc))
    assert result['pairs'][0]['completed_frames'] == 0 and calls == []
    result = collect_due_execution_frames(**params,
        clock=lambda: datetime(2026, 9, 6, 23, 15, tzinfo=timezone.utc))
    assert result['pairs'][0]['completed_frames'] == 2
    assert result['pairs'][0]['status'] == 'collecting'
    result = collect_due_execution_frames(**params, clock=lambda: args['now'])
    assert result['status'] == 'failed'
    assert result['pairs'][0]['reason'] == 'paired_native_expired_frame_without_receipt'
    assert result['pairs'][0]['completed_frames'] == 2
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    assert result['ev_prediction_dates_added'] == 0


def test_tick_refuses_different_session_date_without_querying():
    def forbidden(*args, **kwargs):
        raise AssertionError('unexpected I/O')
    with pytest.raises(ValueError, match='current_session_required'):
        collect_due_execution_frames(session_date='2026-09-04', query=forbidden, writer=forbidden,
            objects=None, capture_factory=forbidden, clock=lambda: NOW)


@pytest.fixture
def staged_native_tick():
    """Receipt-consumer boundary; the full Atomic test exercises actual frames."""
    from test_paired_nav_journal import packet, receipt
    from services.paired_native_session import session_schedule
    from services.paired_nav_journal import stage_execution_receipt
    db = DB(legacy_assessments=False)
    value = packet()
    value['schedule'] = session_schedule(value['session_date'])
    seal = freeze_snapshot(signal_date='2026-09-07', source_run_id=value['pair_id'],
        snapshot_kind='execution_pair', content=value, query=db.query, writer=db.writer, now=NOW)
    now = datetime(2026, 9, 8, 7, tzinfo=timezone.utc)
    staged = stage_execution_receipt(execution=receipt(value, seal), query=db.query, writer=db.writer, now=now)
    # Only the already-delivered index is stubbed at this boundary. No capture,
    # synthetic native fills, shortened schedule or OOF consumer is invoked.
    class Delivered:
        def lookup_delivery(self, key):
            return 'already-delivered-frame'
    def forbidden(**kwargs):
        pytest.fail('sealed receipt must not acquire new sources')
    args = dict(session_date=value['session_date'], query=db.query, writer=db.writer,
        objects=Delivered(), capture_factory=forbidden, clock=lambda: now)
    yield db, value, staged, args
    db.conn.close()


def test_completed_receipt_is_accounted_by_tick_without_oof(staged_native_tick):
    from services.paired_nav_journal import mature_staged_pairs
    db, value, staged, args = staged_native_tick
    result = collect_due_execution_frames(**args)
    assert result['status'] == 'ok'
    rows = db.query('SELECT payload_json,payload_checksum FROM paired_nav_daily_journal_v1', [])
    assert len(rows) == 1
    assert result['pairs'][0]['receipt_snapshot_id'] == staged['snapshot_id']
    assert result['pairs'][0]['journal_checksum'] == rows[0]['payload_checksum']
    assert result['pairs'][0]['accounting_status'] == 'materialized'
    assert result['promotion_allowed'] is False and result['ev_prediction_dates_added'] == 0
    assert collect_due_execution_frames(**args) == result
    assert mature_staged_pairs(business_date=value['session_date'], query=db.query,
        writer=db.writer, now=args['clock']())['processed_pair_sessions'] == 0


@pytest.mark.parametrize('committed', [False, True])
def test_tick_accounting_write_failure_resumes_same_receipt(staged_native_tick, committed):
    db, value, staged, args = staged_native_tick
    original = read_snapshot(db.query, staged['snapshot_id'])
    def interrupted(statements):
        assert any('INSERT OR IGNORE INTO paired_nav_daily_journal_v1' in sql for sql, _ in statements)
        if committed:
            db.writer(statements)
        raise RuntimeError('paired_nav_fixture_write_interrupted')
    failed = collect_due_execution_frames(**{**args, 'writer': interrupted})
    assert failed['status'] == failed['pairs'][0]['status'] == 'failed'
    assert failed['pairs'][0]['receipt_snapshot_id'] == staged['snapshot_id']
    assert failed['pairs'][0]['accounting_status'] == 'unconfirmed'
    assert failed['pairs'][0]['reason'] == 'paired_nav_fixture_write_interrupted'
    assert len(db.query('SELECT * FROM paired_nav_daily_journal_v1', [])) == int(committed)
    resumed = collect_due_execution_frames(**args)
    assert resumed['status'] == 'ok' and resumed['pairs'][0]['status'] == 'closed'
    assert resumed['pairs'][0]['receipt_snapshot_id'] == staged['snapshot_id']
    assert read_snapshot(db.query, staged['snapshot_id']) == original
    assert len(db.query('SELECT * FROM paired_nav_daily_journal_v1', [])) == 1
    assert collect_due_execution_frames(**args) == resumed


def test_tick_missing_predecessor_does_not_hide_failure_or_starve_other_pairs(staged_native_tick):
    from copy import deepcopy
    from test_paired_nav_journal import receipt
    from services.paired_nav_journal import stage_execution_receipt
    db, value, staged, args = staged_native_tick
    broken = deepcopy(value)
    broken.update(pair_id='missing-predecessor', previous_session_date='2026-09-07')
    seal = freeze_snapshot(signal_date='2026-09-07', source_run_id=broken['pair_id'],
        snapshot_kind='execution_pair', content=broken, query=db.query, writer=db.writer, now=NOW)
    stage_execution_receipt(execution=receipt(broken, seal), query=db.query, writer=db.writer, now=args['clock']())
    result = collect_due_execution_frames(**args)
    assert result['status'] == 'failed' and len(result['pairs']) == 2
    bad = next(p for p in result['pairs'] if p['snapshot_id'] == seal['snapshot_id'])
    good = next(p for p in result['pairs'] if p['snapshot_id'] != seal['snapshot_id'])
    assert bad['status'] == 'failed' and bad['reason'] == 'paired_nav_previous_journal_missing'
    assert good['status'] == 'closed' and good['accounting_status'] == 'materialized'
    assert [r['pair_id'] for r in db.query('SELECT pair_id FROM paired_nav_daily_journal_v1', [])] == [value['pair_id']]
    assert collect_due_execution_frames(**args) == result


def test_tick_manifest_read_failure_is_pair_scoped(staged_native_tick):
    db, value, staged, args = staged_native_tick
    broken = {**value, 'pair_id': 'unreadable-pair'}
    seal = freeze_snapshot(signal_date='2026-09-07', source_run_id=broken['pair_id'],
        snapshot_kind='execution_pair', content=broken, query=db.query, writer=db.writer, now=NOW)
    def unavailable(sql, params):
        if sql == 'SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?' and params == [seal['snapshot_id']]:
            raise RuntimeError('paired_nav_manifest_missing')
        return db.query(sql, params)
    result = collect_due_execution_frames(**{**args, 'query': unavailable})
    assert result['status'] == 'failed' and len(result['pairs']) == 2
    bad = next(p for p in result['pairs'] if p['snapshot_id'] == seal['snapshot_id'])
    good = next(p for p in result['pairs'] if p['snapshot_id'] != seal['snapshot_id'])
    assert bad['status'] == 'failed' and bad['reason'] == 'paired_nav_manifest_missing'
    assert bad['completed_frames'] == 0 and bad['receipt_snapshot_id'] is None
    assert good['status'] == 'closed' and good['receipt_snapshot_id'] == staged['snapshot_id']
    assert len(db.query('SELECT * FROM paired_nav_daily_journal_v1', [])) == 1
