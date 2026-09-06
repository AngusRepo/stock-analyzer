import copy
import json
from types import SimpleNamespace

import pytest

from services.active8_full_fit_reuse import find_prior_full_fit_receipt, full_fit_input_identity

MANIFEST = {'cohort_id': 'cohort-a', 'manifest_checksum': 'a' * 64}
PLAN = {'release_models': ['DLinear'], 'promotion_eligible_models': ['DLinear'], 'feature_consensus': {}}
PATH = 'walk_forward/oof_cohorts/cohort-a/full_fit/2026-09-06.json'


def receipt(**updates):
    return {'cohort_id': 'cohort-a', 'knowledge_cutoff_date': '2026-09-06',
            'run_id': 'original-run', 'status': 'blocked', 'retry_required': False,
            'release_models': ['DLinear'], 'promotion_eligible_models': ['DLinear'],
            'reason': 'active8_ensemble_validation_failed',
            'release_registry': {'cohort_id': 'cohort-a', 'manifest_checksum': 'a' * 64}, **updates}


def resolve(value, *, manifest=MANIFEST, plan=PLAN, cutoff='2026-09-13'):
    bucket = SimpleNamespace(list_blobs=lambda **_: [SimpleNamespace(name=PATH, download_as_text=lambda: json.dumps(value))])
    return find_prior_full_fit_receipt(bucket=bucket, manifest=manifest, plan=plan, cutoff=cutoff)


def test_terminal_failure_reuses_original_owner_across_weekly_dates():
    value = receipt()
    before = copy.deepcopy(value)
    assert resolve(value) == PATH
    assert value == before


def test_inflight_new_identity_reuses_owner_instead_of_starting_another_run():
    assert resolve(receipt(status='dispatched', retry_required=True,
                           input_identity=full_fit_input_identity(MANIFEST, PLAN))) == PATH


def test_changed_manifest_or_feature_selection_does_not_reuse():
    assert resolve(receipt(), manifest={**MANIFEST, 'manifest_checksum': 'b' * 64}) is None
    assert resolve(receipt(), plan={**PLAN, 'feature_consensus': {'artifact_checksum': 'c' * 64}}) is None


def test_future_or_same_day_receipt_is_not_a_prior_run():
    assert resolve(receipt(), cutoff='2026-09-05') is None
    assert resolve(receipt(), cutoff='2026-09-06') is None


def test_missing_legacy_binding_cannot_be_assumed_same_input():
    assert resolve(receipt(release_registry={})) is None


def test_receipt_path_cannot_lie_about_original_cutoff():
    with pytest.raises(ValueError, match='path_identity'):
        resolve(receipt(knowledge_cutoff_date='2026-09-07'))


@pytest.mark.parametrize('legacy', [False, True])
def test_dispatch_cross_date_returns_original_failure_without_retraining(monkeypatch, legacy):
    import asyncio
    from routers import walk_forward, retrain_trigger
    from services import active8_ensemble_repository

    value = receipt()
    value['release_registry'].update(status='blocked', reason='active8_ensemble_validation_failed',
        retry_required=False, validation={'schema_version':'active8-oof-ensemble-validation-v1',
        'decision':'FAIL', 'failed_gates':['negative_ic'],
        'calibration_purge_policy':'label_known_before_validation_start'},
        validation_attempt={'attempt_id':'original-attempt'})
    current_registry = copy.deepcopy(value['release_registry'])
    if legacy:
        value['release_registry']['validation'].pop('calibration_purge_policy')
    writes = []
    evaluations = []
    class Blob:
        name = PATH
        def __init__(self, path): self.path = path
        def exists(self): return self.path == PATH
        def download_as_text(self): return json.dumps(value)
        def upload_from_string(self, raw, **kwargs):
            assert legacy, 'unchanged terminal receipt rewritten'
            writes.append(json.loads(raw))
    fake_bucket = SimpleNamespace(blob=Blob, list_blobs=lambda **_: [Blob(PATH)])
    plan = {**PLAN, 'status':'ready', 'tree_models':[]}
    monkeypatch.setattr(walk_forward, 'build_oof_full_fit_dispatch_plan', lambda _: plan)
    row = {'model_name':'DLinear', 'candidate_type':'oof_full_fit_release', 'offline_evidence_json':'{}'}
    monkeypatch.setattr(walk_forward.LEARNING_D1_CLIENT, 'query', lambda *args: [row])
    async def reject_fit(*args, **kwargs): pytest.fail('same input launched retrain')
    monkeypatch.setattr(retrain_trigger, 'trigger_universal_retrain', reject_fit)
    monkeypatch.setattr(walk_forward, '_materialize_completed_oof_release_aliases',
                        lambda **kwargs: evaluations.append(kwargs) or current_registry)
    result = asyncio.run(walk_forward.dispatch_oof_full_fit_training(manifest=MANIFEST,
        knowledge_cutoff_date='2026-09-13', bucket=fake_bucket, lifecycle_cadence='weekly'))
    assert result['status'] == 'blocked'
    assert result['reason'] == 'active8_ensemble_validation_failed'
    assert result['knowledge_cutoff_date'] == '2026-09-06'
    assert result['requested_knowledge_cutoff_date'] == '2026-09-13'
    assert result['run_id'] == 'original-run'
    assert result['reused_full_fit_inputs'] is True
    assert len(evaluations) == int(legacy)
    assert len(writes) == int(legacy)
    if legacy:
        assert writes[0]['superseded_evaluations'][0]['release_registry'] == value['release_registry']
