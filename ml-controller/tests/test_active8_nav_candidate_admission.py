"""Real archive/SQL/shadow inference with fixed synthetic artifacts, NOT ROI."""
from copy import deepcopy
import json

import pytest

from services import ensemble_v2 as ensemble, paired_nav_l3_candidate as l3
from services.active8_ensemble_repository import persist_active8_ensemble_candidate
from services.model_artifact_registry import _validated_active8_ensemble_payload
from services.paired_nav_journal import digest
from test_active8_ensemble_repository import Bucket
from test_paired_nav_candidate_collection import environment
from test_paired_nav_l3_candidate import prepared, fixed_artifact, seal, DAY, CUTOFF


def diagnostic_failure():
    artifact = fixed_artifact('candidate-v1')
    artifact['cohort_id'] += '-diagnostic'
    artifact['validation'].update(decision='FAIL', rank_ic_equal_date_market_lcb90=-.1,
        failed_gates=['chronological_validation_equal_date_market_rank_ic_lcb90_non_positive'])
    artifact['payload_checksum'] = digest({k: v for k, v in artifact.items() if k != 'payload_checksum'})
    return artifact


def test_failed_offline_diagnostic_registers_then_uses_real_daily_shadow_not_serving(prepared):
    db, _, manifest, inputs, _ = prepared
    artifact, bucket = diagnostic_failure(), Bucket()
    class SqlRegistry:
        query = staticmethod(db.query)
        def execute(self, sql, params):
            return db.writer([(sql, params)])
    registry = SqlRegistry()
    first = persist_active8_ensemble_candidate(artifact, training_run_id='candidate-run', bucket=bucket, d1_client=registry)
    assert first['state'] == 'candidate' and first['production_effect'] is False
    # Isolated fixture clock, not backdating a historical production artifact.
    db.conn.execute("UPDATE active8_ensemble_artifacts_v1 SET created_at='2026-09-06 03:00:00' WHERE artifact_id=?", [first['artifact_id']])
    before = db.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [first['artifact_id']])[0]
    again = persist_active8_ensemble_candidate(artifact, training_run_id='candidate-run', bucket=bucket, d1_client=registry)
    assert again == first
    assert db.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [first['artifact_id']])[0] == before
    assert before['validation_decision'] == 'FAIL'
    assert json.loads(before['validation_json']) == artifact['validation']
    assert next(iter(bucket.blobs.values())).writes == 1
    selection = l3.load_candidate_ensembles(manifest=manifest, signal_date=DAY, decision_cutoff=CUTOFF, query=db.query)
    assert len(selection['candidates']) == 2  # Neither latest-only nor select-by-return.
    candidate = next(c for c in selection['candidates'] if c['artifact']['payload_checksum'] == artifact['payload_checksum'])
    saved = deepcopy(inputs)
    predicted = l3.infer_candidate_predictions(predictions=inputs['predictions'], candidate=candidate, signal_date=DAY)
    assert predicted['2317']['ensemble_v2']['forecast_pct'] == pytest.approx(.08)
    assert predicted['2317']['ensemble_v2']['validation']['decision'] == 'FAIL'
    assert predicted['2317']['active8_action_authority']['buy_authorized'] is False
    assert inputs == saved
    receipt = seal((db, bucket, manifest, inputs, selection))
    plans = l3.collect_ensemble_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    assert len(plans['plans']) == 2
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])
    # Candidate existence is not permission for either legacy serving entrance.
    with pytest.raises(RuntimeError, match='artifact_contract_invalid'):
        ensemble.validate_active8_ensemble_payload(artifact)
    with pytest.raises(ValueError, match='not_promotion_grade'):
        _validated_active8_ensemble_payload(before)


@pytest.mark.parametrize('fault', ['checksum', 'decision_mismatch', 'unknown_failure', 'empty_coefficients', 'negative_quantile'])
def test_offline_diagnostic_admission_does_not_bypass_executable_integrity(fault):
    from test_active8_ensemble_repository import D1
    artifact, bucket, db = diagnostic_failure(), Bucket(), D1()
    if fault == 'decision_mismatch':
        artifact['validation']['decision'] = 'PASS'
    elif fault == 'unknown_failure':
        artifact['validation']['failed_gates'] = ['unknown_data_integrity_error']
    elif fault == 'empty_coefficients':
        artifact['fit']['coefficients'] = []
    elif fault == 'negative_quantile':
        artifact['calibration']['absolute_residual_quantiles']['0.9'] = -.1
    if fault != 'checksum':
        artifact['payload_checksum'] = digest({k: v for k, v in artifact.items() if k != 'payload_checksum'})
    else:
        artifact['payload_checksum'] = '0' * 64
    with pytest.raises((ValueError, RuntimeError), match='contract|calibration|checksum|identity'):
        persist_active8_ensemble_candidate(artifact, training_run_id='run', bucket=bucket, d1_client=db)
    assert bucket.blobs == {} and db.row is None


def test_original_full_fit_materializer_retains_failed_diagnostic_and_candidate_receipt(prepared, monkeypatch):
    from pathlib import Path
    from routers import walk_forward as router
    from services import active8_ensemble_repository as repository, model_artifact_registry as models
    from services import active8_oof_cohort_materializer as materializer
    from test_active8_ensemble_artifact import _rows, _base_artifacts
    db, _, _, _, _ = prepared
    migration = Path(__file__).resolve().parents[2] / 'worker/domain-migrations/learning/0032_active8_ensemble_validation_attempts.sql'
    db.conn.executescript(migration.read_text(encoding='utf-8'))
    bucket, sources, registered_bases = Bucket(), [], []
    for name, identity in _base_artifacts().items():
        metadata = {'target_semantic_version': models.ACTIVE8_TARGET_SEMANTIC_VERSION,
            'feature_semantic_version': router.OOF_FEATURE_SEMANTIC_VERSION,
            'feature_imputation_semantic': router.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION}
        sources.append({**identity, 'model_name': name, 'training_run_id': 'synthetic-full-fit',
            'state': 'offline_failed', 'artifact_path': name + '/fixed.bin', 'metadata_path': name + '/fixed.json',
            'offline_evidence_json': json.dumps({'registration': {'metadata': metadata,
                'oof_promotion_evidence': {'schema_version': 'model-cpcv-evidence-v1',
                    'method': 'outer_purged_walk_forward_rank_ic', 'decision': 'FAIL', 'passed': False, 'folds': 5}}})})
    manifest = {'schema_version': 'active8-oof-cohort-manifest-v5', 'cohort_id': 'synthetic-candidate-failure',
        'manifest_checksum': 'a' * 64, 'target_semantic_version': models.ACTIVE8_TARGET_SEMANTIC_VERSION,
        'prep_manifest': {'feature_semantic_version': router.OOF_FEATURE_SEMANTIC_VERSION,
            'feature_imputation_semantic': router.OOF_FEATURE_IMPUTATION_SEMANTIC_VERSION,
            'producer_source_sha': 'c' * 40},
        'windows': [{'window_id': str(i), 'train_range': ['2025-01-01', f'2026-01-{i+1:02}'],
            'test_range': [f'2026-02-{i*2+1:02}', f'2026-02-{i*2+2:02}']} for i in range(5)]}
    # Only I/O is isolated: the original stacker, builder, archive and SQL run.
    monkeypatch.setattr(materializer, 'load_oof_prediction_rows', lambda *a, **kw: _rows(reverse_late=True))
    monkeypatch.setattr(models, 'upsert_artifact_record', lambda row: registered_bases.append(deepcopy(row)))
    from functools import partial
    from types import SimpleNamespace
    client = SimpleNamespace(query=db.query, execute=lambda sql, params: db.writer([(sql, params)]))
    for name in ('persist_active8_ensemble_candidate', 'persist_active8_ensemble_validation_attempt'):
        monkeypatch.setattr(repository, name, partial(getattr(repository, name), d1_client=client))
    def materialize():
        return router._materialize_completed_oof_release_aliases(manifest=manifest, registry_rows=sources,
            expected_run_id='synthetic-full-fit', knowledge_cutoff_date='2026-03-31', lifecycle_cadence='monthly',
            release_models=list(_base_artifacts()), bucket=bucket)
    first = materialize()
    assert first['status'] == 'materialized' and first['completion_scope'] == 'candidate_registration'
    assert first['production_effect'] is False and first['validation']['decision'] == 'FAIL'
    assert len(registered_bases) == 8 and set(first['individual_oof_decisions'].values()) == {'FAIL'}
    assert first['validation_attempt']['status'] == 'persisted'
    assert router._oof_release_registry_matches_active_policy(first) is True
    assert router._oof_release_registry_is_terminal_validation_blocked(first) is False
    artifact_id = first['ensemble_candidate']['artifact_id']
    before = db.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [artifact_id])[0]
    assert materialize() == first
    assert db.query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [artifact_id])[0] == before
    assert len(db.query('SELECT * FROM active8_ensemble_validation_attempts_v1', [])) == 1
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])


def test_failed_candidate_is_in_original_daily_dispatch_and_keeps_own_allocation(prepared):
    import graphs.daily_pipeline_v2 as graph
    from services import paired_nav_l3_dispatch as dispatch
    from services.active8_ensemble_repository import _exact_artifact_row
    from test_paired_nav_l3_dispatch import setup_dispatch, attach_outputs
    db, bucket, manifest, inputs, _ = prepared
    state = setup_dispatch(prepared)
    artifact = diagnostic_failure()
    row = _exact_artifact_row(artifact, training_run_id='failed-fixture', archive_uri='gs://fixture/failed.json')
    row.update(created_at='2026-09-06 04:00:00', updated_at='2026-09-06 04:00:00')
    db.conn.execute('INSERT INTO active8_ensemble_artifacts_v1(' + ','.join(row) + ') VALUES('
        + ','.join('?' for _ in row) + ')', list(row.values()))
    state['paired_nav_l3_dispatch'] = dispatch.prepare_candidate_requests(signal_date=DAY, decision_cutoff=CUTOFF,
        sequence_series=[{'symbol': s, 'prices': [100, 101, 102, 103]} for s in inputs['predictions']],
        query=db.query, project=graph._pipeline_modal_active8_shadow_projection, subsets=graph._sequence_model_subsets)
    assert len(state['paired_nav_l3_dispatch']['candidates']) == 3
    assert len(state['paired_nav_l3_dispatch']['requests']) == 2  # Same exact base bundle infers only once.
    attach_outputs(state, inputs)
    selection = dispatch.capture_candidate_selection(state=state, predictions=inputs['predictions'])
    receipt = seal((db, bucket, manifest, inputs, selection))
    plans = l3.collect_ensemble_allocations(snapshot_id=receipt['snapshot_id'], query=db.query, writer=db.writer)
    assert len(plans['plans']) == 3 and len({p['pair_id'] for p in plans['plans']}) == 3
    assert not db.query('SELECT * FROM active8_ensemble_pointer_v1', [])
