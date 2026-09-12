"""Complete candidate denominator; real SQLite/allocator, synthetic market data."""
import pytest

from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import mature_staged_pairs, read_snapshot, freeze_snapshot
from test_paired_nav_lifecycle import (
    environment, registered_old, successor_context, collect, register_successors, commit, stamp,
)


def population(db, day='2026-09-08', page_size=50):
    return read_verified_nav_evidence(business_date=day, query=db.query,
        page_size=page_size).summary()['candidate_population']


def test_frozen_but_unregistered_candidates_are_not_an_empty_denominator(environment):
    db, _, context, _ = environment
    plans = collect(environment, context)['plans']
    data = population(db)
    assert data['pair_count'] == data['hypothesis_count'] == 2
    assert {p['pair_id'] for p in data['pairs']} == {p['pair_id'] for p in plans}
    assert all(p['execution_status'] == 'not_registered' for p in data['pairs'])
    assert all(p['accounted_sessions'] == 0 for p in data['pairs'])
    assert data['statistical_budget_status'] == 'not_assigned'
    assert not db.query("SELECT name FROM sqlite_master WHERE name='paired_nav_nominations_v1'", [])


def test_registered_without_a_journal_remains_in_the_population(environment):
    db, *_ = environment
    registered_old(environment, materialize=False)
    data = population(db)
    assert data['pair_count'] == 2
    assert all(p['execution_status'] == 'registered_evidence_missing' for p in data['pairs'])
    assert all(p['unaccounted_session_dates'] == ['2026-09-08'] for p in data['pairs'])
    # The population reader reports the gap; nightly still fails the due promise.
    with pytest.raises(RuntimeError, match='due_execution_receipt_missing'):
        mature_staged_pairs(business_date='2026-09-08', query=db.query,
            writer=db.writer, now=stamp('2026-09-08'))


def test_lifecycle_transition_preserves_old_and_unmature_successor_hypotheses(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    before = population(db)
    old_journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
    new = collect(environment, successor_context(environment, monkeypatch))
    register_successors(db, new['plans'])
    commit(db, new)
    after = population(db)
    assert after['pair_count'] == after['hypothesis_count'] == 4
    assert [f['family_id'] for f in after['families']] == [f['family_id'] for f in before['families']]
    assert all(f['hypothesis_count'] == 2 for f in after['families'])
    assert sum(p['lifecycle_status'] == 'comparison_closed' for p in after['pairs']) == 2
    waiting = [p for p in after['pairs'] if p['pair_id'] in {p['pair_id'] for p in new['plans']}]
    assert all(p['accounted_sessions'] == 0 and p['execution_status'] == 'awaiting_session' for p in waiting)
    assert all(p['upcoming_session_dates'] == ['2026-09-09'] for p in waiting)
    assert population(db, page_size=1) == after
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == old_journals


def test_daily_retry_registry_deletion_and_old_asof_do_not_rewrite_population(environment, monkeypatch):
    db, *_ = environment
    registered_old(environment)
    first = population(db, '2026-09-07')
    assert all(p['execution_status'] == 'awaiting_session' for p in first['pairs'])
    today = population(db)
    db.conn.execute('DELETE FROM model_artifact_registry')
    assert population(db) == today
    new = collect(environment, successor_context(environment, monkeypatch, changed=False))
    assert len(new['plans']) == 2
    assert population(db, '2026-09-07') == first
    latest = population(db)
    assert latest['hypothesis_count'] == latest['pair_count'] == 2
    result = mature_staged_pairs(business_date='2026-09-08', query=db.query,
        writer=db.writer, now=stamp('2026-09-08'))
    assert result['paired_nav_evidence']['candidate_population'] == latest


def test_new_training_cohort_does_not_start_an_empty_owner_family(environment, monkeypatch):
    from test_paired_nav_ev_selection import add_new_cohort
    db, bucket, *_ = environment
    registered_old(environment)
    before = population(db)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    add_new_cohort(db, bucket)
    collect(environment, successor_context(environment, monkeypatch, changed=False))
    after = population(db)
    assert after['pair_count'] == after['hypothesis_count'] == 4
    assert all(f['hypothesis_count'] == 2 for f in after['families'])
    assert [f['family_id'] for f in after['families']] == [f['family_id'] for f in before['families']]
    assert sum(p['accounted_sessions'] for p in after['pairs']) == 2
    assert sum(p['execution_status'] == 'not_registered' for p in after['pairs']) == 2


def test_alias_is_not_a_new_hypothesis_or_a_way_to_pool_maturity(environment):
    db, *_ = environment
    result, _ = registered_old(environment)
    item = next(p for p in result['plans'] if p['owner'] == 'allocator_ev_fusion')
    original = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
    alias = {**original, 'pair_id': 'a-new-label-not-new-economics'}
    freeze_snapshot(signal_date='2026-09-07', source_run_id=alias['pair_id'],
        snapshot_kind='allocation_pair', content=alias, query=db.query, writer=db.writer,
        now=stamp('2026-09-07'))
    data = population(db)
    assert data['pair_count'] == 3 and data['hypothesis_count'] == 2
    aliases = [p for p in data['pairs'] if p['candidate_checksum'] == original['candidate_checksum']]
    assert len({p['hypothesis_checksum'] for p in aliases}) == 1
    assert sorted(p['accounted_sessions'] for p in aliases) == [0, 1]


def test_summary_cannot_mutate_verified_population_or_subsequent_read(environment):
    db, *_ = environment
    registered_old(environment)
    data = read_verified_nav_evidence(business_date='2026-09-08', query=db.query)
    before = data.summary()['candidate_population']
    changed = data.summary()['candidate_population']
    changed['pairs'][0]['accounted_sessions'] = 999
    changed['families'].clear()
    assert data.summary()['candidate_population'] == before
    assert population(db) == before


def test_concurrent_plan_after_allocation_scan_requires_retry(environment):
    db, *_ = environment
    registered_old(environment)
    inserted = False
    def query(sql, params):
        nonlocal inserted
        if not inserted and 'snapshot_kind=?' in sql and params and params[0] == 'execution_pair':
            inserted = True
            freeze_snapshot(signal_date='2026-09-07', source_run_id='concurrent-legacy-plan',
                snapshot_kind='allocation_pair', content={'pair_id': 'concurrent'},
                query=db.query, writer=db.writer, now=stamp('2026-09-07'))
        return db.query(sql, params)
    with pytest.raises(RuntimeError, match='population_concurrent_publication_retry'):
        read_verified_nav_evidence(business_date='2026-09-08', query=query)
    assert len(population(db)['unresolved_legacy_allocation_snapshot_ids']) == 1


def test_legacy_research_nomination_cannot_be_guessed_into_a_verified_family():
    from test_paired_nav_journal import DB
    from test_paired_nav_sequential_state import nominate, sessions, records
    db = DB()
    nominate(db)
    days = sessions(db, 2)
    old = records(db)
    result = mature_staged_pairs(business_date=days[-1], query=db.query,
        writer=db.writer, now=stamp('2026-10-31'))
    data = result['paired_nav_evidence']['candidate_population']
    assert data['pair_count'] == data['hypothesis_count'] == 0
    assert len(data['unresolved_legacy_allocation_snapshot_ids']) == 1
    assert len(data['unresolved_legacy_execution_snapshot_ids']) == 2
    assert data['unresolved_journal_pair_ids'] == ['candidate-pair']
    assert result['recorded_pair_sessions'] == 2 and records(db) == old


def test_only_accounting_schema_without_retired_budget_still_works():
    from test_paired_nav_journal import DB
    db = DB(legacy_assessments=False)
    # Empty 0040-only installations must not depend on lifecycle or budget tables.
    db.conn.execute('DROP TABLE paired_nav_lifecycle_closures_v1')
    assert population(db)['pairs'] == []


def test_duplicate_l4_reference_is_still_rejected_not_relaxed_for_alias_accounting(environment):
    db, *_ = environment
    result, _ = registered_old(environment)
    item = next(p for p in result['plans'] if p['owner'] == 'l4_alpha_ev')
    original = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
    freeze_snapshot(signal_date='2026-09-07', source_run_id='ambiguous-l4',
        snapshot_kind='allocation_pair', content={**original, 'pair_id': 'ambiguous-l4'},
        query=db.query, writer=db.writer, now=stamp('2026-09-07'))
    with pytest.raises(ValueError, match='comparison_l4_plan_mismatch'):
        population(db)


def test_partial_ev_publication_keeps_selected_but_unpublished_candidates(environment, monkeypatch):
    from services import paired_nav_candidate_collection as collection
    from test_paired_nav_ev_selection import add_new_cohort
    db, bucket, *_ = environment
    registered_old(environment)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    add_new_cohort(db, bucket)
    context = successor_context(environment, monkeypatch, changed=False)
    seal, calls = collection.freeze_snapshot, 0
    def interrupted(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError('fixture_partial_selection')
        return seal(**kwargs)
    monkeypatch.setattr(collection, 'freeze_snapshot', interrupted)
    failed = collect(environment, context)
    assert failed['status'] == 'partial_allocation_pairs' and len(failed['plans']) == 2
    assert failed['owner_failures']['expected_return']['error_type'] == 'RuntimeError'
    incomplete = population(db)
    assert incomplete['selection_materialization_complete'] is False
    assert len(incomplete['unmaterialized_selections']) == 2
    assert all(p['allocation_context_snapshot_id'] == context['snapshot_id'] for p in incomplete['unmaterialized_selections'])
    db.conn.execute('DELETE FROM model_artifact_registry')
    monkeypatch.setattr(collection, 'freeze_snapshot', seal)
    collect(environment, context)
    complete = population(db)
    assert complete['selection_materialization_complete'] is True
    assert complete['unmaterialized_selections'] == []
    assert complete['pair_count'] == complete['hypothesis_count'] == 4
