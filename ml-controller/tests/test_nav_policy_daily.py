"""Original policy source/allocator -> shared NAV reader; synthetic, NOT ROI."""
from datetime import datetime
from copy import deepcopy

import pytest

from services import paired_nav_policy_daily as policy
from services.paired_nav_atomic_candidate import collect_atomic_allocations
from services.paired_nav_route_candidate import collect_route_allocations
from services.paired_nav_journal import read_snapshot
from test_paired_nav_route_pit import prepared, environment, with_routes, route_freeze_clock
from test_paired_nav_atomic_candidate import allocated, full_atomic, native_runner
from test_paired_nav_atomic_dispatch import dispatched
from test_paired_nav_review_store import migrate


def test_route_original_source_is_not_silently_dropped_until_allocation_exists(prepared, route_freeze_clock):
    db, frozen = with_routes(prepared)
    migrate(db)
    args = dict(business_date='2026-09-07', query=db.query,
                now=datetime.fromisoformat('2026-09-07T14:00:00+00:00'))
    missing = policy.refresh_registered_route_nav_decisions(**args)
    assert missing['candidate_count'] == 1 and missing['evaluated_count'] == 0
    assert missing['failures'][0]['reason'] == 'nav_policy_original_allocation_missing'
    collect_route_allocations(snapshot_id=frozen['snapshot_id'], query=db.query, writer=db.writer)
    before = db.conn.total_changes
    adoption = []
    first = policy.refresh_registered_route_nav_decisions(**args, adoption_candidates=adoption)
    assert first['candidate_count'] == first['evaluated_count'] == 1
    assert first['failures'] == []
    assert first['decisions'][0]['decision'] == 'PENDING'
    assert first['decisions'][0]['reason'] == 'nav_mature_sessions_below_checkpoint'
    assert first['decisions'][0]['evaluable_date_count'] == 0
    nav = adoption[0]['payload']['prospective_validation']['nav_validation']
    assert nav['owner'] == 'l15_route' and nav['promotion_allowed'] is False
    assert adoption[0]['registry_state_source'] == 'original_frozen_policy_contrast_not_model_registry'
    payload = adoption[0]['payload']
    request = dict(owner='l15_route', candidate_artifact_id=payload['artifact_id'],
                   candidate_checksum=payload['artifact_checksum'], **args)
    assert policy.read_policy_candidate_decision(**request) == payload
    with pytest.raises(ValueError, match='nav_policy_requested_identity_missing'):
        policy.read_policy_candidate_decision(**{**request, 'candidate_artifact_id': 'wrong-version'})
    with pytest.raises(ValueError, match='nav_policy_owner_invalid'):
        policy.read_policy_candidate_decision(**{**request, 'owner': 'ensemble'})
    assert policy.refresh_registered_route_nav_decisions(**args) == first
    assert db.conn.total_changes == before

@pytest.mark.parametrize('full_atomic', ['native_policy', 'native_policy_complete'], indirect=True)
def test_atomic_inventory_keeps_every_original_definition_and_real_pending(allocated, full_atomic):
    db, graph, state = allocated
    group = collect_atomic_allocations(snapshot_id=state['paired_nav_collection']['snapshot_id'],
                                       query=db.query, writer=db.writer)
    migrate(db)
    before = db.conn.total_changes
    adoption = []
    result = policy.refresh_registered_atomic_nav_decisions(business_date=state['run_date'], query=db.query,
        now=datetime.fromisoformat(state['run_date'] + 'T14:00:00+00:00'), adoption_candidates=adoption)
    assert result['candidate_count'] == 4
    assert result['evaluated_count'] == len(group['plans'])
    assert result['failure_count'] == 4 - len(group['plans'])
    assert all(row['reason'] == 'nav_policy_original_allocation_missing' for row in result['failures'])
    assert all(row['decision'] in {'PENDING', 'HOLD'} for row in result['decisions'])
    assert all(row['evaluable_date_count'] == 0 for row in result['decisions'])
    assert len(adoption) == len(group['plans'])
    # Both candidate and incumbent details retain incomplete original policies.
    definitions = {item['candidate_checksum']: item['definition'] for item in policy.frozen_policy_inventory(
        owner='atomic_strategy', business_date=state['run_date'], query=db.query,
        now=datetime.fromisoformat(state['run_date'] + 'T14:00:00+00:00'))}
    definition = next(iter(definitions.values()))
    for role in ('candidate', 'incumbent'):
        spec = definition[role]
        detail = policy.read_strategy_nav_evidence(strategy_id=spec['id'], strategy_version=spec['version'],
            business_date=state['run_date'], query=db.query,
            now=datetime.fromisoformat(state['run_date'] + 'T14:00:00+00:00'))
        expected = {key for key, value in definitions.items() if any(value[r]['id'] == spec['id']
            and value[r]['version'] == spec['version'] for r in ('candidate', 'incumbent'))}
        assert {row['artifact_checksum'] for row in detail['entries']} == expected
        for row in detail['entries']:
            if row['status'] == 'unavailable':
                assert row['nav'] is None and row['error'] == 'nav_policy_original_allocation_missing'
            else:
                assert row['nav']['decision'] in {'PENDING', 'HOLD'}
                assert row['nav']['evaluable_date_count'] == 0
    assert {row['payload']['artifact_checksum'] for row in adoption} == {
        row['candidate_checksum'] for row in result['decisions']}
    assert db.conn.total_changes == before
    saved = deepcopy(read_snapshot(db.query, state['paired_nav_collection']['snapshot_id']))
    for entry in adoption:
        payload = entry['payload']
        assert policy.read_policy_candidate_decision(owner='atomic_strategy',
            candidate_artifact_id=payload['artifact_id'], candidate_checksum=payload['artifact_checksum'],
            business_date=state['run_date'], query=db.query,
            now=datetime.fromisoformat(state['run_date'] + 'T14:00:00+00:00')) == payload
    assert db.conn.total_changes == before
    altered = deepcopy(saved)
    definitions = altered['payload']['content']['atomic_recommendation_inputs']['definitions']
    first_key = next(iter(definitions))
    definitions[first_key]['status'] = 'caller-altered-status'
    with pytest.raises(ValueError, match='nav_policy_original_inputs_changed'):
        policy._definitions('atomic_strategy', altered)
    saved['payload']['content']['atomic_recommendation_inputs']['definitions'] = {}
    with pytest.raises(ValueError, match='nav_policy_original_population_changed'):
        policy._definitions('atomic_strategy', saved)


def test_policy_projection_rejects_future_business_date_before_inventory():
    def must_not_query(*args):
        pytest.fail('invalid date must fail before source access')
    with pytest.raises(ValueError, match='nav_policy_daily_time_invalid'):
        policy.refresh_registered_route_nav_decisions(business_date='2026-09-08', query=must_not_query,
            now=datetime.fromisoformat('2026-09-07T14:00:00+00:00'))
