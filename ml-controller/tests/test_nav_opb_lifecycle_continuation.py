"""Original registry -> sparse allocation -> journal -> next-day OPB continuation.

SQLite is private and execution receipts are synthetic accounting fixtures, not
an investment-return comparison. No registry reader or lifecycle owner is mocked.
"""
from copy import deepcopy
from datetime import datetime
import json

import pytest

from services import paired_nav_opb_candidate as module
from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, stage_execution_receipt, mature_staged_pairs
from services.paired_nav_lifecycle import registered_pairs
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_daily_review import run_daily_nav_reviews, _introduced_families
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_opb_daily import refresh_registered_opb_nav_decisions
from test_paired_nav_opb_candidate import environment, seal, collect
from test_paired_nav_journal import packet, receipt, FEES


def clock(day):
    return datetime.fromisoformat(day + 'T14:00:00+00:00')


def account_session(db, item, signal, session, previous=None, *, mature=True):
    plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
    execution = packet(session, previous)
    execution.update({key: plan[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')})
    execution.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
        schedule=[{'observed_at': session + 'T00:00:00Z'}])
    execution['configuration_checksum'] = digest(execution['configuration'])
    saved = freeze_snapshot(signal_date=signal, source_run_id=execution['pair_id'], snapshot_kind='execution_pair',
        content=execution, query=db.query, writer=db.writer, now=clock(signal))
    if mature:
        stage_execution_receipt(execution=receipt(execution, saved), query=db.query, writer=db.writer, now=clock(session))
        mature_staged_pairs(business_date=session, query=db.query, writer=db.writer, now=clock(session))
    return saved


@pytest.mark.parametrize('state', ['archived', 'rejected', 'production'])
def test_registered_candidate_keeps_exact_daily_plan_and_nav_family(environment, monkeypatch, state):
    db, artifact, content = environment
    first, = collect(db, seal(db, content))['plans']
    account_session(db, first, '2026-09-07', '2026-09-08')
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    initial = read_verified_nav_evidence(business_date='2026-09-08', query=db.query, now=clock('2026-09-08'))
    original_family = json.loads(_introduced_families(initial).population_json)
    db.conn.execute('UPDATE model_artifact_registry SET state=?', [state])
    registry_before = db.query('SELECT * FROM model_artifact_registry', [])
    selection = module.select_opb_candidates(query=db.query, signal_date='2026-09-08', now=clock('2026-09-08'))
    assert len(selection['registry_rows']) == 1, 'registered NAV experiment must not disappear with mutable state'
    assert json.loads(selection['registry_rows'][0]['offline_evidence_json']) == artifact
    updated = {**deepcopy(content), 'opb_candidate_selection': selection}
    # Today's tradable universe differs. Retain the original candidate artifact,
    # NOT yesterday's predictions/allocation, while using the same stable policy.
    updated['inputs']['recommendations'] = updated['inputs']['recommendations'][:1]
    actual_baseline = run_isolated_allocation(inputs=updated['inputs'], inherited_state={})
    updated.update(capture=actual_baseline['capture'], formal_output=actual_baseline['output'])
    parent = freeze_snapshot(signal_date='2026-09-08', source_run_id='opb-continuation', snapshot_kind='allocation_context',
        content=updated, query=db.query, writer=db.writer, now=clock('2026-09-08'))
    monkeypatch.setattr(module, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=clock('2026-09-08')))
    second, = collect(db, parent)['plans']
    assert second['pair_id'] == first['pair_id']
    first_plan = read_snapshot(db.query, first['snapshot_id'])['payload']['content']
    next_plan = read_snapshot(db.query, second['snapshot_id'])['payload']['content']
    assert next_plan['allocation_input_checksum'] != first_plan['allocation_input_checksum']
    assert next_plan['candidate']['output'] != first_plan['candidate']['output']
    assert next_plan['candidate_checksum'] == first_plan['candidate_checksum'] == digest(artifact)
    assert db.query('SELECT * FROM model_artifact_registry', []) == registry_before
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == before
    account_session(db, second, '2026-09-08', '2026-09-09', '2026-09-08')
    evidence = read_verified_nav_evidence(business_date='2026-09-09', query=db.query, now=clock('2026-09-09'))
    population = evidence.summary()['candidate_population']
    assert population['hypothesis_count'] == 1
    assert population['pairs'][0]['accounted_sessions'] == 2
    assert json.loads(_introduced_families(evidence).population_json)['families'] == original_family['families']
    reviews = run_daily_nav_reviews(business_date='2026-09-09', query=db.query, writer=db.writer, now=clock('2026-09-09'))
    assert not reviews['failures'], reviews
    daily = refresh_registered_opb_nav_decisions(business_date='2026-09-09', query=db.query, writer=db.writer,
        now=clock('2026-09-09'))
    assert not daily['failures'] and daily['decisions'][0]['evaluable_date_count'] == 2, daily
    assert daily['decisions'][0]['decision'] == 'PENDING'
    assert db.query('SELECT state FROM model_artifact_registry', [])[0]['state'] == state
    assert not db.query("SELECT * FROM paired_nav_review_records_v1 WHERE record_kind='reservation'", [])


def test_new_archived_candidate_is_not_admitted_without_registration(environment):
    db, _, _ = environment
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    assert not module.select_opb_candidates(query=db.query, signal_date='2026-09-08',
        now=clock('2026-09-08'))['registry_rows']


def test_pending_execution_is_retained_and_does_not_become_mature_or_close(environment):
    db, _, content = environment
    item, = collect(db, seal(db, content))['plans']
    account_session(db, item, '2026-09-07', '2026-09-08', mature=False)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    selection = module.select_opb_candidates(query=db.query, signal_date='2026-09-08', now=clock('2026-09-08'))
    assert len(selection['registry_rows']) == 1
    assert len(registered_pairs(signal_date='2026-09-08', query=db.query)) == 1
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
    assert not db.query('SELECT * FROM paired_nav_lifecycle_closures_v1', [])


def test_live_registry_immutable_identity_conflict_is_not_hidden_by_a_frozen_pin(environment):
    db, _, content = environment
    item, = collect(db, seal(db, content))['plans']
    account_session(db, item, '2026-09-07', '2026-09-08')
    db.conn.execute("UPDATE model_artifact_registry SET offline_evidence_json='{}'")
    with pytest.raises(ValueError, match='paired_nav_registered_opb_identity_conflict'):
        module.select_opb_candidates(query=db.query, signal_date='2026-09-08', now=clock('2026-09-08'))


def test_registered_original_parent_missing_is_an_error_not_empty_selection(environment):
    db, _, content = environment
    parent = seal(db, content)
    item, = collect(db, parent)['plans']
    account_session(db, item, '2026-09-07', '2026-09-08')
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    def missing_original(sql, params):
        if params == [parent['snapshot_id']] and 'FROM paired_nav_frozen_manifests_v1' in sql:
            return []
        return db.query(sql, params)
    with pytest.raises(RuntimeError, match='paired_nav_manifest_missing'):
        module.select_opb_candidates(query=missing_original, signal_date='2026-09-08', now=clock('2026-09-08'))
