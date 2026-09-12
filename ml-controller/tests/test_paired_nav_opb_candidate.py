"""Original prior/registry/allocator -> frozen comparison and shared population."""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import json
import re
import sqlite3

import pytest

from services import paired_nav_opb_candidate as module
from services import opb_counterfactual_prior as producer
from services.paired_nav_collection import allocator_source_identity
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_comparison import resolve_allocation_comparison
from services.paired_nav_daily_review import _introduced_families, POLICY
from routers.opb_arm_prior import _registry_record
from test_paired_nav_intervention import inputs, reject_observer_io
from test_paired_nav_journal import DB, FEES


NOW = datetime(2026, 9, 7, 14, tzinfo=timezone.utc)


@pytest.fixture
def environment(monkeypatch):
    db = DB(legacy_assessments=False)
    from test_paired_nav_review_store import migrate
    migrate(db)
    schema = (Path(__file__).parents[2] / 'worker/domain-schemas/learning.sql').read_text(encoding='utf-8')
    table = re.search(r'CREATE TABLE IF NOT EXISTS model_artifact_registry \([\s\S]*?\n\);', schema)
    assert table
    db.conn.executescript(table[0])
    class Clock:
        @staticmethod
        def now(tz):
            return datetime(2026, 9, 7, 13, tzinfo=timezone.utc)
    monkeypatch.setattr(producer, 'datetime', Clock)
    artifact = producer.build_opb_arm_prior_artifact(rows=[], price_rows=[],
        expected_return_owner='l4_alpha_ev', trained_until='2026-08-25')['artifact']
    record = _registry_record(artifact, promoted=False, promotion_error=None)
    record['created_at'] = artifact['generated_at']
    db.conn.execute('INSERT INTO model_artifact_registry(' + ','.join(record) + ') VALUES('
        + ','.join('?' for _ in record) + ')', list(record.values()))
    original = inputs()
    for index, row in enumerate(original['recommendations'], 1):
        row['stock_id'] = index
        row['score_seed_inputs'] = {'chipFlowSeed40': 20, 'technicalSeed30': 15,
            'screenerMomentumSeed20': 10, 'mlEdgeSeed30': 15}
    baseline = run_isolated_allocation(inputs=original, inherited_state={})
    context = {'inputs': original, 'formal_output': baseline['output'], 'capture': baseline['capture'],
        'allocator_source_identity': allocator_source_identity(), 'trading_config': {'fees': FEES},
        'risk_config': {'maxSingleNamePct': .25}, 'model_predictions': {},
        'formal_baseline_identity': {'schema_version': 'paired-nav-formal-ml-baseline-v1',
            'artifact_id': 'formal-ml', 'cohort_id': 'formal-cohort',
            'payload_checksum': 'a' * 64, 'base_artifact_set_checksum': 'b' * 64},
        'opb_candidate_selection': module.select_opb_candidates(query=db.query,
            signal_date='2026-09-07', now=NOW)}
    monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=NOW))
    yield db, artifact, context
    db.conn.close()


def seal(db, content, run_id='opb-parent'):
    return freeze_snapshot(signal_date='2026-09-07', source_run_id=run_id,
        snapshot_kind='allocation_context', query=db.query, writer=db.writer, content=content, now=NOW)


def collect(db, parent):
    return module.collect_opb_allocations(snapshot_id=parent['snapshot_id'], query=db.query, writer=db.writer)


def test_failed_offline_prior_reaches_same_nav_population_and_retry_preserves_registry(environment):
    db, artifact, content = environment
    before = db.query('SELECT * FROM model_artifact_registry', [])
    parent = seal(db, content)
    result = collect(db, parent)
    assert result['status'] == 'allocation_pairs_frozen' and len(result['plans']) == 1
    plan = read_snapshot(db.query, result['plans'][0]['snapshot_id'])
    comparison = resolve_allocation_comparison(query=db.query, allocation=plan)
    assert comparison['owner'] == 'opb_arm_prior'
    assert comparison['kind'] == 'allocator_policy_contrast'
    evidence = read_verified_nav_evidence(business_date='2026-09-07', query=db.query, now=NOW)
    population = evidence.summary()['candidate_population']
    assert population['hypothesis_count'] == 1
    assert population['pairs'][0]['accounted_sessions'] == 0
    assert population['pairs'][0]['execution_status'] == 'not_registered'
    introduced = json.loads(_introduced_families(evidence).population_json)
    assert introduced['families'][0]['owner'] == 'opb_arm_prior'
    assert POLICY.family_alpha == .05  # Existing budget, no OPB-specific exemption.
    assert collect(db, parent) == result
    assert db.query('SELECT * FROM model_artifact_registry', []) == before
    assert artifact['validation']['decision'] == 'FAIL'
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


def test_registry_changes_after_capture_do_not_replace_prior_or_remove_denominator(environment):
    db, artifact, content = environment
    parent = seal(db, content)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived', offline_evidence_json='{}'")
    result = collect(db, parent)
    assert len(result['plans']) == 1
    packet = read_snapshot(db.query, result['plans'][0]['snapshot_id'])['payload']['content']
    assert packet['candidate_checksum'] == digest(artifact)


def test_inventory_pages_every_candidate_before_results_and_excludes_later_registration(environment):
    db, _, _ = environment
    for minimum in range(21, 74):
        artifact = producer.build_opb_arm_prior_artifact(rows=[], price_rows=[],
            expected_return_owner='l4_alpha_ev', trained_until='2026-08-25', min_dates=minimum)['artifact']
        row = _registry_record(artifact, promoted=False, promotion_error=None)
        row['created_at'] = '2026-09-07T15:00:00+00:00' if minimum == 73 else '2026-09-07 13:00:00'
        db.conn.execute('INSERT INTO model_artifact_registry(' + ','.join(row) + ') VALUES('
            + ','.join('?' for _ in row) + ')', list(row.values()))
    selected = module.select_opb_candidates(query=db.query, signal_date='2026-09-07', now=NOW)
    assert len(selected['registry_rows']) == 53
    assert all(row['created_at'] != '2026-09-07T15:00:00+00:00' for row in selected['registry_rows'])
    assert all(json.loads(row['offline_evidence_json'])['validation']['decision'] == 'FAIL'
               for row in selected['registry_rows'])


def test_future_inventory_cutoff_and_source_failure_are_not_empty_success(environment):
    db, _, context = environment
    context['opb_candidate_selection']['decision_cutoff_at'] = '2026-09-07T15:00:00+00:00'
    with pytest.raises(ValueError, match='selection_invalid'):
        collect(db, seal(db, context))
    context['opb_candidate_selection'] = {'status': 'failed', 'stage': 'opb_candidate_selection',
        'reason': 'paired_nav_source_or_capture_failed'}
    parent = seal(db, context, 'source-failed')
    with pytest.raises(ValueError, match='selection_source_failed'):
        collect(db, parent)


def test_failed_candidate_is_counted_before_inference_not_discarded(environment):
    db, _, context = environment
    row = context['opb_candidate_selection']['registry_rows'][0]
    row['offline_evidence_json'] = '{}'
    parent = seal(db, context)
    result = collect(db, parent)
    assert result['status'] == 'candidate_allocations_failed' and result['candidate_failures']
    population = read_verified_nav_evidence(business_date='2026-09-07', query=db.query,
        now=NOW).summary()['candidate_population']
    assert population['unmaterialized_selections'][0]['owner'] == 'opb_arm_prior'


def test_missing_selection_is_not_backfilled_from_todays_registry(environment):
    db, _, content = environment
    content.pop('opb_candidate_selection')
    parent = seal(db, content)
    assert collect(db, parent)['status'] == 'legacy_context_without_opb_selection'
    assert not db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", [])


def test_valid_empty_l4_pool_is_wait_not_failed_nav_and_corruption_cannot_hide_in_wait(environment):
    from test_allocator_direction_authority import _continuity_row
    from services.paired_nav_daily_review import run_daily_nav_reviews
    db, _, content = environment
    content['inputs']['recommendations'] = [_continuity_row('2330'), _continuity_row('2317')]
    incumbent = run_isolated_allocation(inputs=content['inputs'], inherited_state={})
    content.update(capture=incumbent['capture'], formal_output=incumbent['output'])
    parent = seal(db, content)
    result = collect(db, parent)
    assert result['status'] == 'awaiting_opb_dependency' and not result['plans']
    assert result['pending_dependencies'][0]['reason'] == 'awaiting_formal_expected_return_owner'
    assert incumbent['capture']['effective_weights'] == {}
    assert incumbent['capture']['allocation_contract']['ml_signal_role'] == 'advisory_only'
    assert not result.get('candidate_failures')
    reviewed = run_daily_nav_reviews(business_date='2026-09-07', query=db.query, writer=db.writer, now=NOW)
    assert reviewed['status'] == 'daily_nav_reviews_current'
    assert reviewed['pending_dependencies'] and not reviewed['failures']
    assert run_isolated_allocation(inputs=content['inputs'], inherited_state={})['output'] == content['formal_output']
    corrupted = deepcopy(content)
    corrupted['opb_candidate_selection']['registry_rows'][0]['offline_evidence_json'] = '{}'
    result = collect(db, seal(db, corrupted, 'bad-prior'))
    assert result['status'] == 'candidate_allocations_failed'
    assert not result.get('pending_dependencies')
    reviewed = run_daily_nav_reviews(business_date='2026-09-07', query=db.query, writer=db.writer, now=NOW)
    assert reviewed['status'] == 'partial_daily_nav_reviews'
    assert reviewed['failures'][0]['reason'] == 'nav_daily_population_unresolved'


@pytest.mark.parametrize('excluded_by', ['negative', 'risk_skip'])
def test_valid_unselected_pool_runs_real_opb_empty_allocation_without_fake_maturity(environment, excluded_by):
    db, _, content = environment
    for row in content['inputs']['recommendations']:
        if excluded_by == 'negative':
            row['l4_alpha_ev']['expected_return_mean'] = -.05
        else:
            row['alpha_context'] = {'risk_overlay': {'skip': True}}
    incumbent = run_isolated_allocation(inputs=content['inputs'], inherited_state={})
    content.update(capture=incumbent['capture'], formal_output=incumbent['output'])
    parent = seal(db, content)
    result = collect(db, parent)
    assert result['status'] == 'allocation_pairs_frozen', result
    assert not result.get('pending_dependencies')
    plan = read_snapshot(db.query, result['plans'][0]['snapshot_id'])['payload']['content']
    assert plan['candidate']['capture']['opb_packet']['status'] == 'ok'
    assert plan['candidate']['capture']['effective_weights'] == {}
    assert plan['candidate']['capture']['opb_packet']['selected_arm']
    assert plan['nav_maturity_credit'] == 0 and plan['promotion_allowed'] is False
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


def test_missing_ev_wait_cannot_mask_inconsistent_capture(environment):
    from test_allocator_direction_authority import _continuity_row
    db, _, content = environment
    content['inputs']['recommendations'] = [_continuity_row('2330')]
    incumbent = run_isolated_allocation(inputs=content['inputs'], inherited_state={})
    content.update(capture=incumbent['capture'], formal_output=incumbent['output'])
    parent = seal(db, content)
    saved = read_snapshot(db.query, parent['snapshot_id'])
    registry = content['opb_candidate_selection']['registry_rows'][0]
    for key, value in [('schema_version', 'unknown'), ('effective_weights', {'2330': .1}),
                       ('allocation_candidates', None)]:
        corrupt = deepcopy(saved)
        corrupt['payload']['content']['capture'][key] = value
        assert module.opb_dependency_wait(registry, corrupt) is None


def test_changed_candidate_controller_or_baseline_is_rejected(environment):
    db, _, content = environment
    parent = seal(db, content)
    result = collect(db, parent)
    saved = read_snapshot(db.query, result['plans'][0]['snapshot_id'])
    for target, field, value in [('candidate', 'candidate_checksum', 'e' * 64),
            ('baseline', 'output', []), ('candidate', 'production_effect', True)]:
        changed = deepcopy(saved)
        changed['payload']['content'][target][field] = value
        with pytest.raises(ValueError, match='paired_nav_opb_'):
            resolve_allocation_comparison(query=db.query, allocation=changed)


@pytest.mark.parametrize('scenario', ['same', 'version', 'negative', 'risk_skip'])
def test_same_policy_next_day_keeps_contrast_but_changed_ev_version_does_not(environment, monkeypatch, scenario):
    db, _, content = environment
    first = collect(db, seal(db, content))['plans'][0]
    later = datetime(2026, 9, 8, 14, tzinfo=timezone.utc)
    monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=later))
    changed = scenario == 'version'
    copied = deepcopy(content)
    copied['opb_candidate_selection'].update(signal_date='2026-09-08', decision_cutoff_at=later.isoformat())
    if scenario != 'same':
        for row in copied['inputs']['recommendations']:
            if changed:
                row['l4_alpha_ev']['model_version'] = 'new-formal-ev'
            elif scenario == 'negative':
                row['l4_alpha_ev']['expected_return_mean'] = -.05
            else:
                row['alpha_context'] = {'risk_overlay': {'skip': True}}
        baseline = run_isolated_allocation(inputs=copied['inputs'], inherited_state={})
        copied.update(capture=baseline['capture'], formal_output=baseline['output'])
    parent = freeze_snapshot(signal_date='2026-09-08', source_run_id='new-day-' + scenario,
        snapshot_kind='allocation_context', query=db.query, writer=db.writer, content=copied, now=later)
    plan = collect(db, parent)['plans'][0]
    assert (plan['pair_id'] != first['pair_id']) is changed


def test_original_daily_capture_and_combined_collector_include_opb(environment, monkeypatch):
    from services import paired_nav_collection as capture
    from services.paired_nav_candidate_collection import collect_candidate_allocations
    db, artifact, content = environment
    monkeypatch.setattr(capture, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=NOW))
    original_select = module.select_opb_candidates
    monkeypatch.setattr(module, 'select_opb_candidates', lambda **kw: original_select(**kw, now=NOW))
    ensemble = {k: v for k, v in content['formal_baseline_identity'].items() if k != 'schema_version'}
    model_manifest = {'active8_ensemble': ensemble, 'active8_action_authority': {
        **ensemble, 'buy_authorized': True, 'production_effect': True}}
    def original_run(allocation_evidence_sink, **kwargs):
        result = run_isolated_allocation(inputs=kwargs, inherited_state={})
        allocation_evidence_sink(result['capture'])
        return result['recommendations']
    _, receipt = capture.run_and_capture_allocation(**deepcopy(content['inputs']),
        trading_config=content['trading_config'], risk_config=content['risk_config'],
        model_predictions=content['model_predictions'], formal_model_manifest=model_manifest,
        signal_date='2026-09-07', source_run_id='daily-producer', query=db.query, writer=db.writer,
        run_allocation=original_run)
    assert receipt['status'] == 'allocation_context_frozen'
    result = collect_candidate_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    assert result['status'] == 'allocation_pairs_frozen' and len(result['plans']) == 1
    assert result['plans'][0]['owner'] == 'opb_arm_prior'
    assert not result.get('owner_failures')
    # A registry error on a later retry cannot replace the already frozen list.
    db.conn.execute("UPDATE model_artifact_registry SET offline_evidence_json='{}'")
    assert collect_candidate_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer) == result


def test_native_serializer_and_full_session_feed_original_nav_without_source_mutation(environment, native_runner, monkeypatch, tmp_path):
    from services.paired_native_registration import register_allocation_pair
    from services.native_paper_source_capture import ImmutableNativeObjects
    from services.native_paper_sandbox import native_runtime_manifest, PrivatePaperStore
    from test_native_paper_source_capture import Bucket
    from test_paired_native_registration import calendar
    from test_paired_native_session import native_config
    from services.paired_native_session import run_paired_session
    from services.paired_native_runtime import KV_READ_POLICY
    from services.native_paper_sandbox import run_native_paper_frames
    from services.paired_nav_journal import mature_staged_pairs
    db, _, content = environment
    config = native_config()  # Original config builder, explicit all-cash safety case.
    content.update(trading_config=config['trading'], risk_config=config['risk'])
    plan = collect(db, seal(db, content))['plans'][0]
    source = sqlite3.connect(':memory:')
    source.row_factory = sqlite3.Row
    root = Path(__file__).parents[2]
    for domain in ('core', 'paper', 'market', 'learning', 'ops', 'execution'):
        source.executescript((root / 'worker/domain-schemas' / (domain + '.sql')).read_text(encoding='utf-8'))
    source.executescript((root / 'worker/domain-migrations/paper/0004_corporate_action_accounting.sql').read_text(encoding='utf-8'))
    source.execute('INSERT INTO paper_accounts(id,cash,initial_cash) VALUES(1,100000,100000)')
    source.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(1,'2330','TSMC','TWSE')")
    source.execute("INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES('2026-09-07',1,'2330','TSMC',1,50,'seed')")
    def query_source(sql, params):
        return [dict(row) for row in source.execute(sql, params)]
    try:
        source.execute("INSERT INTO stocks(id,symbol,name,market) VALUES(2,'2317','Hon Hai','TWSE')")
        source.execute("INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES('2026-09-07',2,'2317','Hon Hai',2,50,'seed')")
        owners = native_runtime_manifest(native_runner)['tables']
        objects = ImmutableNativeObjects(Bucket())
        before = source.total_changes
        corporate_source = {'schema_version': 'paper-corporate-source-v1', 'session_date': '2026-09-08',
            'observed_at': NOW.isoformat(), 'source_checksum': digest(['synthetic-announcements', []]),
            'covered_symbols': ['2330', '2317'], 'actions': [], 'blockers': {},
            'tax_basis': 'gross_before_personal_tax'}
        receipt = register_allocation_pair(snapshot_id=plan['snapshot_id'], query=db.query, writer=db.writer,
            domain_queries={owner: query_source for owner in set(owners.values())}, kv_read=calendar,
            objects=objects, account_id=1, variables={},
            kv_read_policy=KV_READ_POLICY, runner=native_runner, now=NOW)
        assert source.total_changes == before
        saved = read_snapshot(db.query, receipt['snapshot_id'])
        packet = saved['payload']['content']
        from services.paired_nav_comparison import resolve_comparison
        assert resolve_comparison(query=db.query, execution=saved)['owner'] == 'opb_arm_prior'
        outputs = {}
        for arm in ('baseline', 'candidate'):
            store = PrivatePaperStore(**objects.get(packet['initial_state_objects'][arm]), inputs={})
            try:
                outputs[arm] = [tuple(row) for row in store.db.execute(
                    'SELECT symbol,alpha_allocation FROM daily_recommendations ORDER BY symbol')]
                assert store.db.execute('SELECT cash FROM paper_accounts WHERE id=1').fetchone()[0] == 100000
            finally:
                store.db.close()
        assert outputs['baseline'] != outputs['candidate']
        assert packet['initial_account']['nav'] == 100000
        assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
        schedule = packet['schedule']
        assert len(schedule) == 281
        source_receipt = {'session_date': '2026-09-08', 'complete': True,
            'schedule_checksum': digest(schedule), 'closed_at': '2026-09-08T06:20:00Z',
            'corporate_actions_complete': True, 'corporate_actions': [], 'closing_marks': {}}
        closed = datetime(2026, 9, 8, 7, tzinfo=timezone.utc)
        class Source:
            def read(self, operation, request, frame):
                if operation == 'source_kv':
                    value = json.dumps(corporate_source) if request['key'] == 'market:corporate_actions:v1:2026-09-08' else None
                elif operation == 'source_sql':
                    # Empty synthetic market/model tables, not invented fills.
                    value = {'success': True, 'results': query_source(request['sql'], request.get('args') or []), 'meta': {'changes': 0}}
                else:
                    raise AssertionError((operation, request))
                return {'request': request, 'response': value, 'captured_at': frame['observed_at']}
        tapes, final_checksums = {}, {}
        for arm in ('baseline', 'candidate'):
            captured = run_native_paper_frames(**objects.get(packet['initial_state_objects'][arm]),
                frames=schedule, account_id=1, variables={}, runner=native_runner, capture_source=Source(),
                frame_inputs={f['input_id']: {**f, 'capture_kv_reads': True,
                    'kv_read_policy': KV_READ_POLICY, 'source_tables': packet['source_tables']} for f in schedule})
            tapes[arm] = {'frames': captured['captured_inputs'], 'source_receipt': deepcopy(source_receipt)}
            final_checksums[arm] = captured['state_checksum']
        kwargs = dict(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer,
            runner=native_runner, now=closed, state_objects=objects,
            tapes=tapes, expected_final_checksums=final_checksums,
            states={arm: objects.get(packet['initial_state_objects'][arm]) for arm in ('baseline', 'candidate')})
        executed = run_paired_session(**kwargs)
        assert run_paired_session(**kwargs)['receipt_snapshot_id'] == executed['receipt_snapshot_id']
        maturity = mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=closed)
        assert maturity['processed_pair_sessions'] == 1
        journal = json.loads(db.query('SELECT payload_json FROM paired_nav_daily_journal_v1', [])[0]['payload_json'])
        assert journal['arms']['candidate']['nav'] == journal['arms']['baseline']['nav'] == 100000
        assert journal['net_return_delta'] == 0  # Accounting proof, NOT economic benefit.
        from nav_read_model_bridge import assert_original_read_model
        assert_original_read_model(db, tmp_path, business_date='2026-09-08', owner='opb_arm_prior', sessions=1)
        assert journal['promotion_allowed'] is False
        evidence = read_verified_nav_evidence(business_date='2026-09-08', query=db.query, now=closed)
        population = evidence.summary()['candidate_population']
        assert population['pairs'][0]['accounted_sessions'] == 1
        assert population['pairs'][0]['owner'] == 'opb_arm_prior'
        from services.paired_nav_candidate_decision import read_nav_candidate_decision
        from services.paired_nav_daily_review import run_daily_nav_reviews
        reviewed = run_daily_nav_reviews(business_date='2026-09-08', query=db.query, writer=db.writer, now=closed)
        assert reviewed['status'] == 'daily_nav_reviews_current' and not reviewed['failures']
        member = population['pairs'][0]
        decision = read_nav_candidate_decision(owner='opb_arm_prior', candidate_checksum=member['candidate_checksum'],
            candidate_artifact_id=member['candidate_artifact_ids'][0], business_date='2026-09-08', query=db.query, now=closed)
        assert decision['decision'] == 'PENDING' and decision['evaluable_date_count'] == 1
        assert decision['reason'] == 'nav_mature_sessions_below_checkpoint'
        assert decision['minimum_evaluable_dates'] == POLICY.minimum_sessions == 10
        assert decision['promotion_allowed'] is False
        from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
        projected = refresh_registered_opb_nav_decisions(business_date='2026-09-08',
            query=db.query, writer=db.writer, now=closed)
        assert projected['evaluated_count'] == 1 and not projected['failures']
        gate = json.loads(db.query('SELECT live_evidence_json FROM model_artifact_registry', [])[0]['live_evidence_json'])
        assert gate['nav_validation'] == decision and gate['evaluable_date_count'] == 1
        assert not db.query("SELECT * FROM paired_nav_review_records_v1 WHERE record_kind='reservation'", [])
        # The real native execution registration must feed the NEXT day's
        # original allocator even after a mutable registry archive. No fresh
        # artifact, fake maturity, promotion or replacement ledger is created.
        db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
        next_clock = datetime(2026, 9, 8, 14, tzinfo=timezone.utc)
        next_content = deepcopy(content)
        next_content['opb_candidate_selection'] = module.select_opb_candidates(
            query=db.query, signal_date='2026-09-08', now=next_clock)
        next_parent = freeze_snapshot(signal_date='2026-09-08', source_run_id='native-opb-next-day',
            snapshot_kind='allocation_context', content=next_content, query=db.query, writer=db.writer, now=next_clock)
        monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=next_clock))
        next_result = collect(db, next_parent)
        assert not next_result.get('candidate_failures') and len(next_result['plans']) == 1, next_result
        assert next_result['plans'][0]['pair_id'] == plan['pair_id']
        assert not next_result['lifecycle_transition_plan']
        assert len(db.query('SELECT * FROM paired_nav_daily_journal_v1', [])) == 1
        assert db.query('SELECT state FROM model_artifact_registry', [])[0]['state'] == 'archived'
        assert source.total_changes == before
    finally:
        source.close()


from test_native_paper_sandbox import native_runner
