from datetime import datetime, timedelta, timezone

import pytest

from services.paper_corporate_source import materialize_corporate_source
from services.native_paper_source_capture import ImmutableNativeObjects
from test_native_paper_source_capture import Bucket


def test_immutable_source_is_saved_before_delivery_and_restart_cannot_fetch_new_terms():
    objects, calls = ImmutableNativeObjects(Bucket()), []
    now = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    def reader(**kwargs):
        calls.append(kwargs)
        return {'schema_version': 'paper-corporate-source-v1', 'session_date': '2026-09-08',
            'source_checksum': 'a' * 64, 'tax_basis': 'gross_before_personal_tax', 'blockers': {},
            'covered_symbols': ['2330'], 'actions': [], 'observed_at': now.isoformat()}
    args = dict(session_date='2026-09-08', scope_id='paper-account-1', symbols=['2330'],
        outstanding_action_ids=[], objects=objects, reader=reader)
    first = materialize_corporate_source(**args, clock=lambda: now)
    assert first['account_mutations'] == 0 and len(calls) == 1
    assert materialize_corporate_source(**args, clock=lambda: now + timedelta(days=1)) == first
    assert len(calls) == 1
    with pytest.raises(ValueError, match='frozen_scope_changed'):
        materialize_corporate_source(**{**args, 'symbols': ['1101']}, clock=lambda: now)


@pytest.mark.parametrize('hour', [1, 6])
def test_new_historical_or_after_open_capture_cannot_become_accounting_source(hour):
    with pytest.raises(ValueError, match='live_preopen'):
        materialize_corporate_source(session_date='2026-09-08', scope_id='paper-account-1',
            symbols=[], outstanding_action_ids=[], objects=ImmutableNativeObjects(Bucket()),
            clock=lambda: datetime(2026, 9, 8, hour, tzinfo=timezone.utc))


def test_empty_account_never_claims_unqueried_universe_and_stale_source_is_rejected():
    now = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    args = dict(session_date='2026-09-08', scope_id='paper-account-1',
        symbols=[], outstanding_action_ids=[], objects=ImmutableNativeObjects(Bucket()), clock=lambda: now)
    record = materialize_corporate_source(**args)
    assert record['snapshot']['covered_symbols'] == []
    with pytest.raises(ValueError, match='not_current_capture'):
        materialize_corporate_source(**{**args, 'symbols': ['2330'], 'objects': ImmutableNativeObjects(Bucket())},
            reader=lambda **kwargs: {'schema_version': 'paper-corporate-source-v1', 'session_date': '2026-09-08',
                'covered_symbols': ['2330'], 'actions': [], 'observed_at': '2026-09-06T23:00:00Z'})


def test_blocked_attempt_does_not_poison_the_first_writer_ready_delivery():
    from services.paired_nav_journal import digest
    objects = ImmutableNativeObjects(Bucket())
    now = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    snapshot = {'schema_version': 'paper-corporate-source-v1', 'session_date': '2026-09-08',
        'source_checksum': 'a' * 64, 'tax_basis': 'gross_before_personal_tax', 'covered_symbols': ['2330'],
        'actions': [], 'observed_at': now.isoformat(), 'blockers': {'2330': ['issuer_latest_revision_not_linked']}}
    args = dict(session_date='2026-09-08', scope_id='paper-account-1', symbols=['2330'],
        outstanding_action_ids=[], objects=objects, reader=lambda **_: snapshot, clock=lambda: now)
    with pytest.raises(ValueError, match='blocked_before_publication'):
        materialize_corporate_source(**args)
    identity = {'owner': 'paper-corporate-source-v1', 'session_date': '2026-09-08', 'scope_id': 'paper-account-1'}
    assert objects.lookup_delivery(digest(identity)) is None
    snapshot = {**snapshot, 'blockers': {}}
    assert materialize_corporate_source(**args)['snapshot']['blockers'] == {}


@pytest.mark.parametrize('problem', ['duplicate_exchange', 'combined_stock', 'cash_leg_missing'])
def test_unbookable_combined_terms_never_poison_published_source(problem):
    objects = ImmutableNativeObjects(Bucket())
    now = datetime(2026, 9, 7, 23, tzinfo=timezone.utc)
    action = {'action_id': 'exchange', 'symbol': '2330', 'kind': 'exchange', 'ex_date': '2026-09-08',
              'payable_date': '2026-09-08', 'cash_per_share': 0., 'stock_per_share': .75}
    actions = [action]
    if problem == 'cash_leg_missing':
        action['capital_return_per_share'] = 2.5
    else:
        actions.append({**action, 'action_id': 'another', 'kind': 'stock' if problem == 'combined_stock' else 'exchange'})
    snapshot = {'schema_version': 'paper-corporate-source-v1', 'session_date': '2026-09-08',
        'source_checksum': 'a' * 64, 'tax_basis': 'gross_before_personal_tax', 'covered_symbols': ['2330'],
        'actions': actions, 'observed_at': now.isoformat(), 'blockers': {}}
    args = dict(session_date='2026-09-08', scope_id='paper-account-1', symbols=['2330'],
        outstanding_action_ids=[], objects=objects, reader=lambda **_: snapshot, clock=lambda: now)
    with pytest.raises(ValueError, match='combined_share_conversion|capital_cash_leg_missing'):
        materialize_corporate_source(**args)
    snapshot = {**snapshot, 'actions': [{**action, 'capital_return_per_share': 0.}]}
    assert materialize_corporate_source(**args)['snapshot'] == snapshot
