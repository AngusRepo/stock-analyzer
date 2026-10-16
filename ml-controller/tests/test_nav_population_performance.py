"""Owner-path performance contracts without replacing economic validators."""
from pathlib import Path

import pytest

from services.paired_nav_journal import read_snapshot
from services.paired_nav_read_cache import reuse_verified_cold_reads
from test_paired_nav_lifecycle import environment, registered_old, stamp


def test_population_cold_census_does_not_decode_full_context_before_comparison_memo(environment, monkeypatch):
    from services import paired_nav_cold as cold
    from services.paired_nav_evidence import read_verified_nav_evidence
    from test_paired_nav_cold import Objects
    db, *_ = environment
    registered_old(environment)
    expected = read_verified_nav_evidence(business_date='2026-09-08', query=db.query,
        now=stamp('2026-09-11')).summary()
    migration = Path(__file__).parents[2] / 'worker/domain-migrations/learning/0048_paired_nav_cold_storage.sql'
    db.conn.executescript(migration.read_text(encoding='utf-8'))
    objects = Objects()
    monkeypatch.setattr(cold, 'production_store', lambda: objects)
    for row in db.query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1', []):
        cold.migrate_snapshot(query=db.query, writer=db.writer, snapshot_id=row['snapshot_id'], store=objects)
    original, full_contexts, root_scans = cold.parse_file, [], []
    def tracked(path, *, prefixes=None, **verification):
        value = original(path, prefixes=prefixes, **verification)
        if prefixes is None and value.get('snapshot_kind') == 'allocation_context':
            full_contexts.append(value['source_run_id'])
        if prefixes == frozenset({'schema_version', 'signal_date', 'snapshot_kind', 'source_run_id',
                                  'content.upstream_allocation_context_snapshot_id'}):
            root_scans.append(value['source_run_id'])
        return value
    monkeypatch.setattr(cold, 'parse_file', tracked)
    with reuse_verified_cold_reads():
        for _ in range(4):
            actual = read_verified_nav_evidence(business_date='2026-09-08', query=db.query,
                now=stamp('2026-09-11')).summary()
            assert actual == expected
    # L4/Fusion validators consume exact verified projections. The population
    # owner must not force an unrelated full history decode before a memo hit.
    assert full_contexts == []
    assert root_scans == []


def test_supplied_mutable_full_parent_is_validated_without_extra_full_digest(environment, monkeypatch):
    from services import paired_nav_comparison as comparison
    db, *_ = environment
    registered_old(environment)
    allocations = [read_snapshot(db.query, row['snapshot_id']) for row in db.query(
        "SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", [])]
    allocation = next(value for value in allocations if value['payload']['content']['owner'] == 'l4_alpha_ev')
    parent = read_snapshot(db.query, allocation['payload']['content']['allocation_context_snapshot_id'])
    original = comparison.digest
    def forbid_extra_whole_parent_digest(value):
        assert value is not parent['payload'], 'supplied history was redundantly encoded'
        return original(value)
    monkeypatch.setattr(comparison, 'digest', forbid_extra_whole_parent_digest)
    with reuse_verified_cold_reads():
        expected = comparison.resolve_allocation_comparison(query=db.query, allocation=allocation)
        assert comparison.resolve_allocation_comparison(query=db.query, allocation=allocation, parent=parent) == expected
        parent['payload']['content']['formal_output'] = []
        with pytest.raises(ValueError, match='incumbent_mismatch'):
            comparison.resolve_allocation_comparison(query=db.query, allocation=allocation, parent=parent)


def test_supplied_parent_changed_manifest_still_fails_closed(environment):
    from services.paired_nav_comparison import resolve_allocation_comparison
    db, *_ = environment
    registered_old(environment)
    allocation = next(read_snapshot(db.query, row['snapshot_id']) for row in db.query(
        "SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair'", []))
    parent = read_snapshot(db.query, allocation['payload']['content']['allocation_context_snapshot_id'])
    parent['manifest'] = {**parent['manifest'], 'payload_checksum': 'f' * 64}
    with pytest.raises(RuntimeError, match='parent_changed'):
        resolve_allocation_comparison(query=db.query, allocation=allocation, parent=parent)
