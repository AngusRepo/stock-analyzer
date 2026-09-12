"""Independent shadow failures must not starve valid native execution owners."""
from copy import deepcopy

from services import paired_nav_candidate_collection as candidates
from services import paired_nav_l3_candidate as l3
from services.paired_nav_journal import read_snapshot
from services.paired_nav_evidence import read_verified_nav_evidence
from test_paired_nav_candidate_collection import environment
from test_paired_nav_l3_candidate import prepared, seal


def test_real_ev_plans_survive_l3_failure_and_retry(environment, monkeypatch):
    db, bucket, root, original = environment
    kwargs = dict(snapshot_id=root['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    before = deepcopy(original)
    original_l3 = l3.collect_ensemble_allocations
    def unavailable(**kw):
        raise RuntimeError('https://provider.invalid/?token=private')
    monkeypatch.setattr(l3, 'collect_ensemble_allocations', unavailable)
    result = candidates.collect_candidate_allocations(**kwargs)
    assert result['status'] == 'partial_allocation_pairs'
    assert [p['owner'] for p in result['plans']] == ['l4_alpha_ev', 'allocator_ev_fusion']
    assert result['owner_failures']['ensemble']['status'] == 'failed'
    assert 'private' not in str(result) and 'provider.invalid' not in str(result)
    frozen = [read_snapshot(db.query, p['snapshot_id']) for p in result['plans']]
    monkeypatch.setattr(l3, 'collect_ensemble_allocations', original_l3)
    recovered = candidates.collect_candidate_allocations(**kwargs)
    assert recovered['status'] == 'allocation_pairs_frozen'
    assert recovered['plans'] == result['plans']
    assert 'owner_failures' not in recovered
    assert [read_snapshot(db.query, p['snapshot_id']) for p in recovered['plans']] == frozen
    assert original == before
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


def test_real_l3_inference_survives_corrupt_ev_source_and_retry(prepared):
    db, bucket, _, _, _ = prepared
    root = seal(prepared)
    path = db.query("SELECT artifact_path FROM model_artifact_registry WHERE model_name='l4_alpha_ev'", [])[0]['artifact_path']
    original = bucket.payloads[path]
    bucket.payloads[path] = b'{}'
    kwargs = dict(snapshot_id=root['snapshot_id'], query=db.query, writer=db.writer, bucket=bucket)
    result = candidates.collect_candidate_allocations(**kwargs)
    assert result['status'] == 'partial_allocation_pairs'
    assert [p['owner'] for p in result['plans']] == ['ensemble']
    assert result['owner_failures']['expected_return']['status'] == 'failed'
    frozen = read_snapshot(db.query, result['plans'][0]['snapshot_id'])
    plan = frozen['payload']['content']
    parent = read_snapshot(db.query, plan['allocation_context_snapshot_id'])['payload']['content']
    arms = parent['model_prediction_arms']
    assert arms['baseline']['model_identity'] != arms['candidate']['model_identity']
    assert parent['upstream_allocation_context_snapshot_id'] == root['snapshot_id']
    population = read_verified_nav_evidence(business_date='2026-09-07', query=db.query).summary()['candidate_population']
    assert population['declared_selection_count'] == 3
    assert len(population['unmaterialized_selections']) == 2
    assert population['selection_materialization_complete'] is False
    # Retry must use the original pre-inference selection even if registry state changes.
    db.conn.execute("UPDATE model_artifact_registry SET state='archived'")
    bucket.payloads[path] = original
    recovered = candidates.collect_candidate_allocations(**kwargs)
    assert recovered['status'] == 'allocation_pairs_frozen'
    assert len(recovered['plans']) == 3
    assert read_snapshot(db.query, result['plans'][0]['snapshot_id']) == frozen
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])
    assert not db.query('SELECT * FROM paired_nav_daily_journal_v1', [])


def test_failed_original_ev_selection_is_unknown_not_zero_or_reselected(prepared, monkeypatch):
    from services import paired_nav_ev_selection as selection
    db, bucket, _, _, _ = prepared
    original = selection._candidate_rows
    def unavailable(*args, **kwargs):
        raise RuntimeError('https://source.invalid/?token=private')
    monkeypatch.setattr(selection, '_candidate_rows', unavailable)
    root = seal(prepared)
    before = read_snapshot(db.query, root['snapshot_id'])
    captured = before['payload']['content']['ev_candidate_selection']
    assert captured['status'] == 'failed'
    assert 'private' not in str(captured)
    # Restored availability cannot make today's new registry a past source.
    monkeypatch.setattr(selection, '_candidate_rows', original)
    result = candidates.collect_candidate_allocations(snapshot_id=root['snapshot_id'],
        query=db.query, writer=db.writer, bucket=bucket)
    assert result['status'] == 'partial_allocation_pairs'
    assert [p['owner'] for p in result['plans']] == ['ensemble']
    assert result['owner_failures']['expected_return']['reason'] == 'paired_nav_ev_selection_unavailable'
    population = read_verified_nav_evidence(business_date='2026-09-07', query=db.query).summary()['candidate_population']
    assert population['selection_materialization_complete'] is False
    assert [s['owner'] for s in population['unresolved_selection_sources']] == ['expected_return']
    assert read_snapshot(db.query, root['snapshot_id']) == before
