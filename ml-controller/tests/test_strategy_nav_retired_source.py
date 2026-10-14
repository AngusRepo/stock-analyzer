from copy import deepcopy
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from services.paired_nav_journal import freeze_snapshot, digest
from services import paired_nav_population as census, paired_nav_collection, trading_config_loader
from test_paired_nav_journal import DB, FEES
from test_paper_single_b_tabpack import single_config

NOW = datetime(2026,9,8,14,tzinfo=timezone.utc)


def fixture(monkeypatch, fault=None):
    db = DB()
    old = {'allocator.py': 'a'*64}
    risk = {'source_identity': old, 'signal_date': '2026-09-07', 'payload_checksum': digest([])}
    risk['content_checksum'] = digest(risk)
    if fault == 'risk_checksum':
        risk['content_checksum'] = 'f'*64
    context = {'allocator_source_identity': old, 'strategy_bundle_risk_context': risk,
        'recommendation_context': {'inputs': {'payloads': []}}}
    parent = freeze_snapshot(signal_date='2026-09-07', source_run_id='source',
        snapshot_kind='allocation_context', content=context, query=db.query, writer=db.writer,
        now=datetime(2026,9,7,14,tzinfo=timezone.utc))
    config = {'trading_config': {'fees': FEES}, 'allocator_source_identity': old, 'strategy_bundle': {'frozen': True}}
    plan = {'pair_id': 'retained-retired-pair', 'owner': 'atomic_strategy' if fault == 'same_owner' else 'ensemble',
        'candidate_checksum': 'c'*64, 'baseline_checksum': 'b'*64,
        'configuration': config, 'configuration_checksum': digest(config),
        'allocation_context_snapshot_id': parent['snapshot_id']}
    allocation = freeze_snapshot(signal_date='2026-09-07', source_run_id=plan['pair_id'],
        snapshot_kind='allocation_pair', content=plan, query=db.query, writer=db.writer,
        now=datetime(2026,9,7,14,1,tzinfo=timezone.utc))
    packet = {**plan, 'allocation_snapshot_id': allocation['snapshot_id'],
        'configuration': {**config, 'fees': FEES}, 'session_date': '2026-09-08',
        'session_open_at': '2026-09-08T01:00:00Z', 'session_close_at': '2026-09-08T05:30:00Z',
        'schedule': [{'observed_at': '2026-09-08T07:15:00+08:00'}]}
    packet['configuration_checksum'] = digest(packet['configuration'])
    if fault == 'execution_parent':
        packet['candidate_checksum'] = 'd'*64
    freeze_snapshot(signal_date='2026-09-07', source_run_id=plan['pair_id'], snapshot_kind='execution_pair',
        content=packet, query=db.query, writer=db.writer, now=datetime(2026,9,7,14,2,tzinfo=timezone.utc))
    monkeypatch.setattr(paired_nav_collection, 'allocator_source_identity',
        lambda: old if fault == 'same_source' else {'allocator.py': 'e'*64})
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
        lambda: SimpleNamespace(config={} if fault == 'not_single_b' else single_config(),
            contract=SimpleNamespace(degraded=fault == 'degraded')))
    def source_version_failure(**kwargs):
        raise ValueError('paired_nav_allocator_history_context_invalid')
    monkeypatch.setattr(census, 'resolve_allocation_comparison', source_version_failure)
    return db, parent, allocation


def test_original_census_keeps_failed_retired_hypothesis_and_all_sources(monkeypatch):
    db, parent, allocation = fixture(monkeypatch)
    result = census.read_candidate_population(business_date='2026-09-08', query=db.query, series=[], now=NOW)
    assert result['pair_count'] == result['hypothesis_count'] == 1
    pair = result['pairs'][0]
    assert pair['owner'] == 'ensemble'
    assert pair['comparison']['kind'] == 'unavailable_retired_source'
    assert pair['allocation_snapshot_ids'] == [allocation['snapshot_id']]
    assert pair['registered_session_dates'] == pair['unaccounted_session_dates'] == ['2026-09-08']
    assert pair['accounted_sessions'] == pair['exact_nav_sessions'] == 0
    assert result['unresolved_selection_sources'][0]['owner'] == 'ensemble'
    assert result['selection_materialization_complete'] is False and result['promotion_allowed'] is False
    assert len(db.query('SELECT * FROM paired_nav_frozen_manifests_v1', [])) == 3
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []


@pytest.mark.parametrize('fault', ['same_owner', 'risk_checksum', 'execution_parent', 'same_source', 'not_single_b', 'degraded'])
def test_retired_failure_cannot_hide_active_source_corruption_or_wrong_execution(monkeypatch, fault):
    db, *_ = fixture(monkeypatch, fault)
    with pytest.raises(ValueError):
        census.read_candidate_population(business_date='2026-09-08', query=db.query, series=[], now=NOW)
