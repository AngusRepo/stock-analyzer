"""Original ledger/daily owner/nightly boundary tests; synthetic prices, no ROI."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace

import pytest

from services import paired_nav_daily_review as daily
from services import paired_nav_review_store as store
from services.paired_nav_journal import read_snapshot, freeze_snapshot, digest, stage_execution_receipt, mature_staged_pairs
from test_paired_nav_lifecycle import environment, registered_old, successor_context, collect, stamp
from test_paired_nav_review_store import migrate, two_sessions
from test_paired_nav_journal import packet, receipt, FEES


@pytest.fixture
def local_policy(monkeypatch):
    policy = replace(daily.POLICY, revision='test-two-four-checkpoints-only',
        minimum_sessions=2, final_sessions=4, block_length=1, resamples=1999)
    monkeypatch.setattr(daily, 'POLICY', policy)
    return policy


def run(db, day='2026-09-09'):
    return daily.run_daily_nav_reviews(business_date=day, query=db.query, writer=db.writer, now=stamp(day))


def append_session(environment, monkeypatch, signal, session, price):
    from services import paired_nav_candidate_collection as collection
    from services import paired_nav_lifecycle as lifecycle
    class SessionClock(datetime):
        @classmethod
        def now(cls, tz=None):
            value = stamp(signal)
            return value.astimezone(tz) if tz is not None else value.replace(tzinfo=None)
    # Advance the fixture clock with its future synthetic market session;
    # retain the real successor/PIT validator rather than stubbing its result.
    monkeypatch.setattr(lifecycle, 'datetime', SessionClock)
    db, _, _, content = environment
    context = freeze_snapshot(signal_date=signal, source_run_id='checkpoint-context:' + signal,
        snapshot_kind='allocation_context', content=deepcopy(content), query=db.query, writer=db.writer, now=stamp(signal))
    monkeypatch.setattr(collection, 'freeze_snapshot', lambda **kw: freeze_snapshot(**kw, now=stamp(signal)))
    result = collect(environment, context)
    assert len(result['plans']) == 2, [value.get('reason') for value in result.get('owner_failures',{}).values()]
    for item in result['plans']:
        plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
        p = packet(session, signal)
        p.update({key: plan[key] for key in ('pair_id','owner','candidate_checksum','baseline_checksum')})
        p.update(allocation_snapshot_id=item['snapshot_id'], configuration={**plan['configuration'], 'fees': FEES},
            schedule=[{'observed_at': session + 'T00:00:00Z'}])
        p['configuration_checksum'] = digest(p['configuration'])
        saved = freeze_snapshot(signal_date=signal, source_run_id=p['pair_id'], snapshot_kind='execution_pair',
            content=p, query=db.query, writer=db.writer, now=stamp(signal))
        stage_execution_receipt(execution=receipt(p, saved, marks={'2330':price}), query=db.query, writer=db.writer, now=stamp(session))
    mature_staged_pairs(business_date=session, query=db.query, writer=db.writer, now=stamp(session))


def test_real_daily_owner_pins_catchup_to_checkpoint_then_uses_final_slot(environment, monkeypatch, local_policy):
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    append_session(environment, monkeypatch, '2026-09-09', '2026-09-10', 98)
    result = run(db, '2026-09-10')
    assert result['status'] == 'daily_nav_reviews_current' and len(result['runs']) == 1
    first = result['runs'][0]
    assert first['checkpoint_as_of_date'] == '2026-09-09'
    assert len(first['result']['reviews']) == 2
    assert all(r['body']['effects'][0]['accounted_sessions'] == 2 for r in first['result']['reviews'])
    assert all(r['body']['effects'][0]['mean_daily_nav_delta'] == pytest.approx(.0024) for r in first['result']['reviews'])
    old_headers = db.query(f"SELECT * FROM {store.RECORDS} WHERE review_id='sessions_2' ORDER BY record_id", [])
    append_session(environment, monkeypatch, '2026-09-10', '2026-09-11', 150)
    later = run(db, '2026-09-11')
    assert later['status'] == 'daily_nav_reviews_current' and len(later['runs']) == 2
    assert later['policy_checksum'] == result['policy_checksum']
    assert db.query(f"SELECT * FROM {store.RECORDS} WHERE review_id='sessions_2' ORDER BY record_id", []) == old_headers
    final = next(r for r in later['runs'] if r['review_id'] == 'sessions_4')
    assert set(final['result']['reserved_alpha_by_family'].values()) == {.05}
    assert all(r['body']['effects'][0]['accounted_sessions'] == 4 for r in final['result']['reviews'])
    assert later['promotion_allowed'] is False


def test_introduction_groups_do_not_pool_versions_or_grow_with_aliases(environment, monkeypatch, local_policy):
    db, *_ = environment
    migrate(db)
    original, _ = registered_old(environment)
    first = run(db)
    assert len(first['families']) == 2
    assert all(f['introduction_date'] == '2026-09-07' for f in first['families'])
    new = collect(environment, successor_context(environment, monkeypatch))
    second = run(db)
    assert len(second['families']) == 4
    assert {f['family_id'] for f in first['families']} <= {f['family_id'] for f in second['families']}
    item = next(p for p in new['plans'] if p['owner'] == 'allocator_ev_fusion')
    plan = read_snapshot(db.query, item['snapshot_id'])['payload']['content']
    freeze_snapshot(signal_date='2026-09-08', source_run_id='alias-introduction', snapshot_kind='allocation_pair',
        content={**plan, 'pair_id':'alias-later-label'}, query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    alias = run(db)
    assert len(alias['families']) == 4
    assert sum(f['hypothesis_count'] for f in alias['families']) == 4
    assert alias['runs'] == []
    assert not db.query(f'SELECT * FROM {store.RECORDS}', [])


def test_actual_nightly_boundary_records_reviews_and_preserves_accounting_on_retry(environment, monkeypatch, local_policy):
    from routers.walk_forward import _materialize_nav_with_reviews
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    client = SimpleNamespace(query=db.query, batch_execute=db.writer, atomic_batch_execute=db.writer)
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', [])
    result = _materialize_nav_with_reviews(business_date='2026-09-09', learning_client=client, now=stamp('2026-09-09'))
    assert result['status'] == 'up_to_date'
    assert result['family_reviews']['status'] == 'daily_nav_reviews_current'
    assert result['family_reviews']['runs'][0]['result']['reviews']
    again = _materialize_nav_with_reviews(business_date='2026-09-09', learning_client=client, now=stamp('2026-09-09'))
    assert all(r['status'] == 'existing_review_verified' for r in again['family_reviews']['runs'][0]['result']['reviews'])
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id,session_date', []) == before


def test_nightly_does_not_report_complete_when_review_record_write_fails(environment, monkeypatch, local_policy):
    from routers.walk_forward import _materialize_nav_with_reviews
    db, *_ = environment
    migrate(db)
    two_sessions(environment, monkeypatch)
    def writer(statements):
        if store.RECORDS in statements[0][0]:
            raise RuntimeError('fixture_review_storage_down')
        return db.writer(statements)
    client = SimpleNamespace(query=db.query, batch_execute=db.writer, atomic_batch_execute=writer)
    with pytest.raises(RuntimeError, match='paired_nav_daily_review_incomplete'):
        _materialize_nav_with_reviews(business_date='2026-09-09', learning_client=client, now=stamp('2026-09-09'))
    client.atomic_batch_execute = db.writer
    assert _materialize_nav_with_reviews(business_date='2026-09-09', learning_client=client,
        now=stamp('2026-09-09'))['family_reviews']['status'] == 'daily_nav_reviews_current'


def test_default_policy_has_one_code_owned_protocol_and_no_daily_alpha_reset():
    policy = daily.DailyNavReviewPolicy()
    effect, budget = policy.parameters()
    assert policy.minimum_sessions == 10 and policy.final_sessions == 30
    assert dict(budget.review_alphas) == {'sessions_10': .025, 'sessions_30': .025}
    assert effect.policy_id == budget.protocol_id
    assert sum(dict(budget.review_alphas).values()) == budget.family_alpha == .05
    assert policy.parameters() == (effect, budget)


def test_unknown_population_is_not_reported_as_successful_empty_review(local_policy):
    from test_paired_nav_chain import populated
    db = populated()
    migrate(db)
    result = run(db, '2026-09-10')
    assert result['families'] == []
    assert result['status'] == 'partial_daily_nav_reviews'
    assert result['failures'][0]['reason'] == 'nav_daily_population_unresolved'
    assert result['failures'][0]['counts']['unresolved_journal_pair_ids'] == 1


def test_missing_registered_data_is_not_hidden_by_unmet_minimum(environment, local_policy):
    db, *_ = environment
    migrate(db)
    registered_old(environment, materialize=False)
    result = run(db)
    assert result['runs'] == []
    assert result['status'] == 'partial_daily_nav_reviews'
    gap = next(f for f in result['failures'] if f['reason'] == 'nav_daily_registered_evidence_missing')
    assert len(gap['pairs']) == 2
    assert all(p['session_dates'] == ['2026-09-08'] for p in gap['pairs'])
