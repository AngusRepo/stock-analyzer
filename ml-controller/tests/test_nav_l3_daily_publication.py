"""Daily consumer -> original publisher -> serving readers, private SQLite only.

The mature NAV fixture is synthetic, not a measured investment result.
"""
import asyncio
import json

import pytest

from test_nav_l3_adoption import ready, prepared, environment, SESSIONS
from services.paired_nav_daily_adoption import run_daily_ev_adoption


def candidate_entry(ready, *, state='candidate', decision='PASS'):
    _, row, nav, *_ = ready
    return {'owner': 'ensemble', 'registry_state': state, 'payload': {
        'artifact_id': row['artifact_id'], 'artifact_checksum': row['payload_checksum'],
        'artifact': json.loads(row['payload_json']), 'training_run_id': row['training_run_id'],
        'source_run_date': '2026-09-07', 'evaluation_business_date': SESSIONS[-1],
        'prospective_validation': {'decision': decision, 'nav_validation': nav}}}


def run(ready, monkeypatch, **kwargs):
    from routers import model_pool
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', ready[0])
    return asyncio.run(run_daily_ev_adoption(candidates=[candidate_entry(ready, **kwargs)],
                                            business_date=SESSIONS[-1]))


def test_daily_publication_and_retry_use_original_transaction_and_receipt(ready, monkeypatch):
    client = ready[0]
    reviews = client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    first = run(ready, monkeypatch)
    assert first['status'] == 'completed', first
    receipt = first['ensemble']
    assert receipt['complete'] and receipt['serving_readers_verified']
    assert receipt['completion_scope'] == 'publication'
    assert receipt['serving_activation_verified'] is False
    assert receipt['inference']['status'] == 'awaiting_next_inference'
    second = run(ready, monkeypatch, state='production', decision='HOLD')
    assert second['status'] == 'completed', second
    assert second['ensemble']['recovered_existing_commit']
    assert second['ensemble']['publication_receipt_checksum'] == receipt['publication_receipt_checksum']
    assert second['ensemble']['inference']['published_at'] == receipt['inference']['published_at']
    assert second['ensemble']['inference']['status'] == 'not_observed'
    assert second['ensemble']['inference']['executed'] is None
    assert client.batches == 1
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == reviews


@pytest.mark.parametrize('decision', ['HOLD', 'PENDING'])
def test_daily_nonpass_does_not_publish(ready, monkeypatch, decision):
    result = run(ready, monkeypatch, decision=decision)
    assert result['status'] == 'no_adoption_due'
    assert ready[0].batches == 0


def test_committed_but_unreadable_is_not_success(ready, monkeypatch):
    assert run(ready, monkeypatch)['status'] == 'completed'
    ready[4]['risk_config']['changed_after_commit'] = True
    result = run(ready, monkeypatch, state='production')
    assert result['status'] == 'incomplete' and result['stage'] == 'ensemble_publication'
    assert ready[0].batches == 1


def test_unpublished_changed_comparator_waits_without_publication_or_retry(ready, monkeypatch):
    client, _, nav, _, current = ready
    before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    reviews = client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id')
    current['risk_config']['maxSingleNamePct'] = .20
    result = run(ready, monkeypatch)
    assert result['status'] == 'completed', result
    assert result['ensemble']['complete'] is False
    assert result['ensemble']['pointer_committed'] is False
    assert result['ensemble']['completion_scope'] == 'candidate_comparison'
    observation = result['ensemble']['comparison']
    assert observation['decision_checksum'] == nav['decision_checksum']
    assert observation['changed_fields'] == ['risk_config']
    assert observation['nav_maturity_credit'] == 0
    assert result['waiting'][0]['state'] == 'baseline_changed'
    assert client.batches == 0
    assert client.query('SELECT * FROM active8_ensemble_pointer_v1') == before
    assert client.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id') == reviews
    from copy import deepcopy
    from services.paired_nav_daily_adoption import candidate_comparison_wait
    from services.paired_nav_journal import digest
    payload = candidate_entry(ready)['payload']
    for fault in ('checksum', 'decision', 'publication', 'source', 'empty_change'):
        bad = deepcopy(result['ensemble'])
        value = bad['comparison']
        if fault == 'checksum': value['observation_checksum'] = 'f' * 64
        elif fault == 'decision': value['decision_checksum'] = 'f' * 64
        elif fault == 'publication': bad['pointer_committed'] = True
        elif fault == 'source': value['source'] = 'unverified_source'
        else: value['changed_fields'] = []
        if fault != 'checksum':
            value['observation_checksum'] = digest({k: v for k, v in value.items() if k != 'observation_checksum'})
        with pytest.raises(ValueError, match='nav_ensemble_comparison_observation_invalid'):
            candidate_comparison_wait(payload, bad, business_date=SESSIONS[-1], owner='ensemble')


@pytest.mark.parametrize('fault', ['missing_config', 'dangling_ml', 'corrupt_review', 'racing_config'])
def test_changed_comparator_does_not_hide_broken_source(ready, monkeypatch, fault):
    from copy import deepcopy
    from services import active8_nav_adoption as authority
    client, _, nav, _, current = ready
    current['risk_config']['maxSingleNamePct'] = .20
    if fault == 'missing_config':
        current['risk_config'] = None
    elif fault == 'dangling_ml':
        client.conn.execute("UPDATE active8_ensemble_pointer_v1 SET payload_checksum=printf('%064d',8)")
    elif fault == 'corrupt_review':
        original = client.query
        def damaged(sql, params=None, **kw):
            rows = original(sql, params, **kw)
            if sql.startswith('SELECT part_no,payload_text FROM paired_nav_review_parts_v1') and params == [nav['review_record_id']]:
                return []
            return rows
        monkeypatch.setattr(client, 'query', damaged)
    else:
        calls = 0
        def changing():
            nonlocal calls
            calls += 1
            copy = deepcopy(current)
            if calls > 1: copy['risk_config']['maxSingleNamePct'] = .15
            return copy
        monkeypatch.setattr(authority, 'current_execution_configuration', changing)
    before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    result = run(ready, monkeypatch)
    assert result['status'] == 'incomplete' and result['stage'] == 'ensemble_publication', result
    assert not result['waiting']
    assert client.batches == 0 and client.query('SELECT * FROM active8_ensemble_pointer_v1') == before


def test_coherent_replacement_ml_baseline_is_wait_not_reuse_of_old_effect(ready, monkeypatch):
    from services.active8_ensemble_repository import _exact_artifact_row
    from services.paired_nav_journal import digest
    client, _, nav, *_ = ready
    pointer = client.query('SELECT * FROM active8_ensemble_pointer_v1')[0]
    old = client.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [pointer['artifact_id']])[0]
    artifact = json.loads(old['payload_json'])
    artifact['cohort_id'] += '-replacement'
    artifact['fit']['intercept'] += .01
    artifact.pop('payload_checksum')
    artifact['payload_checksum'] = digest(artifact)
    replacement = _exact_artifact_row(artifact, training_run_id=old['training_run_id'], archive_uri='test://replacement')
    replacement.update(state='production', production_effect=1)
    client.insert('active8_ensemble_artifacts_v1', replacement)
    client.conn.execute('UPDATE active8_ensemble_pointer_v1 SET artifact_id=?,payload_checksum=?,cohort_id=?',
        [replacement['artifact_id'], replacement['payload_checksum'], replacement['cohort_id']])
    before = client.query('SELECT * FROM active8_ensemble_pointer_v1')
    result = run(ready, monkeypatch)
    assert result['status'] == 'completed', result
    assert result['ensemble']['comparison']['changed_fields'] == ['formal_ml']
    assert result['ensemble']['comparison']['decision_checksum'] == nav['decision_checksum']
    assert result['ensemble']['complete'] is False and result['ensemble']['pointer_committed'] is False
    assert client.batches == 0 and client.query('SELECT * FROM active8_ensemble_pointer_v1') == before


@pytest.mark.parametrize('ready,complete_population,changed_comparator',
    [(True, True, False), (False, False, False), (True, True, True)], indirect=['ready'])
def test_original_daily_job_materializes_reviews_projects_and_adopts(ready, prepared, monkeypatch, complete_population, changed_comparator):
    from types import SimpleNamespace
    import oof_materialize_job_main as job
    from routers import model_pool
    from services import d1_domain_client, walk_forward_retrain
    from test_nav_l3_mature_evidence import stamp

    client = ready[0]
    if changed_comparator:
        ready[4]['risk_config']['maxSingleNamePct'] = .20
    db, bucket, *_ = prepared
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', client)
    monkeypatch.setattr(d1_domain_client, 'client_for_domain',
                        lambda domain: SimpleNamespace(query=client.query, batch_execute=db.writer, atomic_batch_execute=db.writer))
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: bucket)
    original_daily = job._execute_daily_nav
    monkeypatch.setattr(job, '_execute_daily_nav',
                        lambda **kw: original_daily(**kw, now=stamp(SESSIONS[-1])))
    async def offline_branch(**kwargs):
        assert kwargs['promote'] is False and kwargs['dispatch_full_fit'] is False
        return {'status': 'idempotent_complete'}
    monkeypatch.setattr(job, '_execute_oof_lifecycle', offline_branch)
    result = asyncio.run(job._execute_lifecycle(cadence='daily', end_date=SESSIONS[-1],
        promote=True, dispatch_full_fit=False, expected_cohort_id=None,
        continuation_attempt=0, continuation_only=False))
    for component in ('atomic_candidate_decisions', 'route_candidate_decisions'):
        assert component in result['paired_nav_maturity'], 'daily NAV silently omitted a policy owner'
        assert result['paired_nav_maturity'][component]['candidate_count'] == 0
        assert result['paired_nav_maturity'][component]['failures'] == []
    if not complete_population:
        nav = result['paired_nav_maturity']
        assert result['nav_retry_required'] is True and result['status'] == 'pending'
        assert nav['adoption']['status'] == 'blocked_by_nav_failure'
        assert nav['family_reviews']['failures'] == [
            {'reason': 'nav_daily_population_unresolved', 'counts': {'unmaterialized_selections': 20}}]
        assert client.batches == 0
        return
    assert result['nav_retry_required'] is False, {
        key: value for key, value in result['paired_nav_maturity'].items()
        if key in ('reason','error_type','adoption','candidate_decisions','l3_candidate_decisions')}
    nav = result['paired_nav_maturity']
    assert nav['journal_chain_verified'] and nav['family_reviews']['failures'] == []
    assert nav['l3_candidate_decisions']['decisions'][0]['decision'] == 'PASS'
    assert all(item['decision'] == 'HOLD' for item in nav['candidate_decisions']['decisions'])
    if changed_comparator:
        assert nav['adoption']['ensemble']['complete'] is False
        assert nav['adoption']['waiting'][0]['state'] == 'baseline_changed'
        assert 'nav_committed=none' in job._summary('isolated', result, mode='oof_lifecycle')
        assert 'nav_waiting=ensemble:baseline_changed' in job._summary('isolated', result, mode='oof_lifecycle')
        assert client.batches == 0
        return
    assert nav['adoption']['ensemble']['complete']
    assert nav['adoption']['ensemble']['inference']['executed'] is False
    assert '_adoption_candidates' not in nav
    assert client.batches == 1


@pytest.mark.parametrize('fault', ['date', 'artifact', 'checksum'])
def test_invalid_daily_request_cannot_publish_before_identity_check(ready, monkeypatch, fault):
    from copy import deepcopy
    from routers import model_pool
    monkeypatch.setattr(model_pool, 'LEARNING_D1_CLIENT', ready[0])
    item = deepcopy(candidate_entry(ready))
    if fault == 'date':
        item['payload']['evaluation_business_date'] = '2026-09-18'
    elif fault == 'artifact':
        item['payload']['artifact']['fit']['intercept'] = 99
    else:
        item['payload']['artifact_checksum'] = 'a' * 64
    result = asyncio.run(run_daily_ev_adoption(candidates=[item], business_date=SESSIONS[-1]))
    assert result['status'] == 'incomplete' and result['stage'] == 'ensemble_publication'
    assert ready[0].batches == 0


@pytest.mark.parametrize('ready', [True], indirect=True)
def test_waiting_l3_continues_original_next_day_capture_and_review(ready, prepared, monkeypatch):
    from copy import deepcopy
    from datetime import datetime, timedelta
    import test_paired_nav_l3_candidate as source
    from services import paired_nav_collection as capture, paired_nav_l3_candidate as l3
    from services import paired_nav_lifecycle as lifecycle, paired_nav_daily_review as daily
    from services import paired_nav_candidate_collection as ev_collection
    from services.paired_nav_candidate_collection import collect_candidate_allocations
    from services.paired_nav_l3_daily import refresh_registered_l3_nav_decisions
    from services.active8_score_semantics import normalize_active8_challenger_scores
    from services.paired_nav_journal import digest, read_snapshot, freeze_snapshot, stage_execution_receipt, mature_staged_pairs
    from test_paired_nav_execution_environment import environment_packet
    from test_paired_nav_journal import packet, receipt, FEES
    from test_nav_l3_mature_evidence import stamp

    db, bucket, manifest, original_inputs, _ = prepared
    ready[4]['risk_config']['maxSingleNamePct'] = .20
    assert run(ready, monkeypatch)['waiting'][0]['state'] == 'baseline_changed'
    old_rows = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    old_pairs = {row['pair_id'] for row in old_rows}
    old_reviews = db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id', [])
    signal, session = SESSIONS[-1], '2026-09-22'
    observed = stamp(signal) + timedelta(seconds=1)
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return observed
    monkeypatch.setattr(lifecycle, 'datetime', Clock)
    for module in (capture, l3, ev_collection):
        monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=observed))
    monkeypatch.setattr(source, 'DAY', signal)
    inputs = deepcopy(original_inputs)
    inputs['filter_options']['run_date'] = signal
    for row in inputs['screener_recs']:
        row['date'] = signal
    for payload in inputs['payloads']:
        for field in ('prices', 'indicators', 'chips'):
            for row in payload[field]: row['date'] = signal
    normalize_active8_challenger_scores(inputs['predictions'],
        candidate_rows={row['model']: row for row in manifest['active8_shadow_candidates']}, run_date=signal)
    selection = l3.load_candidate_ensembles(manifest=manifest, signal_date=signal,
        decision_cutoff=signal + 'T10:00:00Z', query=db.query)
    environment = environment_packet(day=signal)
    def changed_capture(**kwargs):
        return capture.run_and_capture_allocation(**{**kwargs, 'risk_config': deepcopy(ready[4]['risk_config'])},
            execution_environment_reader=lambda: deepcopy(environment))
    monkeypatch.setattr(source, 'run_and_capture_allocation', changed_capture)
    parent = source.seal((db, bucket, manifest, inputs, selection))
    collected = collect_candidate_allocations(snapshot_id=parent['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    assert not collected.get('owner_failures'), collected.get('owner_failures')
    plans = collected['plans']
    assert {item['owner'] for item in plans} == {'ensemble', 'l4_alpha_ev', 'allocator_ev_fusion'}, collected
    for item in plans:
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        assert plan['pair_id'] not in old_pairs
        execution = packet(session)
        execution.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
        execution.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': session + 'T00:00:00Z'}], source_context=environment['source_context'],
            variables=environment['source_context']['variables'])
        execution.update({key: environment[key] for key in ('execution_owner_version', 'account_id', 'kv_read_policy')})
        execution['configuration_checksum'] = digest(execution['configuration'])
        saved = freeze_snapshot(signal_date=signal, source_run_id=plan['pair_id'], snapshot_kind='execution_pair',
            content=execution, query=db.query, writer=db.writer, now=observed)
        stage_execution_receipt(execution=receipt(execution, saved), query=db.query, writer=db.writer, now=stamp(session))
    closed = lifecycle.close_changed_comparisons(plans=plans, signal_date=signal, query=db.query, writer=db.writer, now=observed)
    assert len(closed) == 3 and all(item['inherited_mature_sessions'] == 0 for item in closed)
    mature_staged_pairs(business_date=session, query=db.query, writer=db.writer, now=stamp(session))
    reviewed = daily.run_daily_nav_reviews(business_date=session, query=db.query, writer=db.writer, now=stamp(session))
    assert reviewed['failures'] == [], reviewed
    projected = refresh_registered_l3_nav_decisions(business_date=session, query=db.query, now=stamp(session))
    assert projected['failure_count'] == 0 and projected['decisions'][0]['decision'] == 'PENDING'
    assert projected['decisions'][0]['evaluable_date_count'] == 1
    assert [row for row in db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
        if row['pair_id'] in old_pairs] == old_rows
    assert db.query('SELECT * FROM paired_nav_review_records_v1 ORDER BY record_id', []) == old_reviews
