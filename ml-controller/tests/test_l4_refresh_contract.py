"""Exercise native refresh orchestration, causal source admission and replay storage."""
from copy import deepcopy
import json
from types import SimpleNamespace
import pytest
from services.l4_distribution import digest, FEATURE_SCHEMA
from services.l4_distribution_dataset import validate_sequence_oof_lineage, SEQUENCE_RAW_SCORE_SEMANTIC


def source_rows():
    return [{'model_name': name, 'raw_score_semantic_version': SEQUENCE_RAW_SCORE_SEMANTIC,
             'checkpoint_selection': 'fixed_final_epoch_outer_test_monitor_only'}
            for name in ('DLinear', 'PatchTST', 'iTransformer')]


@pytest.mark.parametrize('name', ['DLinear', 'PatchTST', 'iTransformer'])
def test_refresh_rejects_unverified_or_future_open_sequence_scores(name):
    rows = source_rows()
    row = next(r for r in rows if r['model_name'] == name)
    for invalid in (None, 'forecast_over_next_open'):
        row['raw_score_semantic_version'] = invalid
        with pytest.raises(ValueError, match='score_semantic_unverified:' + name):
            validate_sequence_oof_lineage(rows)


def test_refresh_rejects_outer_test_checkpoint_selection_and_missing_models():
    rows = source_rows()
    rows[0]['checkpoint_selection'] = 'best_outer_validation'
    with pytest.raises(ValueError, match='checkpoint_unverified:DLinear'):
        validate_sequence_oof_lineage(rows)
    with pytest.raises(ValueError, match='model_evidence_missing'):
        validate_sequence_oof_lineage(source_rows()[1:])
    assert validate_sequence_oof_lineage(source_rows())['model_rows'] == {
        'DLinear': 1, 'PatchTST': 1, 'iTransformer': 1}


class Bucket:
    def __init__(self):
        self.saved = {}
    def blob(self, key):
        def upload(payload, **kwargs):
            assert kwargs['if_generation_match'] == 0 and key not in self.saved
            self.saved[key] = payload
        return SimpleNamespace(exists=lambda: key in self.saved,
            upload_from_string=upload, download_as_text=lambda: self.saved[key])


def test_refresh_seals_replayable_dataset_before_candidate_identity_and_retries_without_refit(monkeypatch):
    from scripts import l4_distribution_refresh_job as job
    from services import active8_oof_cohort_materializer as materializer
    from services import walk_forward_retrain, d1_domain_client
    bucket = Bucket()
    parent = {'cohort_id': 'test-cohort'}
    identity = {'artifact_id': 'test-parent'}
    monkeypatch.setattr(job, 'load_target_parent', lambda *_: (parent, identity))
    monkeypatch.setattr(d1_domain_client, 'client_proxy_for_domain', lambda *_: object())
    monkeypatch.setattr(walk_forward_retrain, '_get_bucket', lambda: bucket)
    monkeypatch.setattr(materializer, 'load_verified_oof_manifest',
        lambda *args, **kwargs: ({'manifest_checksum': 'a' * 64}, None))
    inputs = source_rows()
    monkeypatch.setattr(materializer, 'load_oof_prediction_rows', lambda *args, **kwargs: inputs)
    rows = [{'date': '2026-08-01', 'features': {'test': 1}}]
    receipt = {'feature_schema': FEATURE_SCHEMA, 'rows_checksum': digest(rows)}
    calls = []
    def build(*args, **kwargs):
        return deepcopy(rows), deepcopy(receipt)
    def refresh(dataset, *, dataset_receipt, **kwargs):
        calls.append(deepcopy(dataset_receipt))
        assert dataset_receipt['sequence_score_lineage']['model_rows']['DLinear'] == 1
        assert dataset_receipt['dataset_path'].endswith(digest(dataset) + '.json')
        candidate = {'training_source': dataset_receipt, 'test_model': True}
        candidate['candidate_id'] = 'l4_distribution:' + digest(candidate)
        return candidate
    monkeypatch.setattr(job, 'build_native_oof_rows', build)
    monkeypatch.setattr(job, 'refresh_candidate', refresh)
    args = dict(as_of='2026-09-14', cadence='weekly', target_l3_artifact_id='test-parent')
    result = job.execute(**args)
    assert result['promoted'] is False
    assert json.loads(bucket.saved[result['dataset_receipt']['dataset_path']]) == rows
    candidate = json.loads(bucket.saved[result['artifact_path']])
    assert candidate['candidate_id'] == 'l4_distribution:' + digest({
        key: value for key, value in candidate.items() if key != 'candidate_id'})
    assert job.execute(**args) == result and len(calls) == 1
    # Another scheduled refresh cannot train from an old sequence artifact.
    inputs[0]['raw_score_semantic_version'] = None
    with pytest.raises(ValueError, match='score_semantic_unverified'):
        job.execute(**{**args, 'as_of': '2026-09-15'})
    assert len(calls) == 1


@pytest.mark.parametrize('fixed', [False, True])
def test_verified_oof_loader_preserves_raw_score_semantics_without_relabeling_history(fixed):
    import hashlib
    import io
    import numpy as np
    from services.active8_oof_cohort_materializer import _load_prediction_artifact, TARGET_SEMANTIC_VERSION
    meta = {'schema_version':'active8-oof-predictions-v1','generation_mode':'purged_oof',
        'cohort_id':'test','fold_id':'w0','model_name':'DLinear','target_semantic_version':TARGET_SEMANTIC_VERSION,
        'artifact_version':'test-fixed' if fixed else 'test-old', 'rows':1,
        'score_semantic':'same-market-same-date-average-tie-percentile-rank-v2'}
    if fixed:
        meta['split_metadata'] = {'score_semantic_version':SEQUENCE_RAW_SCORE_SEMANTIC,
            'checkpoint_selection':'fixed_final_epoch_outer_test_monitor_only'}
    buffer = io.BytesIO()
    np.savez_compressed(buffer, metadata=np.asarray(json.dumps(meta)), raw_scores=[.2], rank_scores=[.5],
        targets=[.03],dates=['2026-08-01'],symbols=['A'],markets=['LISTED'],label_known_dates=['2026-08-08'])
    raw = buffer.getvalue()
    bucket = SimpleNamespace(blob=lambda _: SimpleNamespace(download_as_bytes=lambda:raw))
    loaded = _load_prediction_artifact(bucket=bucket, path='test.npz',
        expected_checksum=hashlib.sha256(raw).hexdigest(), expected_artifact_cohort='test',
        materialized_cohort='test', expected_artifact_fold='w0', materialized_fold='w0',
        expected_model='DLinear', split={})[0]
    assert loaded['raw_score'] == .2
    assert loaded['raw_score_semantic_version'] == (SEQUENCE_RAW_SCORE_SEMANTIC if fixed else None)
    assert loaded['checkpoint_selection'] == ('fixed_final_epoch_outer_test_monitor_only' if fixed else None)


def test_worker_and_controller_share_feature_version_and_all_required_proofs():
    import re
    from pathlib import Path
    from services.l4_distribution_lifecycle import ACCEPTANCE_CHECKS
    worker = (Path(__file__).resolve().parents[2]/'worker/src/lib/l4ReleaseEvidence.ts').read_text(encoding='utf-8')
    assert f"L4_FEATURE_SCHEMA = '{FEATURE_SCHEMA}'" in worker
    declaration = worker.split('export const L4_ACCEPTANCE_CHECKS = [',1)[1].split('] as const',1)[0]
    assert tuple(re.findall(r"'([^']+)'", declaration)) == ACCEPTANCE_CHECKS
