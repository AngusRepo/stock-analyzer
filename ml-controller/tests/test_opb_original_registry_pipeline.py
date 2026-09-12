"""Actual builder -> immutable SQL registry, no fake PASS/config authority/ROI."""
import asyncio
import json
from datetime import datetime, timezone

from routers import opb_arm_prior as route
from services import opb_counterfactual_prior as prior
from test_opb_publication_closure import publication


def test_event_retry_reads_original_candidate_without_loading_new_data(publication, monkeypatch):
    _, db, _, calls, request = publication
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', lambda **kw: ([], []))
    monkeypatch.setattr(route, 'build_opb_arm_prior_artifact', prior.build_opb_arm_prior_artifact)
    first = asyncio.run(route.refresh_opb_arm_prior(request))
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    def forbidden(*args, **kw):
        raise AssertionError('event retry must not load newer data or rebuild the frozen prior')
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', forbidden)
    monkeypatch.setattr(route, 'build_opb_arm_prior_artifact', forbidden)
    again = asyncio.run(route.refresh_opb_arm_prior(request.model_copy(update={'reuse_registered': True})))
    assert again['candidate_reused'] and again['registry_verified'] and not again['promoted']
    assert again['artifact'] == first['artifact']
    assert again['artifact_checksum'] == first['artifact_checksum']
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before
    assert not calls


def test_original_failed_replay_registers_and_retries_without_rewriting(publication, monkeypatch):
    _, db, _, calls, request = publication
    class Clock:
        instant = datetime(2026, 9, 9, 14, tzinfo=timezone.utc)
        @classmethod
        def now(cls, *args): return cls.instant
    monkeypatch.setattr(prior, 'datetime', Clock)
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', lambda **kw: ([], []))
    monkeypatch.setattr(route, 'build_opb_arm_prior_artifact', prior.build_opb_arm_prior_artifact)
    first = asyncio.run(route.refresh_opb_arm_prior(request))
    assert first['artifact']['validation']['decision'] == 'FAIL'  # original evaluator, no synthetic PASS
    assert first['status'] == 'candidate_registered' and first['registry_verified']
    assert first['diagnostic_status'] == 'failed_validation'
    assert not first['promoted'] and not calls
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    assert before['state'] == 'offline_failed'
    assert json.loads(before['offline_evidence_json']) == first['artifact']
    assert before['checksum'] == route._checksum(first['artifact'])
    Clock.instant = datetime(2026, 9, 10, 1, tzinfo=timezone.utc)
    again = asyncio.run(route.refresh_opb_arm_prior(request))
    assert again['artifact'] == first['artifact']
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before
    assert not calls


def test_registered_offline_fail_is_in_next_causal_daily_inventory(publication, monkeypatch):
    from pathlib import Path
    from services.paired_nav_opb_candidate import select_opb_candidates, _artifact
    _, db, _, calls, request = publication
    # The actual daily selector now reads original NAV registrations as well as
    # new registry candidates. Give this private fixture the real NAV schema;
    # missing migrations must not be converted into an empty inventory.
    migrations = Path(__file__).parents[2] / 'worker/domain-migrations/learning'
    for name in ('0040_paired_nav_shadow_journal.sql', '0043_paired_nav_lifecycle.sql'):
        db.executescript((migrations / name).read_text(encoding='utf-8'))
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', lambda **kw: ([], []))
    monkeypatch.setattr(route, 'build_opb_arm_prior_artifact', prior.build_opb_arm_prior_artifact)
    result = asyncio.run(route.refresh_opb_arm_prior(request))
    now = datetime.now(timezone.utc)
    selection = select_opb_candidates(query=route.artifact_registry_d1.query,
                                     signal_date=now.date().isoformat(), now=now)
    assert len(selection['registry_rows']) == 1
    row = selection['registry_rows'][0]
    assert row['state'] == 'offline_failed'
    assert _artifact(row, selection) == result['artifact']
    assert not calls and not result['promoted']


def test_original_builder_registry_worker_and_walk_forward_receipt(publication, monkeypatch, tmp_path):
    import os
    import subprocess
    from pathlib import Path
    from routers import walk_forward
    from services import worker_config_client
    _, db, _, calls, request = publication
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', lambda **kw: ([], []))
    monkeypatch.setattr(route, 'build_opb_arm_prior_artifact', prior.build_opb_arm_prior_artifact)
    first = asyncio.run(route.refresh_opb_arm_prior(request))
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    again = asyncio.run(route.refresh_opb_arm_prior(request))
    fixture = tmp_path / 'original-opb-registration.json'
    fixture.write_text(json.dumps([first, again]), encoding='utf-8')
    env = {**os.environ, 'NAV_OPB_REFRESH_FIXTURE': str(fixture)}
    env.pop('NODE_TEST_CONTEXT', None)
    proc = subprocess.run(['node', '--import', 'tsx', '--test', 'src/lib/opbClosure.test.ts'],
        cwd=Path(__file__).parents[2] / 'worker', env=env, text=True,
        capture_output=True, encoding='utf-8', timeout=60)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    summaries = json.loads(Path(str(fixture) + '.summaries.json').read_text(encoding='utf-8'))
    assert len(summaries) == 2 and summaries[0] == summaries[1]
    for summary in summaries:
        async def fetch(*args, **kw):
            return {'success': True, 'result': summary}
        monkeypatch.setattr(worker_config_client, 'worker_fetch', fetch)
        receipt = asyncio.run(walk_forward._refresh_expected_return_opb('2026-09-09', 'auto'))
        assert receipt['status'] == 'completed'
        assert receipt['completion_scope'] == 'candidate_registration'
        assert receipt['promoted'] is False
    assert db.execute('SELECT count(*) FROM model_artifact_registry').fetchone()[0] == 1
    assert dict(db.execute('SELECT * FROM model_artifact_registry').fetchone()) == before
    assert not calls  # no publication request from producer


def test_changed_evaluation_policy_does_not_overwrite_original_packet(publication, monkeypatch):
    _, db, _, calls, request = publication
    monkeypatch.setattr(route, 'load_opb_counterfactual_inputs', lambda **kw: ([], []))
    monkeypatch.setattr(route, 'build_opb_arm_prior_artifact', prior.build_opb_arm_prior_artifact)
    first = asyncio.run(route.refresh_opb_arm_prior(request))
    before = dict(db.execute('SELECT * FROM model_artifact_registry').fetchone())
    second = asyncio.run(route.refresh_opb_arm_prior(request.model_copy(update={'min_dates': 21})))
    assert second['artifact']['artifact_id'] != first['artifact']['artifact_id']
    assert second['artifact']['arm_priors'] == first['artifact']['arm_priors']
    assert second['registry_verified'] and not second['promoted'] and not calls
    assert db.execute('SELECT count(*) FROM model_artifact_registry').fetchone()[0] == 2
    assert dict(db.execute('SELECT * FROM model_artifact_registry WHERE artifact_id=?',
                           [before['artifact_id']]).fetchone()) == before
