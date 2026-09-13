"""Original NAV ledger->reserved review->primary EV gate; synthetic, NOT ROI."""
from copy import deepcopy
from datetime import datetime
import json

import pytest

from services import paired_nav_candidate_decision as decision
from services import paired_nav_daily_review as daily
from services import paired_nav_review_store as store
from services.expected_return_candidate_forward_evaluator import _load_candidate_packet
from services.paired_nav_expected_return_gate import nav_promotion_gate
from services.paired_nav_journal import digest, freeze_snapshot
from test_paired_nav_lifecycle import environment, stamp, collect
from test_paired_nav_review_store import migrate, two_sessions
from test_paired_nav_daily_review import local_policy, append_session


def candidate(environment, owner='l4_alpha_ev'):
    db, bucket, *_ = environment
    row = db.query('SELECT * FROM model_artifact_registry WHERE model_name=?', [owner])[0]
    result = _load_candidate_packet(bucket, row)
    result['selection_semantic_floor_date'] = '2026-08-25'
    return result


def read(environment, owner='l4_alpha_ev', day='2026-09-09'):
    c = candidate(environment, owner)
    return decision.read_nav_candidate_decision(owner=owner, candidate_checksum=c['checksum'],
        candidate_artifact_id=c['registry']['artifact_id'], business_date=day,
        query=environment[0].query, now=stamp(day))


def test_reader_requires_recorded_checkpoint_and_never_spends(environment, monkeypatch, local_policy):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    waiting = read(environment)
    assert waiting['decision'] == 'PENDING'
    assert waiting['reason'] == 'nav_checkpoint_review_not_recorded'
    assert db.query(f'SELECT * FROM {store.RECORDS}', []) == []
    daily.run_daily_nav_reviews(business_date='2026-09-09', query=db.query, writer=db.writer, now=stamp('2026-09-09'))
    before = db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', [])
    result = read(environment)
    assert result['decision'] == 'HOLD'
    assert result['mean_daily_nav_delta'] == pytest.approx(.0024)
    assert result['evaluable_date_count'] == 2 and result['review_id'] == 'sessions_2'
    assert result['review_record_checksum'] and result['reservation_checksum']
    assert read(environment) == result
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == before
    query = db.query
    scope = decision.NavCandidateDecisionReadScope(query=query, business_date='2026-09-09', now=stamp('2026-09-09'))
    c = candidate(environment)
    identity = dict(owner='l4_alpha_ev', candidate_checksum=c['checksum'], candidate_artifact_id=c['registry']['artifact_id'])
    original_review, calls = decision._review_evidence, []
    def counted(*args, **kwargs):
        calls.append(kwargs['review_id'])
        return original_review(*args, **kwargs)
    monkeypatch.setattr(decision, '_review_evidence', counted)
    assert scope.read(**identity) == result
    assert scope.read(**identity) == result
    assert len(calls) == 1, 'same request reuses original family verification, not another review'
    fresh = decision.NavCandidateDecisionReadScope(query=query, business_date='2026-09-09', now=stamp('2026-09-09'))
    assert fresh.read(**identity) == result and len(calls) == 2, 'new request must reverify original source'
    for changed in ({'query': lambda sql, params: []}, {'business_date': '2026-09-08'}, {'now': stamp('2026-09-10')}):
        with pytest.raises(ValueError, match='nav_decision_read_scope_mismatch'):
            decision.read_nav_candidate_decision(**identity, **{
                'query': query, 'business_date': '2026-09-09', 'now': stamp('2026-09-09'), **changed}, _scope=scope)
    assert db.query(f'SELECT * FROM {store.RECORDS} ORDER BY record_id', []) == before


def test_reader_recomputes_source_even_if_tampered_body_has_matching_hash(environment, monkeypatch, local_policy):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    daily.run_daily_nav_reviews(business_date='2026-09-09', query=db.query, writer=db.writer, now=stamp('2026-09-09'))
    result = read(environment)
    key = result['review_record_id']
    saved = store.read_review_record(query=db.query, record_id=key)
    forged = deepcopy(saved['body'])
    forged['family']['hypotheses'][0]['numerical_support'] = True
    forged['family']['hypotheses'][0]['holm_adjusted_p'] = 0.0
    original = db.query
    def altered(sql, params):
        rows = original(sql, params)
        if params == [key] and store.RECORDS in sql:
            return [{**r, 'payload_checksum': digest(forged)} for r in rows]
        if params == [key] and store.PARTS in sql:
            return [{'part_no':0, 'payload_text':json.dumps(forged)}]
        return rows
    monkeypatch.setattr(db, 'query', altered)
    with pytest.raises(ValueError, match='nav_decision_review_source_mismatch'):
        read(environment)


def test_new_configuration_cannot_inherit_old_review(environment, monkeypatch, local_policy):
    from services import paired_nav_candidate_collection as collection
    db, _, _, content = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    daily.run_daily_nav_reviews(business_date='2026-09-09', query=db.query, writer=db.writer, now=stamp('2026-09-09'))
    before = read(environment)
    updated = deepcopy(content)
    updated['risk_config']['maxSingleNamePct'] = .20
    context = freeze_snapshot(signal_date='2026-09-09', source_run_id='new-config', snapshot_kind='allocation_context',
        content=updated, query=db.query, writer=db.writer, now=stamp('2026-09-09'))
    monkeypatch.setattr(collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp('2026-09-09')))
    assert collect(environment, context)['plans']
    result = read(environment)
    assert result['decision'] == 'PENDING' and result['evaluable_date_count'] == 0
    assert result['configuration_checksum'] != before['configuration_checksum']
    assert len(db.query('SELECT * FROM paired_nav_daily_journal_v1', [])) == 4


def test_pending_next_allocation_does_not_erase_verified_mature_dates(environment, monkeypatch):
    db, _, _, content = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    before = read(environment)
    assert before['evaluable_date_count'] == 2
    journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    from services.paired_nav_ev_selection import select_ev_candidates
    pending = deepcopy(content)
    pending['ev_candidate_selection'] = select_ev_candidates(snapshot_id='pending-next-allocation',
        signal_date='2026-09-09', query=db.query)
    freeze_snapshot(signal_date='2026-09-09', source_run_id='pending-next-allocation',
        snapshot_kind='allocation_context', content=pending, query=db.query,
        writer=db.writer, now=stamp('2026-09-09'))
    held = read(environment)
    assert held['decision'] == 'HOLD' and held['reason'] == 'nav_current_population_incomplete'
    assert held.get('evaluable_date_count') == 2
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == journals


def test_real_ten_session_nav_gate_does_not_require_positive_cross_section_diagnostic(environment, monkeypatch, tmp_path):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    sessions = ['2026-09-10','2026-09-11','2026-09-14','2026-09-15',
                '2026-09-16','2026-09-17','2026-09-18','2026-09-21']
    previous = '2026-09-09'
    for i, day in enumerate(sessions):
        append_session(environment, monkeypatch, previous, day, 150 + i*50)
        previous = day
    day = sessions[-1]
    recorded = daily.run_daily_nav_reviews(business_date=day, query=db.query, writer=db.writer, now=stamp(day))
    assert not recorded['failures']
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return stamp(day)
    monkeypatch.setattr(decision, 'datetime', Clock)
    for owner in ('l4_alpha_ev','allocator_ev_fusion'):
        gate = nav_promotion_gate([], owner=owner, candidate=candidate(environment, owner),
            business_date=day, query_fn=db.query)
        assert gate['decision'] == 'PASS', gate['failed_gates']
        assert gate['schema_version'] == 'expected-return-candidate-nav-gate-v1'
        assert gate['evaluable_date_count'] == 10
        assert gate['cross_section_diagnostic']['decision'] != 'PASS'
        assert gate['cross_section_diagnostic']['evaluated_as_of_date'] == day
        preserved = deepcopy(gate['cross_section_diagnostic'])
        preserved['evaluated_as_of_date'] = '2026-09-09'
        refreshed = nav_promotion_gate([], owner=owner, candidate=candidate(environment, owner),
            business_date=day, query_fn=db.query, diagnostic_error=preserved)
        assert refreshed['cross_section_diagnostic'] == preserved
        assert refreshed['nav_validation'] == gate['nav_validation']
        assert gate['nav_validation']['review_record_id']
        assert gate['nav_validation']['universal_profit_guarantee'] is False
        # Real ten-session numerical support, not a fabricated PASS. Even a
        # broken legacy summary cannot supply or revoke original NAV support.
        from services import expected_return_candidate_forward_evaluator as ev
        with monkeypatch.context() as patch:
            def broken_diagnostic(*_args, **_kwargs):
                raise RuntimeError('fixture_legacy_summary_failed')
            patch.setattr(ev, '_promotion_gate', broken_diagnostic)
            diagnosed = nav_promotion_gate([], owner=owner, candidate=candidate(environment, owner),
                business_date=day, query_fn=db.query)
        assert diagnosed['decision'] == 'PASS'
        assert diagnosed['nav_validation'] == gate['nav_validation']
        assert diagnosed['cross_section_diagnostic']['status'] == 'failed'

    # Actual evaluator entry point + original SQL write/read-back, not a mocked
    # gate. Empty cross-section diagnostics must not veto valid NAV evidence.
    from services.expected_return_candidate_forward_evaluator import evaluate_expected_return_candidates_forward
    original_query = db.query
    def query(sql, params):
        if 'MIN(signal_date)' in sql:
            return [{'selection_semantic_floor_date': '2026-08-25'}]
        if 'expected_return_candidate_preoutcome_evaluations' in sql:
            return []
        return original_query(sql, params)
    immutable_before = {
        table: db.query(f'SELECT * FROM {table} ORDER BY 1', [])
        for table in (store.RECORDS, store.PARTS, 'paired_nav_daily_journal_v1')}
    c = candidate(environment)
    result = evaluate_expected_return_candidates_forward(
        bucket=environment[1], cohort_id='new-active-observation-cohort',
        business_date=day, extension_manifest_checksum='e' * 64,
        snapshot_rows=[], build_fusion_rows_fn=lambda *_a, **_kw: pytest.fail('no OOF input'),
        query_fn=query, batch_fn=lambda statements, **_kw: db.writer(statements))
    assert result['status'] == 'evaluated' and result['promotion_ready']
    assert set(result['promotion_payload']) == {'l4_alpha_ev', 'allocator_ev_fusion'}
    assert not result['training_dispatched']
    for owner, payload in result['promotion_payload'].items():
        assert payload['cadence'] == 'daily_candidate_nav'
        assert payload['cohort_id'] == c['packet']['cohort_id']
        assert payload['evaluation_cohort_id'] == 'new-active-observation-cohort'
        row = db.query('SELECT * FROM model_artifact_registry WHERE model_name=?', [owner])[0]
        assert row['state'] != 'production'
        assert row['live_gate_status'] == 'passed'
        assert json.loads(row['live_evidence_json']) == payload['prospective_validation']
    for table, before in immutable_before.items():
        assert db.query(f'SELECT * FROM {table} ORDER BY 1', []) == before

    # Cross-language consumer consumes exported ORIGINAL record bytes, including
    # Python float spelling and seeds larger than JS safe integers.
    import os
    import subprocess
    from pathlib import Path
    fixture = tmp_path / 'original-nav-review.json'
    fixture.write_text(json.dumps({'now': stamp(day).isoformat(), 'payloads': result['promotion_payload'],
        'registry_schema': db.query("SELECT sql FROM sqlite_master WHERE name='model_artifact_registry'", [])[0]['sql'],
        'tables': {**immutable_before,
            'paired_nav_frozen_manifests_v1': db.query('SELECT * FROM paired_nav_frozen_manifests_v1', []),
            'paired_nav_frozen_parts_v1': db.query('SELECT * FROM paired_nav_frozen_parts_v1', []),
            'model_artifact_registry': db.query('SELECT * FROM model_artifact_registry', [])}},
        ensure_ascii=False), encoding='utf-8')
    checked = subprocess.run(['node', '--import', 'tsx', '--test', 'src/lib/pairedNavPromotionEvidence.test.ts'],
        cwd=Path(__file__).parents[2] / 'worker', env={**os.environ, 'NAV_ORIGINAL_FIXTURE': str(fixture)},
        capture_output=True, text=True, timeout=90, encoding='utf-8')
    assert checked.returncode == 0, checked.stdout + checked.stderr

    checked_maturity = subprocess.run(['node', '--import', 'tsx', 'tests/expectedReturnNavMaturity.ts'],
        cwd=Path(__file__).parents[2] / 'worker', env={**os.environ, 'NAV_ORIGINAL_FIXTURE': str(fixture)},
        capture_output=True, text=True, timeout=90, encoding='utf-8')
    assert checked_maturity.returncode == 0, checked_maturity.stdout + checked_maturity.stderr
    checked_room = subprocess.run(['node', '--import', 'tsx', 'tests/navTradingRoom.ts'],
        cwd=Path(__file__).parents[2] / 'worker', env={**os.environ, 'NAV_ORIGINAL_FIXTURE': str(fixture)},
        capture_output=True, text=True, timeout=90, encoding='utf-8')
    assert checked_room.returncode == 0, checked_room.stdout + checked_room.stderr
    checked_render = subprocess.run(['node', '--import', 'tsx', '--test', '../frontend/tests/nav-maturity.render.test.tsx'],
        cwd=Path(__file__).parents[2] / 'worker', env={**os.environ, 'NAV_ORIGINAL_FIXTURE': str(fixture),
            'TSX_TSCONFIG_PATH': str(Path(__file__).parents[2] / 'frontend/tsconfig.json')},
        capture_output=True, text=True, timeout=90, encoding='utf-8')
    assert checked_render.returncode == 0, checked_render.stdout + checked_render.stderr

    # Consume actual Hono HTTP responses using the real Controller receipt
    # reducer. Confirmed pointer + failed/missing KV projection is not closure.
    from routers.walk_forward import _candidate_forward_promotion_closure
    http_recoveries = json.loads(Path(str(fixture) + '.http-recovery.json').read_text())
    assert len(http_recoveries) == 8
    for item in http_recoveries:
        payload = {item['owner']: result['promotion_payload'][item['owner']]}
        closure = _candidate_forward_promotion_closure(payload, item['response'])
        assert closure['complete'] is item['expected_complete'], closure
        assert closure['promoted_any'] is True
        assert closure['promoted_by_owner'][item['owner']] is True

    http_comparisons = json.loads(Path(str(fixture) + '.http-comparison.json').read_text())
    assert {item['owner'] for item in http_comparisons} == set(result['promotion_payload'])
    for item in http_comparisons:
        owner, response = item['owner'], item['response']
        payload = {owner: result['promotion_payload'][owner]}
        closure = _candidate_forward_promotion_closure(payload, response, business_date=day)
        assert closure['processing_complete'] is True
        assert closure['complete'] is False and closure['promoted_any'] is False
        assert set(closure['waiting_by_owner']) == {owner}
        assert response['success'] is False and response['processing_complete'] is True
        assert response['effective_owner'] is None
        # Even resealed observations cannot invent credit, grant publication,
        # substitute identities, or claim another source of authority.
        for field, value in [('nav_maturity_credit', 1), ('decision_checksum', '0' * 64),
                             ('source', 'unverified'), ('promotion_allowed', True)]:
            invalid_response = deepcopy(response)
            observation = invalid_response['outcomes'][owner]['comparison']
            observation[field] = value
            observation['observation_checksum'] = digest({k: v for k, v in observation.items()
                if k != 'observation_checksum'})
            with pytest.raises(ValueError, match='nav_ev_comparison_observation_invalid'):
                _candidate_forward_promotion_closure(payload, invalid_response, business_date=day)

    # Real daily materialization + original NAV evaluation hands the SAME frozen
    # identities to adoption before OOF. Transport uses real Hono responses above;
    # No OPB is rebuilt here: only frozen mature candidates may be adopted.
    import asyncio
    from types import SimpleNamespace
    import oof_materialize_job_main as job
    from services import d1_domain_client, walk_forward_retrain, worker_config_client
    monkeypatch.setattr(d1_domain_client, 'client_for_domain', lambda _domain:
        SimpleNamespace(query=db.query, batch_execute=db.writer, atomic_batch_execute=db.writer))
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: environment[1])
    original_daily = job._execute_daily_nav
    monkeypatch.setattr(job, '_execute_daily_nav', lambda **kw: original_daily(**kw, now=stamp(day)))
    successful_outcomes = {item['owner']: item['response']['outcomes'][item['owner']]
                           for item in http_recoveries if item['expected_complete']}
    effective_owner = next(item['response']['effective_owner'] for item in reversed(http_recoveries)
                           if item['expected_complete'])
    assert successful_outcomes[effective_owner]['pointer_commit']['nav_review_date'] == day
    order = []
    async def transport(path, **kwargs):
        if path.endswith('/promote'):
            order.append('adoption')
            assert set(kwargs['json_body']) == set(result['promotion_payload'])
            for owner, p in kwargs['json_body'].items():
                assert p['evaluation_cohort_id'] is None
                assert p['evaluation_business_date'] == day
                assert p['cohort_id'] == result['promotion_payload'][owner]['cohort_id']
                assert p['artifact_checksum'] == result['promotion_payload'][owner]['artifact_checksum']
                assert p['prospective_validation']['nav_validation'] == result['promotion_payload'][owner]['prospective_validation']['nav_validation']
            return {'outcomes': successful_outcomes, 'effective_owner': effective_owner}
        assert path == (f'/api/admin/trigger/opb-arm-prior-refresh?sync=1&date={day}'
                        f'&expected_return_owner={effective_owner}')
        order.append('register_opb')
        # Registration transport only. Actual builder/immutable SQL/Worker path
        # is exercised in test_opb_original_registry_pipeline.
        from test_nav_adoption_closure import registration_summary
        return {'success': True, 'result': registration_summary(effective_owner).replace('2026-09-09', day)}
    async def unavailable_oof(**kwargs):
        order.append('oof')
        assert kwargs['promote'] is False and kwargs['dispatch_full_fit'] is False
        raise RuntimeError('fixture_oof_unavailable_after_daily_adoption')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', transport)
    monkeypatch.setattr(job, '_execute_oof_lifecycle', unavailable_oof)
    executed = asyncio.run(job._execute_lifecycle(cadence='daily', end_date=day, promote=True,
        dispatch_full_fit=False, expected_cohort_id=None, continuation_attempt=0, continuation_only=False))
    assert order == ['adoption', 'register_opb', 'oof']
    assert executed['paired_nav_maturity']['adoption']['opb']['status'] == 'no_adoption_due'
    assert executed['paired_nav_maturity']['adoption']['status'] == 'completed'
    assert executed['status'] == 'failed' and executed['nav_retry_required'] is False
    summary = job._summary('original-nav-fixture', executed, mode='oof_lifecycle')
    assert 'nav_adoption=completed' in summary
    assert 'nav_committed=allocator_ev_fusion,l4_alpha_ev' in summary

    # The original Worker processed BOTH requested owners in this single HTTP
    # request; the consumer must not turn either wait into publication credit.
    batch_wait = json.loads(Path(str(fixture) + '.http-comparison-batch.json').read_text())
    waiting_outcomes = batch_wait['outcomes']
    async def waiting_transport(path, **kwargs):
        assert path == '/api/admin/config/expected-return/promote'
        assert set(kwargs['json_body']) == set(waiting_outcomes)
        order.append('waiting_adoption')
        return batch_wait
    monkeypatch.setattr(worker_config_client, 'worker_fetch', waiting_transport)
    order.clear()
    waiting_job = asyncio.run(job._execute_lifecycle(cadence='daily', end_date=day, promote=True,
        dispatch_full_fit=False, expected_cohort_id=None, continuation_attempt=0, continuation_only=False))
    adoption = waiting_job['paired_nav_maturity']['adoption']
    assert order == ['waiting_adoption', 'oof']
    assert adoption['status'] == 'completed'
    assert adoption['closure']['complete'] is False
    assert adoption['closure']['processing_complete'] is True
    assert adoption['closure']['promoted_any'] is False
    assert {item['owner'] for item in adoption['waiting']} == set(waiting_outcomes)
    assert adoption['opb_candidate_registration']['status'] == 'no_effective_owner_change'
    assert waiting_job['nav_retry_required'] is False
    # Independent OOF failure remains visible; waiting is NOT full chain closure.
    assert waiting_job['status'] == 'failed'
    waiting_summary = job._summary('original-nav-waiting-fixture', waiting_job, mode='oof_lifecycle')
    assert 'nav_committed=allocator_ev_fusion' not in waiting_summary
    assert 'nav_committed=l4_alpha_ev' not in waiting_summary

    waiting_outcomes['l4_alpha_ev']['comparison']['observation_checksum'] = '0' * 64
    order.clear()
    corrupt_job = asyncio.run(job._execute_lifecycle(cadence='daily', end_date=day, promote=True,
        dispatch_full_fit=False, expected_cohort_id=None, continuation_attempt=0, continuation_only=False))
    corrupt_adoption = corrupt_job['paired_nav_maturity']['adoption']
    assert corrupt_adoption['status'] == 'incomplete'
    assert corrupt_adoption['error_type'] == 'ValueError'
    assert corrupt_adoption['stage'] == 'pointer_and_projection'
    assert corrupt_job['nav_retry_required'] is True
    for table, before in immutable_before.items():
        assert db.query(f'SELECT * FROM {table} ORDER BY 1', []) == before

    invalid = deepcopy(candidate(environment))
    invalid['operational_parity'] = {'owner_decisions': {'l4_alpha_ev': {
        'decision': 'FAIL', 'failed_gates': ['fixture_feature_mismatch']}}}
    gate = nav_promotion_gate([], owner='l4_alpha_ev', candidate=invalid,
        business_date=day, query_fn=db.query)
    assert gate['nav_validation']['decision'] == 'PASS'
    assert gate['decision'] == 'FAIL'
    assert 'owner_operational_parity_not_pass' in gate['contract_blockers']
