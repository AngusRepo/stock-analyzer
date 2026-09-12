"""Original numerical NAV review -> original Atomic publication, private only.

Synthetic execution differences test authority/transaction plumbing, NOT ROI.
No stub numerical PASS and no production credentials or network.
"""
import json
import os
from pathlib import Path
import subprocess
import asyncio
from time import perf_counter
from copy import deepcopy

import pytest

from services.paired_nav_journal import (read_snapshot, freeze_snapshot, digest,
    stage_execution_receipt, mature_staged_pairs)
from services.paired_nav_atomic_candidate import collect_atomic_allocations
from services.paired_nav_policy_daily import refresh_registered_atomic_nav_decisions, read_strategy_nav_evidence
from services.paired_nav_daily_review import run_daily_nav_reviews
from test_paired_nav_atomic_candidate import allocated, full_atomic, environment, native_runner
from test_paired_nav_atomic_dispatch import dispatched
from test_paired_nav_review_store import migrate
from test_paired_nav_lifecycle import stamp
from test_paired_nav_journal import packet, receipt, buy, FEES


@pytest.mark.parametrize('full_atomic', ['native_policy_weight_owner_complete'], indirect=True)
def test_original_atomic_nav_pass_native_publication(allocated, environment, monkeypatch, tmp_path):
    db, _, state = allocated
    root = Path(__file__).parents[2]
    migrate(db)
    result = collect_atomic_allocations(snapshot_id=state['paired_nav_collection']['snapshot_id'],
        query=db.query, writer=db.writer)
    assert result['plans'] and not result['unavailable'], result
    # Complete the OTHER original owners too. The shared denominator must not
    # be filtered down to the owner under test or ignore missing materialization.
    from services import paired_nav_candidate_collection as ev, paired_nav_route_candidate as route, paired_nav_l3_candidate as l3
    for module in (ev, route, l3):
        monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp(kw['signal_date'])))
    for snapshot in (environment[2]['snapshot_id'], state['paired_nav_collection']['snapshot_id']):
        ev.collect_candidate_allocations(snapshot_id=snapshot, query=db.query, writer=db.writer, bucket=environment[1])
    route.collect_route_allocations(snapshot_id=state['paired_nav_collection']['snapshot_id'], query=db.query, writer=db.writer)
    l3.collect_ensemble_allocations(snapshot_id=state['paired_nav_collection']['snapshot_id'], query=db.query, writer=db.writer)
    days = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14',
        '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21']
    for index, day in enumerate(days):
        previous = days[index - 1] if index else None
        signal = previous or '2026-09-07'
        for item in result['plans']:
            parent = read_snapshot(db.query, item['snapshot_id'])
            plan = parent['payload']['content']
            allocation_context = read_snapshot(db.query, plan['allocation_context_snapshot_id'])['payload']['content']
            execution_environment = allocation_context['native_execution_environment']
            p = packet(day, previous)
            p.update({key: execution_environment[key] for key in (
                'execution_owner_version', 'account_id', 'kv_read_policy', 'source_context')})
            p['variables'] = execution_environment['source_context']['variables']
            p.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
            p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
                schedule=[{'observed_at': day + 'T00:00:00Z'}])
            p['configuration_checksum'] = digest(p['configuration'])
            saved = freeze_snapshot(signal_date=parent['manifest']['signal_date'], source_run_id=p['pair_id'] + ':' + day,
                snapshot_kind='execution_pair', content=p, query=db.query, writer=db.writer, now=stamp(signal))
            # Deliberately artificial fills/marks; only the REAL evaluator's
            # verdict and downstream transaction behavior are being verified.
            fill = {**buy(day), 'symbol': '1000'}
            stage_execution_receipt(execution=receipt(p, saved,
                fills=[fill] if index == 0 else [], marks={'1000': 110 + index * 20}),
                query=db.query, writer=db.writer, now=stamp(day))
        mature_staged_pairs(business_date=day, query=db.query, writer=db.writer, now=stamp(day))
    from nav_read_model_bridge import assert_original_read_model
    assert_original_read_model(db, tmp_path, business_date=days[-1], owner='atomic_strategy', sessions=10)
    review = run_daily_nav_reviews(business_date=days[-1], query=db.query, writer=db.writer, now=stamp(days[-1]))
    assert not review['failures'], review
    candidates = []
    refreshed = refresh_registered_atomic_nav_decisions(business_date=days[-1], query=db.query,
        now=stamp(days[-1]), adoption_candidates=candidates)
    assert not refreshed['failures'], refreshed
    assert candidates and all(item['payload']['prospective_validation']['decision'] == 'PASS' for item in candidates), candidates
    payload = sorted(candidates, key=lambda item: item['payload']['artifact_id'])[0]['payload']
    names = ['paired_nav_review_records_v1', 'paired_nav_review_parts_v1', 'paired_nav_frozen_manifests_v1',
        'paired_nav_frozen_parts_v1', 'paired_nav_daily_journal_v1']
    tables = {name: db.query(f'SELECT * FROM {name}', []) for name in names}
    evidence = []
    read_seconds = []
    identities = {(p['payload']['policy_definition'][role]['id'], p['payload']['policy_definition'][role]['version'])
        for p in candidates for role in ('candidate', 'incumbent')}
    for strategy_id, version in sorted(identities):
        started = perf_counter()
        actual = read_strategy_nav_evidence(strategy_id=strategy_id, strategy_version=version,
            business_date=days[-1], query=db.query, now=stamp(days[-1]))
        read_seconds.append({'strategy_id': strategy_id, 'entries': actual['entry_count'], 'seconds': perf_counter() - started})
        expected = [p['payload'] for p in candidates if any(
            p['payload']['policy_definition'][role]['id'] == strategy_id
            and p['payload']['policy_definition'][role]['version'] == version
            for role in ('candidate', 'incumbent'))]
        assert actual['status'] == 'available', actual
        assert actual['entry_count'] == len(expected)
        assert {e['artifact_checksum'] for e in actual['entries']} == {p['artifact_checksum'] for p in expected}
        for entry in actual['entries']:
            source = next(p for p in expected if p['artifact_checksum'] == entry['artifact_checksum'])
            assert entry['nav'] == source['prospective_validation']['nav_validation']
            assert entry['nav']['evaluable_date_count'] == 10
        evidence.append(actual)
    missing = read_strategy_nav_evidence(strategy_id='not-a-registered-strategy', strategy_version='none',
        business_date=days[-1], query=db.query, now=stamp(days[-1]))
    assert missing['status'] == 'not_registered' and missing['entries'] == []
    assert {name: db.query(f'SELECT * FROM {name}', []) for name in names} == tables
    schema = [db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [name])[0]['sql'] for name in names]
    fixture = tmp_path / 'atomic-nav-original-pass.json'
    fixture.write_text(json.dumps({'payload': payload, 'payloads': [item['payload'] for item in candidates], 'tables': tables, 'schema': schema,
        'strategy_evidence': evidence, 'read_seconds': read_seconds,
        'config': plan['configuration'], 'now': stamp(days[-1]).isoformat()}, ensure_ascii=False), encoding='utf-8')
    child_env = dict(os.environ)
    child_env.pop('NODE_TEST_CONTEXT', None)
    worker = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap',
        'tests/atomicNavPublicationD1.ts'], cwd=root / 'worker',
        env={**child_env, 'NAV_ATOMIC_PUBLICATION_FIXTURE': str(fixture)},
        capture_output=True, text=True, encoding='utf-8', timeout=180)
    assert worker.returncode == 0, worker.stdout + worker.stderr
    assert '# pass 13' in worker.stdout and '# fail 0' in worker.stdout
    rendered = subprocess.run(['node', '--import', (root / 'worker/node_modules/tsx/dist/loader.mjs').as_uri(),
        'tests/strategy-nav.render.test.tsx'], cwd=root / 'frontend',
        env={**child_env, 'NAV_ATOMIC_PUBLICATION_FIXTURE': str(fixture)},
        capture_output=True, text=True, encoding='utf-8', timeout=60)
    assert rendered.returncode == 0, rendered.stdout + rendered.stderr
    published, = [json.loads(line.removeprefix('NAV_ATOMIC_PUBLICATION_RESULT='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ATOMIC_PUBLICATION_RESULT=')]
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    response, calls = deepcopy(published), []
    reconciled, = [json.loads(line.removeprefix('NAV_ATOMIC_RECONCILIATION='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ATOMIC_RECONCILIATION=')]
    reconciliation = reconciled['before']
    async def transport(path, **kwargs):
        calls.append(path)
        if path == '/api/admin/config/strategy-atomic/reconcile':
            assert digest(kwargs['json_body']) == reconciled['before']['request_checksum']
            return reconciliation
        assert path == '/api/admin/config/strategy-atomic/promote'
        assert kwargs['method'] == 'POST' and kwargs['json_body'] == payload
        return response
    monkeypatch.setattr(worker_config_client, 'worker_fetch', transport)
    run = lambda: asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date=days[-1]))
    adopted = run()
    assert adopted['status'] == 'completed', adopted
    assert adopted['atomic']['complete'] and adopted['atomic']['serving_activation_verified'] is False
    for mutation in ({'artifact_id': 'wrong'}, {'pointer_committed': False}, {'serving_readers_verified': False},
            {'publication_receipt_checksum': ''}, {'policy': []}, {'policy': {'weights': {'bad': float('nan')}}}):
        response = {**published, **mutation}
        rejected = run()
        assert rejected['status'] == 'incomplete' and rejected['reason'] == 'nav_atomic_adoption_incomplete'
    response = published
    reconciliation = reconciled['after']
    count = calls.count('/api/admin/config/strategy-atomic/promote')
    recovered = run()
    assert recovered['status'] == 'no_adoption_due', recovered
    assert recovered['atomic_reconciliation']['complete']
    assert calls.count('/api/admin/config/strategy-atomic/promote') == count

    # Actual native Worker reconciliation after its real Route reader changed.
    # Route transport is a scheduling fixture, NOT a joint economic experiment.
    post_route, = [json.loads(line.removeprefix('NAV_ATOMIC_POST_ROUTE_RECONCILIATION='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ATOMIC_POST_ROUTE_RECONCILIATION=')]
    from test_nav_post_publication_reconciliation import inventory, route_reconciliation, route_publication
    route = inventory()[1]
    timeline = []
    async def combined_transport(path, **kw):
        timeline.append(path)
        if path.endswith('strategy-atomic/reconcile'):
            assert digest(kw['json_body']) == reconciled['before']['request_checksum']
            return post_route if any(p.endswith('strategy-route/promote') for p in timeline) else reconciled['before']
        if path.endswith('strategy-route/reconcile'): return route_reconciliation(kw['json_body'])
        if path.endswith('strategy-route/promote'): return route_publication(kw['json_body'])
        raise RuntimeError('old_atomic_must_not_publish_after_route_changed')
    monkeypatch.setattr(worker_config_client, 'worker_fetch', combined_transport)
    deferred = asyncio.run(run_daily_ev_adoption(candidates=[*candidates, route], business_date=days[-1]))
    assert deferred['status'] == 'completed', deferred
    assert deferred['atomic_post_route_reconciliation'] == post_route
    assert 'atomic' not in deferred and 'atomic_strategy' not in deferred['requested_artifacts']
    assert deferred['waiting'][0]['reason'] == 'route_publication_after_current_canonical'
    import oof_materialize_job_main as job
    callback = job._nav_callback_summary({'adoption': deferred})
    assert callback['adoption']['atomic_post_route_reconciliation'] == post_route
    assert callback['adoption']['waiting'] == deferred['waiting']
    # Original Worker source checks above feed the real daily selector/callback.
    # Upstream publication transports remain fixtures, not a joint ROI claim.
    from services import paired_nav_daily_adoption as adoption
    from test_nav_daily_adoption import entry, acknowledged, publication_response
    from test_nav_adoption_closure import registration_summary
    for owner, marker in [('ensemble', 'ML'), ('l4_alpha_ev', 'TRADING'), ('opb_arm_prior', 'TRADING')]:
        changed, = [json.loads(line.split('=', 1)[1])
            for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
            if line.startswith('NAV_ATOMIC_POST_DEPENDENCY_' + marker + '=')]
        changed_upstream, events = False, []
        async def ensemble_transport(payload, day):
            nonlocal changed_upstream
            changed_upstream = True
            return {'complete': True, 'pointer_committed': True, 'owner': 'ensemble', 'completion_scope': 'publication'}
        async def upstream_transport(path, **kw):
            nonlocal changed_upstream
            events.append(path)
            if path.endswith('strategy-atomic/reconcile'):
                return changed if changed_upstream else reconciled['before']
            if path.endswith('expected-return/promote'):
                changed_upstream = True
                return acknowledged(kw['json_body'])
            if path.endswith('opb/promote'):
                changed_upstream = True
                return publication_response(kw['json_body'], 'awaiting_next_allocation')
            if '/api/admin/trigger/opb-arm-prior-refresh' in path:
                return {'success': True, 'result': registration_summary()}
            raise AssertionError('no stale Atomic publication or Route surrogate')
        with monkeypatch.context() as patch:
            patch.setattr(adoption, 'adopt_daily_ensemble', ensemble_transport)
            patch.setattr(worker_config_client, 'worker_fetch', upstream_transport)
            upstream = entry(owner=owner, state='candidate' if owner == 'ensemble' else 'shadowing', token='e')
            actual = asyncio.run(run_daily_ev_adoption(candidates=[upstream, *candidates], business_date=days[-1]))
            assert actual['status'] == 'completed', actual
            assert actual['atomic_post_dependency_reconciliation'] == changed
            assert all(row['state'] == 'baseline_changed' for row in actual['waiting'])
            assert all(not path.endswith('strategy-atomic/promote') for path in events)
            assert job._nav_callback_summary({'adoption': actual})['adoption']['waiting'] == actual['waiting']
    monkeypatch.setattr(worker_config_client, 'worker_fetch', transport)
    for changed in ({'complete': False}, {'entries': []}, {'request_checksum': '0' * 64}, {'route_dependency_checksum': None}):
        reconciliation = {**reconciled['after'], **changed}
        rejected = run()
        assert rejected['status'] == 'incomplete' and rejected['stage'] == 'atomic_reconciliation'
        assert calls.count('/api/admin/config/strategy-atomic/promote') == count
    reconciliation = reconciled['before']
    wrong_day = asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date='2026-09-22'))
    assert wrong_day['reason'] == 'nav_atomic_evaluation_date_changed'
    for decision in ('HOLD', 'PENDING'):
        waiting = deepcopy(candidates)
        for candidate in waiting:
            candidate['payload']['prospective_validation']['decision'] = decision
        count = calls.count('/api/admin/config/strategy-atomic/promote')
        assert asyncio.run(run_daily_ev_adoption(candidates=waiting, business_date=days[-1]))['status'] == 'no_adoption_due'
        assert calls.count('/api/admin/config/strategy-atomic/promote') == count
    reconciliation = reconciled['after']
    held = deepcopy(candidates)
    for candidate in held:
        candidate['payload']['prospective_validation']['decision'] = 'HOLD'
    recovered_hold = asyncio.run(run_daily_ev_adoption(candidates=held, business_date=days[-1]))
    assert recovered_hold['status'] == 'no_adoption_due'
    assert recovered_hold['atomic_reconciliation']['entries'][0]['state'] == 'published'
    import oof_materialize_job_main as job
    callback = job._nav_callback_summary({'adoption': recovered_hold})
    assert callback['adoption']['atomic_reconciliation'] == reconciled['after']
    observed, = [json.loads(line.removeprefix('NAV_ATOMIC_EXECUTION_RECONCILIATION='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ATOMIC_EXECUTION_RECONCILIATION=')]
    reconciliation = observed
    actual = run()
    assert actual['status'] == 'no_adoption_due'
    assert any(row.get('execution_observation', {}).get('executed') is True
        for row in actual['atomic_reconciliation']['entries'])
    assert calls.count('/api/admin/config/strategy-atomic/promote') == count
