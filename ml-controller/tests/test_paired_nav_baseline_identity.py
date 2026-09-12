from copy import deepcopy

import pytest

from services.paired_nav_collection import baseline_model_identity


def fixture():
    ensemble = dict(artifact_id='ensemble-A', cohort_id='cohort-A', payload_checksum='a' * 64,
                    base_artifact_set_checksum='b' * 64)
    return {'active8_ensemble': ensemble, 'active8_action_authority': {
        **{k: ensemble[k] for k in ('artifact_id', 'cohort_id', 'payload_checksum')},
        'buy_authorized': True, 'production_effect': True}}


def test_stable_identity_excludes_daily_observations_not_model_changes():
    manifest = fixture()
    identity = baseline_model_identity(manifest)
    other = deepcopy(manifest)
    other['observed_at'] = 'tomorrow'
    assert baseline_model_identity(other) == identity
    other['active8_ensemble']['base_artifact_set_checksum'] = 'c' * 64
    assert baseline_model_identity(other) != identity


@pytest.mark.parametrize('field', ['artifact_id', 'cohort_id', 'payload_checksum'])
def test_pointer_model_disagreement_cannot_enter_nav(field):
    manifest = fixture()
    manifest['active8_action_authority'][field] = 'wrong'
    with pytest.raises(ValueError, match='identity_missing_or_mismatched'):
        baseline_model_identity(manifest)


def test_missing_or_evidence_only_is_not_a_formal_baseline():
    for manifest in ({}, fixture()):
        manifest.setdefault('active8_action_authority', {})['buy_authorized'] = False
        with pytest.raises(ValueError):
            baseline_model_identity(manifest)
