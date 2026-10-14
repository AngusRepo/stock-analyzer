"""Original family budget/denominator; only retired owner scheduling is scoped."""
from dataclasses import replace
import json
import pytest
from services import paired_nav_daily_review as daily
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import digest, encode
from test_paired_nav_lifecycle import environment, registered_old, stamp
from test_paired_nav_review_store import migrate


def test_retired_missing_sessions_remain_in_inventory_without_starving_strategy_owner(environment, monkeypatch):
    db, *_ = environment
    migrate(db)
    registered_old(environment, materialize=False)
    args = dict(business_date='2026-09-08', query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    all_owners = daily.run_daily_nav_reviews(**args)
    assert any(f['reason'] == 'nav_daily_registered_evidence_missing' for f in all_owners['failures'])
    own = daily.run_daily_nav_reviews(**args, active_owners=('atomic_strategy',))
    assert own['status'] == 'daily_nav_reviews_current'
    assert own['families'] == all_owners['families']
    assert own['source_population_checksum'] == all_owners['source_population_checksum']
    assert own['runs'] == [] and own['retained_retired_owners']
    assert own['policy_checksum'] == daily.POLICY.checksum


@pytest.mark.parametrize('fault', ['same_owner_missing_source', 'unknown_legacy_source'])
def test_strategy_scope_cannot_hide_same_owner_or_unknown_provenance(environment, monkeypatch, fault):
    db, *_ = environment
    migrate(db)
    registered_old(environment, materialize=False)
    now = stamp('2026-09-08')
    evidence = read_verified_nav_evidence(business_date='2026-09-08', query=db.query, now=now)
    population = json.loads(evidence.population_json)
    if fault == 'same_owner_missing_source':
        population['unresolved_selection_sources'].append({'owner':'atomic_strategy',
            'allocation_context_snapshot_id':'controlled-unavailable-source'})
    else:
        population['unresolved_legacy_execution_snapshot_ids'].append('unknown-owner')
    population['population_checksum'] = digest({k:v for k,v in population.items() if k!='population_checksum'})
    # Inject a precise error at the verified-source adapter; no verdict/ledger
    # is fabricated and the real daily orchestrator must preserve the failure.
    monkeypatch.setattr(daily, 'read_verified_nav_evidence', lambda **kw:
        replace(evidence, population_json=encode(population)))
    result = daily.run_daily_nav_reviews(business_date='2026-09-08', query=db.query,
        writer=db.writer, now=now, active_owners=('atomic_strategy',))
    assert result['status'] == 'partial_daily_nav_reviews'
    assert any(f['reason'] == 'nav_daily_population_unresolved' for f in result['failures'])
    assert result['promotion_allowed'] is False
