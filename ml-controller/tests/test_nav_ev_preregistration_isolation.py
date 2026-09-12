"""Original two-cohort EV selection/inference/seals; no favorable-row filtering."""
import pytest

from services import paired_nav_candidate_collection as collection
from services.paired_nav_journal import read_snapshot
from test_paired_nav_lifecycle import environment, registered_old, successor_context, collect
from test_paired_nav_ev_selection import add_new_cohort


@pytest.mark.parametrize('failure_stage', ['load', 'inference', 'seal', 'dependency'])
def test_one_bad_candidate_cannot_starve_other_frozen_candidates(environment, monkeypatch, failure_stage):
    db, bucket, *_ = environment
    registered_old(environment)
    old_l4 = db.query("SELECT * FROM model_artifact_registry WHERE model_name='l4_alpha_ev'", [])[0]
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    new_checksums = add_new_cohort(db, bucket)
    new_fusion = db.query("SELECT * FROM model_artifact_registry WHERE model_name='allocator_ev_fusion' AND state='shadowing'", [])[0]
    context = successor_context(environment, monkeypatch, changed=False)
    broken = old_l4 if failure_stage == 'dependency' else new_fusion
    raw = bucket.payloads[broken['artifact_path']]
    real_infer = collection.infer_candidate_values
    real_freeze = collection.freeze_snapshot
    if failure_stage in {'load', 'dependency'}:
        bucket.payloads[broken['artifact_path']] = b'{}'
    elif failure_stage == 'inference':
        def infer(candidate, *args, **kwargs):
            if candidate['checksum'] == broken['checksum']:
                raise ValueError('paired_nav_fixture_inference_failed')
            return real_infer(candidate, *args, **kwargs)
        monkeypatch.setattr(collection, 'infer_candidate_values', infer)
    else:
        def freeze(**kwargs):
            if kwargs['content'].get('candidate_checksum') == broken['checksum']:
                raise RuntimeError('paired_nav_fixture_seal_failed')
            return real_freeze(**kwargs)
        monkeypatch.setattr(collection, 'freeze_snapshot', freeze)
    journals = db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', [])
    result = collect(environment, context)
    assert result['status'] == 'partial_allocation_pairs'
    assert len(result['plans']) == (2 if failure_stage == 'dependency' else 3)
    failures = result['candidate_failures']
    assert broken['checksum'] in {f['candidate_checksum'] for f in failures}
    assert len(failures) == (2 if failure_stage == 'dependency' else 1)
    healthy = [read_snapshot(db.query, p['snapshot_id']) for p in result['plans']]
    for saved in healthy:
        selection = saved['payload']['content']['ev_candidate_selection']
        assert len(selection['registry_rows']) == 4
        assert len(selection['l4_checksums']) == 2 and len(selection['fusion_bases']) == 2
    if failure_stage == 'dependency':
        assert {p['payload']['content']['candidate_checksum'] for p in healthy} == new_checksums
        assert any(f['reason'] == 'paired_nav_exact_l4_baseline_unavailable' for f in failures)
    bucket.payloads[broken['artifact_path']] = raw
    monkeypatch.setattr(collection, 'infer_candidate_values', real_infer)
    monkeypatch.setattr(collection, 'freeze_snapshot', real_freeze)
    recovered = collect(environment, context)
    assert recovered['status'] == 'allocation_pairs_frozen' and len(recovered['plans']) == 4
    assert not recovered.get('candidate_failures')
    for saved in healthy:
        assert read_snapshot(db.query, saved['manifest']['snapshot_id']) == saved
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1 ORDER BY pair_id', []) == journals
