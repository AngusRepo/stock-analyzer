"""Real allocation/journal/parent validation; synthetic returns, not efficacy."""
import json

import pytest

from services.paired_nav_comparison import resolve_comparison
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import digest, encode, mature_staged_pairs, read_snapshot, materialize_pair
from test_paired_nav_lifecycle import environment, registered_old, stamp


def test_l4_plus_increment_is_not_labelled_incumbent_replacement(environment):
    db, *_ = environment
    _, registrations = registered_old(environment)
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
    evidence = read_verified_nav_evidence(now=stamp('2026-09-11'), business_date='2026-09-08', query=db.query)
    by_owner = {dict(p.comparison)['owner']: p.summary() for p in evidence.pairs}
    assert by_owner['l4_alpha_ev']['comparison']['kind'] == 'incumbent_replacement'
    fusion = by_owner['allocator_ev_fusion']['comparison']
    assert fusion['kind'] == 'incremental_layer'
    assert fusion['baseline_kind'] == 'exact_frozen_l4_candidate'
    assert fusion['baseline_checksum'] == by_owner['l4_alpha_ev']['comparison']['candidate_checksum']
    assert evidence.summary()['endpoint'] == 'candidate_minus_declared_baseline_costed_daily_nav_return'
    assert all(p['exact_nav_sessions'] == 1 and p['promotion_allowed'] is False for p in by_owner.values())
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == before
    assert len(registrations) == 2


def test_old_journal_without_display_metadata_keeps_checksum_and_maturity(environment):
    db, *_ = environment
    registered_old(environment)
    db.conn.execute('DROP TRIGGER paired_nav_journal_no_update_v1')
    for row in db.query('SELECT pair_id,payload_json FROM paired_nav_daily_journal_v1', []):
        body = json.loads(row['payload_json'])
        body.pop('comparison')
        db.conn.execute('UPDATE paired_nav_daily_journal_v1 SET payload_json=?,payload_checksum=? WHERE pair_id=?',
            [encode(body), digest(body), row['pair_id']])
    from pathlib import Path
    migration = Path(__file__).resolve().parents[2] / 'worker/domain-migrations/learning/0040_paired_nav_shadow_journal.sql'
    db.conn.executescript(migration.read_text(encoding='utf-8'))
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
    result = mature_staged_pairs(business_date='2026-09-08', query=db.query, writer=db.writer, now=stamp('2026-09-08'))
    assert result['processed_pair_sessions'] == 0
    assert all(p['comparison'] and p['accounted_sessions'] == 1 for p in result['paired_nav_evidence']['pairs'])
    for row in db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt'", []):
        execution = read_snapshot(db.query, row['snapshot_id'])['payload']['content']
        replayed = materialize_pair(snapshot_id=execution['snapshot_id'], session_date=execution['session_date'],
            execution=execution, query=db.query, writer=db.writer, now=stamp('2026-09-08'))
        assert 'comparison' not in replayed
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == before


def test_execution_only_legacy_does_not_invent_a_formal_baseline():
    from test_paired_nav_chain import populated
    evidence = read_verified_nav_evidence(now=stamp('2026-09-11'), business_date='2026-09-10', query=populated().query)
    assert all(p.summary()['comparison'] is None for p in evidence.pairs)


def test_observer_cannot_change_verified_comparison_kind(environment):
    db, *_ = environment
    registered_old(environment)
    def mutate(prefix):
        prefix['comparison']['kind'] = 'invented'
    evidence = read_verified_nav_evidence(now=stamp('2026-09-11'), business_date='2026-09-08', query=db.query, observe_prefix=mutate)
    assert {dict(p.comparison)['kind'] for p in evidence.pairs} == {'incumbent_replacement', 'incremental_layer'}


def test_coherently_rehashed_journal_cannot_relabel_fusion_as_formal(environment):
    db, *_ = environment
    registered_old(environment)
    db.conn.execute('DROP TRIGGER paired_nav_journal_no_update_v1')
    row = next(r for r in db.query('SELECT * FROM paired_nav_daily_journal_v1', [])
        if json.loads(r['payload_json'])['comparison']['owner'] == 'allocator_ev_fusion')
    body = json.loads(row['payload_json'])
    body['comparison'].update(kind='incumbent_replacement', baseline_kind='frozen_incumbent_policy')
    db.conn.execute('UPDATE paired_nav_daily_journal_v1 SET payload_json=?,payload_checksum=? WHERE pair_id=?',
        [encode(body), digest(body), row['pair_id']])
    with pytest.raises(RuntimeError, match='chain_comparison_mismatch'):
        read_verified_nav_evidence(now=stamp('2026-09-11'), business_date='2026-09-08', query=db.query)
