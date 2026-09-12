"""Actual EV inference/allocator continuation with synthetic model packets."""
import hashlib
import json

import pytest

from services import paired_nav_candidate_collection as collection
from services.expected_return_artifact_identity import attach_expected_return_artifact_identity
from services.paired_nav_journal import read_snapshot
from test_paired_nav_lifecycle import environment, registered_old, successor_context, collect
from test_paired_nav_candidate_collection import fixture_candidate


def add_new_cohort(db, bucket):
    checksums = set()
    for owner in ('l4_alpha_ev', 'allocator_ev_fusion'):
        row, raw = fixture_candidate(owner)
        packet = json.loads(raw)
        artifact = packet['artifact']
        packet['cohort_id'] = artifact['training_data']['cohort_id'] = 'new-cohort'
        artifact['model_version'] += '-next'
        if owner == 'l4_alpha_ev':
            artifact['intercept'] += .01
        else:
            artifact['residual_adjustment_model']['intercept'] += .01
        attach_expected_return_artifact_identity(artifact)
        raw = json.dumps(packet, sort_keys=True).encode()
        checksum = hashlib.sha256(raw).hexdigest()
        row.update(version=artifact['model_version'], checksum=checksum,
            artifact_id=f"{owner}:{artifact['model_version']}:{checksum}",
            training_run_id='active8_oof:new-cohort', source_run_date='2026-09-07',
            updated_at='2026-09-07T14:00:00Z', artifact_path=f'candidate/{owner}-next.json',
            candidate_type=owner + '_refresh', offline_evidence_json='{}')
        db.conn.execute('INSERT INTO model_artifact_registry(' + ','.join(row) + ') VALUES('
            + ','.join('?' for _ in row) + ')', list(row.values()))
        bucket.payloads[row['artifact_path']] = raw
        checksums.add(checksum)
    return checksums


@pytest.mark.parametrize('registry_change', ['archive', 'delete', 'outside_latest_80'])
def test_registered_ev_models_survive_registry_change_without_reset(environment, monkeypatch, registry_change):
    db, *_ = environment
    old, _ = registered_old(environment)
    before = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
    if registry_change == 'outside_latest_80':
        row = db.query('SELECT * FROM model_artifact_registry LIMIT 1', [])[0]
        for index in range(80):
            archived = {**row, 'artifact_id': f'unrelated-archived-row-{index}', 'state': 'archived',
                'source_run_date': '2026-09-07', 'updated_at': '2026-09-07T14:00:00Z'}
            db.conn.execute('INSERT INTO model_artifact_registry(' + ','.join(archived) + ') VALUES('
                + ','.join('?' for _ in archived) + ')', list(archived.values()))
    else:
        db.conn.execute("UPDATE model_artifact_registry SET state='archived'" if registry_change == 'archive'
            else 'DELETE FROM model_artifact_registry')
    result = collect(environment, successor_context(environment, monkeypatch, changed=False))
    assert len(result['plans']) == 2
    assert {r['pair_id'] for r in result['plans']} == {r['pair_id'] for r in old['plans']}
    assert result['lifecycle_transition_plan'] == []
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == before


def test_new_cohort_does_not_replace_old_registered_models(environment, monkeypatch):
    db, bucket, *_ = environment
    old, _ = registered_old(environment)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    new_checksums = add_new_cohort(db, bucket)
    result = collect(environment, successor_context(environment, monkeypatch, changed=False))
    assert len(result['plans']) == 4
    assert {p['pair_id'] for p in old['plans']} < {p['pair_id'] for p in result['plans']}
    plans = [read_snapshot(db.query, p['snapshot_id'])['payload']['content'] for p in result['plans']]
    assert new_checksums < {p['candidate_checksum'] for p in plans}
    l4 = {p['candidate_checksum']: p for p in plans if p['owner'] == 'l4_alpha_ev'}
    assert len(l4) == 2
    for fusion in [p for p in plans if p['owner'] == 'allocator_ev_fusion']:
        base = l4[fusion['exact_l4_checksum']]
        assert fusion['baseline']['output'] == base['candidate']['output']
        assert fusion['candidate_training_run_id'] == base['candidate_training_run_id']
    assert result['lifecycle_transition_plan'] == []


def test_partial_plan_retry_keeps_frozen_membership_after_registry_disappears(environment, monkeypatch):
    db, bucket, *_ = environment
    registered_old(environment)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    add_new_cohort(db, bucket)
    context = successor_context(environment, monkeypatch, changed=False)
    seal = collection.freeze_snapshot
    calls = 0
    def interrupted(**kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError('fixture_second_plan_interrupted')
        return seal(**kwargs)
    monkeypatch.setattr(collection, 'freeze_snapshot', interrupted)
    failed = collect(environment, context)
    assert failed['status'] == 'partial_allocation_pairs'
    assert len(failed['plans']) == 2  # One L4 and only its exact Fusion survive.
    assert len(failed['candidate_failures']) == 2
    assert failed['owner_failures']['expected_return']['error_type'] == 'RuntimeError'
    first = db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair' AND signal_date='2026-09-08'", [])
    assert len(first) == 2
    db.conn.execute('DELETE FROM model_artifact_registry')
    monkeypatch.setattr(collection, 'freeze_snapshot', seal)
    result = collect(environment, context)
    assert len(result['plans']) == 4
    for original in first:
        assert db.query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [original['snapshot_id']]) == [original]
    assert collect(environment, context) == result


def test_missing_exact_old_blob_does_not_fall_back_to_new_cohort(environment, monkeypatch):
    db, bucket, *_ = environment
    registered_old(environment)
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    old_path = db.query("SELECT artifact_path FROM model_artifact_registry WHERE model_name='l4_alpha_ev'", [])[0]['artifact_path']
    new_checksums = add_new_cohort(db, bucket)
    bucket.payloads[old_path] = b'{}'
    context = successor_context(environment, monkeypatch, changed=False)
    failed = collect(environment, context)
    assert failed['status'] == 'partial_allocation_pairs' and len(failed['plans']) == 2
    assert failed['owner_failures']['expected_return']['error_type'] == 'ValueError'
    assert {f['reason'] for f in failed['candidate_failures']} == {
        'candidate_forward_packet_checksum_mismatch', 'paired_nav_exact_l4_baseline_unavailable'}
    plans = [read_snapshot(db.query, p['snapshot_id'])['payload']['content'] for p in failed['plans']]
    assert {p['candidate_checksum'] for p in plans} == new_checksums
    assert all(len(p['ev_candidate_selection']['registry_rows']) == 4 for p in plans)
    assert len(db.query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='allocation_pair' AND signal_date='2026-09-08'", [])) == 2
