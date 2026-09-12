"""Original NAV arithmetic/review and route publication, private fixtures only.

Synthetic execution receipts test software, never investment performance.
The original evaluator, family budget and evidence reader are not mocked.
"""
import json
import os
from pathlib import Path
import subprocess
import asyncio
from copy import deepcopy

from services.paired_nav_journal import (read_snapshot, freeze_snapshot, digest,
    stage_execution_receipt, mature_staged_pairs)
from services.paired_nav_route_candidate import collect_route_allocations
from services.paired_nav_policy_daily import refresh_registered_route_nav_decisions
from services.paired_nav_daily_review import run_daily_nav_reviews
from test_paired_nav_route_pit import prepared, environment, with_routes, route_freeze_clock
from test_paired_nav_review_store import migrate
from test_paired_nav_lifecycle import stamp
from test_paired_nav_journal import packet, receipt, buy, FEES


def test_native_route_migration_preserves_existing_publication():
    child_env = dict(os.environ)
    child_env.pop('NODE_TEST_CONTEXT', None)
    result = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap',
        'tests/routeNavMigrationD1.ts'], cwd=Path(__file__).parents[2] / 'worker', env=child_env,
        capture_output=True, text=True, encoding='utf-8', timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert '# pass 2' in result.stdout and '# fail 0' in result.stdout


def test_original_route_nav_pass_publication(prepared, environment, route_freeze_clock, monkeypatch, tmp_path):
    root = Path(__file__).parents[2]
    child_env = dict(os.environ)
    child_env.pop('NODE_TEST_CONTEXT', None)
    router = subprocess.run(['node', '--import', 'tsx', 'src/lib/strategyRouteAdmissionParity.test.ts',
        '--emit-pit-route'], cwd=root / 'worker', env=child_env,
        capture_output=True, text=True, encoding='utf-8', timeout=40)
    assert router.returncode == 0, router.stdout + router.stderr
    contrasts = [json.loads(line.removeprefix('NAV_ROUTE_FIXTURE=')) for line in router.stdout.splitlines()
        if line.startswith('NAV_ROUTE_FIXTURE=')]
    assert len(contrasts) == 1
    route_inputs, = [json.loads(line.removeprefix('NAV_ROUTE_INPUTS=')) for line in router.stdout.splitlines()
        if line.startswith('NAV_ROUTE_INPUTS=')]
    db, frozen = with_routes(prepared, contrasts=contrasts[0])
    migrate(db)
    result = collect_route_allocations(snapshot_id=frozen['snapshot_id'], query=db.query, writer=db.writer)
    from services.paired_nav_candidate_collection import collect_candidate_allocations
    from services.paired_nav_l3_candidate import collect_ensemble_allocations
    collect_candidate_allocations(snapshot_id=environment[2]['snapshot_id'], query=db.query,
        writer=db.writer, bucket=environment[1])
    collect_candidate_allocations(snapshot_id=frozen['snapshot_id'], query=db.query,
        writer=db.writer, bucket=environment[1])
    collect_ensemble_allocations(snapshot_id=frozen['snapshot_id'], query=db.query, writer=db.writer)
    item, = result['plans']
    plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
    from services.paired_nav_policy_daily import read_policy_candidate_decision
    pending_payload = read_policy_candidate_decision(owner='l15_route', candidate_artifact_id=plan['candidate_artifact_id'],
        candidate_checksum=plan['candidate_checksum'], business_date='2026-09-07', query=db.query, now=stamp('2026-09-07'))
    assert pending_payload['prospective_validation']['decision'] == 'PENDING'
    days = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14',
        '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21']
    signal, previous = '2026-09-07', None
    for index, day in enumerate(days):
        p = packet(day, previous)
        p.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
        p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': day + 'T00:00:00Z'}])
        p['configuration_checksum'] = digest(p['configuration'])
        saved = freeze_snapshot(signal_date='2026-09-07', source_run_id=p['pair_id'] + ':' + day, snapshot_kind='execution_pair',
            content=p, query=db.query, writer=db.writer, now=stamp(signal))
        # A candidate fill and a baseline non-fill are explicit test inputs.
        # Do not claim this artificial execution difference is a route benefit.
        stage_execution_receipt(execution=receipt(p, saved, fills=[buy(day)] if index == 0 else [],
            marks={'2330': 110 + index * 20}), query=db.query, writer=db.writer, now=stamp(day))
        mature_staged_pairs(business_date=day, query=db.query, writer=db.writer, now=stamp(day))
        signal, previous = day, day
    review = run_daily_nav_reviews(business_date=days[-1], query=db.query, writer=db.writer, now=stamp(days[-1]))
    assert not review['failures'], review
    candidates = []
    refresh_registered_route_nav_decisions(business_date=days[-1], query=db.query, now=stamp(days[-1]),
        adoption_candidates=candidates)
    payload, = [item['payload'] for item in candidates]
    assert payload['prospective_validation']['decision'] == 'PASS', payload
    names = ['paired_nav_review_records_v1', 'paired_nav_review_parts_v1', 'paired_nav_frozen_manifests_v1',
        'paired_nav_frozen_parts_v1', 'paired_nav_daily_journal_v1']
    tables = {name: db.query(f'SELECT * FROM {name}', []) for name in names}
    schema = [db.query("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", [name])[0]['sql'] for name in names]
    fixture = tmp_path / 'route-nav-original-pass.json'
    fixture.write_text(json.dumps({'payload': payload, 'tables': tables, 'schema': schema,
        'config': plan['configuration'], 'now': stamp(days[-1]).isoformat(), 'route_inputs': route_inputs,
        'pending_payload': pending_payload}, ensure_ascii=False), encoding='utf-8')
    worker = subprocess.run(['node', '--import', 'tsx', '--test', '--test-reporter=tap',
        'tests/routeNavPublicationD1.ts'], cwd=root / 'worker',
        env={**child_env, 'NAV_ROUTE_PUBLICATION_FIXTURE': str(fixture)},
        capture_output=True, text=True, encoding='utf-8', timeout=120)
    assert worker.returncode == 0, worker.stdout + worker.stderr
    assert '# pass 16' in worker.stdout and '# fail 0' in worker.stdout
    published, = [json.loads(line.removeprefix('NAV_ROUTE_PUBLICATION_RESULT='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ROUTE_PUBLICATION_RESULT=')]
    from services import worker_config_client
    from services.paired_nav_daily_adoption import run_daily_ev_adoption
    response, calls = deepcopy(published), []
    reconciliation, = [json.loads(line.removeprefix('NAV_ROUTE_RECONCILIATION_BEFORE='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ROUTE_RECONCILIATION_BEFORE=')]
    async def transport(path, **kwargs):
        calls.append(path)
        if path == '/api/admin/config/strategy-route/reconcile':
            assert kwargs['json_body'] == {'business_date': days[-1], 'candidates': [dict(
                artifact_id=payload['artifact_id'], artifact_checksum=payload['artifact_checksum'])]}
            return reconciliation
        assert path == '/api/admin/config/strategy-route/promote'
        assert kwargs['method'] == 'POST' and kwargs['json_body'] == payload
        return response
    monkeypatch.setattr(worker_config_client, 'worker_fetch', transport)
    run = lambda: asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date=days[-1]))
    adopted = run()
    assert adopted['status'] == 'completed', adopted
    assert adopted['route']['complete'] and adopted['route']['serving_activation_verified'] is False
    observed, = [json.loads(line.removeprefix('NAV_ROUTE_EXECUTION_RESULT='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ROUTE_EXECUTION_RESULT=')]
    response = observed
    assert run()['route']['serving_activation_verified'] is True
    for mutation in ({'execution_observation': None}, {'serving_activation_verified': False},
            {'execution_observation': {**observed['execution_observation'], 'orders_executed_verified': True}}):
        response = {**observed, **mutation}
        assert run()['status'] == 'incomplete'
    for mutation in ({'artifact_id': 'wrong'}, {'pointer_committed': False}, {'serving_readers_verified': False},
            {'publication_receipt_checksum': ''}, {'serving': []}, {'serving': {'routeVersion': 'wrong'}}):
        response = {**published, **mutation}
        rejected = run()
        assert rejected['status'] == 'incomplete' and rejected['reason'] == 'nav_route_adoption_incomplete'
    wrong_day = asyncio.run(run_daily_ev_adoption(candidates=candidates, business_date='2026-09-22'))
    assert wrong_day['reason'] == 'nav_route_evaluation_date_changed'
    for decision in ('HOLD', 'PENDING'):
        waiting = deepcopy(candidates)
        waiting[0]['payload']['prospective_validation']['decision'] = decision
        count = calls.count('/api/admin/config/strategy-route/promote')
        assert asyncio.run(run_daily_ev_adoption(candidates=waiting, business_date=days[-1]))['status'] == 'no_adoption_due'
        assert calls.count('/api/admin/config/strategy-route/promote') == count
    reconciliation, = [json.loads(line.removeprefix('NAV_ROUTE_RECONCILIATION_AFTER='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ROUTE_RECONCILIATION_AFTER=')]
    held = deepcopy(candidates)
    held[0]['payload']['prospective_validation']['decision'] = 'HOLD'
    resumed = asyncio.run(run_daily_ev_adoption(candidates=held, business_date=days[-1]))
    assert resumed['status'] == 'no_adoption_due'
    assert resumed['route_reconciliation']['publication']['serving_activation_verified'] is True
    assert calls.count('/api/admin/config/strategy-route/promote') == count
    reconciliation = {**reconciliation, 'complete': False}
    invalid = run()
    assert invalid['status'] == 'incomplete' and invalid['stage'] == 'route_reconciliation'
    lifecycle, = [json.loads(line.removeprefix('NAV_ROUTE_CANDIDATE_RECONCILIATION='))
        for line in (line.removeprefix('# ') for line in worker.stdout.splitlines())
        if line.startswith('NAV_ROUTE_CANDIDATE_RECONCILIATION=')]
    reconciliation = lifecycle['waiting']
    calls_before = calls.count('/api/admin/config/strategy-route/promote')
    original_candidates = deepcopy(candidates)
    stale = run()
    assert stale['status'] == 'no_adoption_due', stale
    assert stale['waiting'] == [{'owner': 'l15_route', 'artifact_id': payload['artifact_id'],
        'state': 'baseline_changed', 'reason': 'registry_changed'}]
    assert calls.count('/api/admin/config/strategy-route/promote') == calls_before
    assert candidates == original_candidates
    import oof_materialize_job_main as job
    assert job._nav_callback_summary({'adoption': stale})['adoption']['waiting'] == stale['waiting']
    assert 'nav_waiting=l15_route:baseline_changed' in job._summary('native-route',
        {'paired_nav_maturity': {'adoption': stale}}, mode='oof_lifecycle')
    reconciliation = lifecycle['ready']
    response = published
    assert run()['route']['complete'] is True
