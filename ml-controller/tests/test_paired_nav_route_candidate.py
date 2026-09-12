"""L1.5 actual allocation/native account integration; synthetic fixtures, not ROI."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import sqlite3

import pytest

from services import paired_nav_route_candidate as route
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, mature_staged_pairs
from services.paired_nav_comparison import resolve_allocation_comparison
from services.paired_nav_population import read_candidate_population
from test_paired_nav_route_pit import prepared, environment, with_routes, route_freeze_clock
from test_paired_nav_l3_candidate import NOW
from test_native_paper_sandbox import native_runner


@pytest.mark.parametrize('serving', ['incumbent', 'challenger'])
def test_equal_allocations_still_freeze_one_comparison_and_retry_exactly(prepared, route_freeze_clock, serving):
    db, receipt = with_routes(prepared, serving=serving)
    before = read_candidate_population(business_date='2026-09-07', query=db.query, series=[])
    missing = [p for p in before['unmaterialized_selections'] if p['owner'] == 'l15_route']
    assert len(missing) == 1 and before['selection_materialization_complete'] is False
    result = route.collect_route_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    assert result['effect']['allocation_equal'] is True and len(result['plans']) == 1
    saved = read_snapshot(db.query, result['plans'][0]['snapshot_id'])
    comparison = resolve_allocation_comparison(query=db.query, allocation=saved)
    assert comparison['kind'] == 'route_policy_contrast'
    assert saved['payload']['content']['candidate_training_run_id'] == 'not_applicable:deterministic_runtime_router'
    assert route.collect_route_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer) == result
    after = read_candidate_population(business_date='2026-09-07', query=db.query, series=[])
    assert not [p for p in after['unmaterialized_selections'] if p['owner'] == 'l15_route']
    assert after['pairs'][0]['owner'] == 'l15_route' and after['pairs'][0]['execution_status'] == 'not_registered'
    assert after['pairs'][0]['exact_nav_sessions'] == 0
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


@pytest.mark.parametrize('fault', ['version', 'source', 'output', 'weights', 'equal', 'status', 'credit'])
def test_route_role_rejects_mislabelling_even_with_a_new_payload_checksum(prepared, route_freeze_clock, fault):
    db, receipt = with_routes(prepared)
    result = route.collect_route_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    saved = read_snapshot(db.query, result['plans'][0]['snapshot_id'])
    plan = deepcopy(saved['payload']['content'])
    if fault == 'version':
        plan['route_effect']['challenger_version'] = 'other'
    elif fault == 'source':
        plan['route_effect']['source_checksum'] = 'f' * 64
    elif fault == 'output':
        plan['candidate']['output'] = []
    elif fault == 'weights':
        plan['candidate']['capture']['effective_weights'] = {}
    elif fault == 'equal':
        plan['route_effect']['allocation_equal'] = False
    elif fault == 'status':
        plan['route_effect']['status'] = 'allocation_change_requires_paired_execution'
    else:
        plan['route_effect']['nav_maturity_credit'] = 1
    with pytest.raises(ValueError, match='paired_nav_route_comparison_'):
        route.verify_route_comparison(plan, read_snapshot(db.query, receipt['snapshot_id']))


def test_two_native_route_dates_keep_same_pair_cash_and_journal(prepared, native_runner, monkeypatch):
    from services.native_paper_source_capture import ImmutableNativeObjects
    from services.native_paper_sandbox import native_runtime_manifest, run_native_paper_frames
    from services.paired_native_registration import register_allocation_pair
    from services.paired_native_session import run_paired_session
    from services.paired_native_runtime import KV_READ_POLICY
    from services.paired_nav_recommendation_path import run_and_capture_recommendation_path
    from services.paired_nav_intervention import run_isolated_allocation
    from test_paired_native_session import full_cash_state, native_config
    from test_paired_native_registration import calendar
    from test_native_paper_source_capture import Bucket
    db, original = with_routes(prepared)
    from test_paired_nav_review_store import migrate
    from services.paired_nav_policy_daily import refresh_registered_route_nav_decisions
    migrate(db)
    original_context = read_snapshot(db.query, original['snapshot_id'])['payload']['content']
    config = native_config()  # Explicit kill-switch scenario exercises quiet dates, not returns.
    source = sqlite3.connect(':memory:')
    source.row_factory = sqlite3.Row
    source.executescript(full_cash_state(config))
    source.execute("UPDATE paper_settlements SET settlement_date=CASE WHEN settlement_date='2026-09-07' THEN '2026-09-08' ELSE '2026-09-09' END")
    for index, symbol in enumerate(['2330', '2317', '2454'], 1):
        source.execute('INSERT INTO stocks(id,symbol,name,market) VALUES(?,?,?,?)', [index, symbol, symbol, 'TWSE'])
        for day in ['2026-09-07', '2026-09-08']:
            source.execute('INSERT INTO daily_recommendations(date,stock_id,symbol,name,rank,score,reason) VALUES(?,?,?,?,?,?,?)',
                [day, index, symbol, symbol, index, 50, 'fixture'])
    objects = ImmutableNativeObjects(Bucket())
    owners = native_runtime_manifest(native_runner)['tables']
    source_query = lambda sql, args: [dict(row) for row in source.execute(sql, args)]
    source_changes = source.total_changes
    first_pair, first_journal = None, None
    try:
        for index, day in enumerate(['2026-09-07', '2026-09-08']):
            clock = datetime.fromisoformat(day + 'T14:00:00+00:00')
            monkeypatch.setattr(route, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=clock))
            context = json.loads(json.dumps(original_context).replace('2026-09-07', day))
            context.update(trading_config=config['trading'], risk_config=config['risk'])
            # Different daily route scores do not define a new policy/version.
            if index:
                for row in context['recommendation_context']['inputs']['screener_recs']:
                    for variant in ['l1_contrast', 'seed_contrast']:
                        row['l15_route_source'][variant]['challenger']['score'] += 1
            recommendation_inputs = deepcopy(context['recommendation_context']['inputs'])
            selection = context['recommendation_context'].get('l3_candidate_selection')
            recommendations, sealed_recommendations = run_and_capture_recommendation_path(
                inputs=recommendation_inputs, candidate_reader=lambda: selection)
            context['recommendation_context'] = sealed_recommendations
            context['inputs']['recommendations'] = recommendations['recommendations']
            allocation = run_isolated_allocation(inputs=deepcopy(context['inputs']), inherited_state={})
            context['formal_output'], context['capture'] = allocation['output'], allocation['capture']
            context['model_predictions'] = recommendation_inputs['predictions']
            parent = freeze_snapshot(signal_date=day, source_run_id='route-native:' + day,
                snapshot_kind='allocation_context', content=context, query=db.query, writer=db.writer, now=clock)
            collection = route.collect_route_allocations(snapshot_id=parent['snapshot_id'], query=db.query, writer=db.writer)
            plan = collection['plans'][0]
            if index == 0:
                first_pair = plan['pair_id']
            assert plan['pair_id'] == first_pair
            assert not collection['lifecycle_transition_plan']
            registered = register_allocation_pair(snapshot_id=plan['snapshot_id'], query=db.query, writer=db.writer,
                domain_queries={owner: source_query for owner in set(owners.values())}, kv_read=calendar,
                objects=objects, account_id=2, variables={}, kv_read_policy=KV_READ_POLICY,
                runner=native_runner, now=clock)
            packet = read_snapshot(db.query, registered['snapshot_id'])['payload']['content']
            states = {arm: objects.get(packet['initial_state_objects'][arm]) for arm in ['baseline', 'candidate']}
            if index:
                assert packet['previous_session_date'] == day
                for state in states.values():
                    with sqlite3.connect(':memory:') as private:
                        private.executescript(state['state_sql'])
                        assert private.execute('SELECT cash FROM paper_accounts WHERE id=2').fetchone()[0] == 92000
            session = packet['session_date']
            close = datetime.fromisoformat(session + 'T14:00:00+00:00')
            source_receipt = {'session_date': session, 'complete': True, 'schedule_checksum': digest(packet['schedule']),
                'closed_at': session + 'T06:20:00Z', 'corporate_actions_complete': True, 'corporate_actions': [], 'closing_marks': {}}
            class SessionSource:
                def read(self, operation, request, frame):
                    assert operation == 'source_kv', (operation, request)
                    key = request['key']
                    value = calendar(key)
                    if key == 'market:corporate_actions:v1:' + session:
                        value = json.dumps({'schema_version': 'paper-corporate-source-v1', 'session_date': session,
                            'observed_at': frame['observed_at'], 'source_checksum': digest(['fixture', session]),
                            'covered_symbols': [], 'actions': [], 'blockers': {}, 'tax_basis': 'gross_before_personal_tax'})
                    return {'request': request, 'response': value, 'captured_at': frame['observed_at']}
            tapes = {}
            expected_checksums = {}
            for arm in ['baseline', 'candidate']:
                inputs = {f['input_id']: {**f, 'capture_kv_reads': True, 'kv_read_policy': KV_READ_POLICY}
                    for f in packet['schedule']}
                captured = run_native_paper_frames(**states[arm], frame_inputs=inputs, frames=packet['schedule'],
                    account_id=2, variables={}, runner=native_runner, capture_source=SessionSource(),
                    expected_execution_owner_version=packet['execution_owner_version'])
                tapes[arm] = {'frames': captured['captured_inputs'], 'source_receipt': deepcopy(source_receipt)}
                expected_checksums[arm] = captured['state_checksum']
            output = run_paired_session(snapshot_id=registered['snapshot_id'], query=db.query, writer=db.writer,
                tapes=tapes, states=states, runner=native_runner, state_objects=objects, now=close,
                expected_final_checksums=expected_checksums)
            result = mature_staged_pairs(business_date=session, query=db.query, writer=db.writer, now=close)
            assert result['processed_pair_sessions'] == 1
            population = result['paired_nav_evidence']['candidate_population']
            pair = next(p for p in population['pairs'] if p['pair_id'] == first_pair)
            assert pair['accounted_sessions'] == index + 1
            assert pair['exact_nav_sessions'] == index + 1
            rows = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY session_date', [])
            if first_journal is None:
                first_journal = rows[0]
            assert rows[0] == first_journal
            assert len(rows) == index + 1
            body = json.loads(rows[-1]['payload_json'])
            assert body['comparison']['kind'] == 'route_policy_contrast'
            assert body['arms']['candidate']['nav'] == 99000 and body['net_return_delta'] == 0
            assert output['promotion_allowed'] is False
            before_read = db.conn.total_changes
            projected = refresh_registered_route_nav_decisions(business_date=session, query=db.query, now=close)
            assert projected['candidate_count'] == projected['evaluated_count'] == 1
            assert projected['failures'] == []
            assert projected['decisions'][0]['evaluable_date_count'] == index + 1
            assert projected['decisions'][0]['decision'] in {'PENDING', 'HOLD'}
            assert db.conn.total_changes == before_read
        assert source.total_changes == source_changes
        assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])
    finally:
        source.close()
