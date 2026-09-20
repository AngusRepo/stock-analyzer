"""The replacement changes model identity, never vote count or column meaning."""
from copy import deepcopy

import numpy as np
import pytest

from services.alpha_model_roster import LEGACY_MODELS, TIMEXER_MODELS, model_order
from services.active8_ensemble_artifact import build_active8_ensemble_artifact
from services.ensemble_v2 import validate_active8_ensemble_candidate, _evaluate_validated_ensemble
from services import l4_distribution as l4
from test_active8_ensemble_artifact import _rows, _base_artifacts
from test_l4_distribution import features, constant_model


def test_eight_model_stacker_renaming_preserves_arithmetic_and_truthful_identity():
    artifacts = _base_artifacts()
    rows = _rows()
    arguments = dict(cohort_id='roster-test', source_manifest_checksum='a' * 64,
                     knowledge_cutoff_date='2026-03-31')
    legacy = build_active8_ensemble_artifact(rows, base_artifacts=artifacts, **arguments)
    # Controlled identical scores isolate wiring from model efficacy.
    for row in rows:
        if row['model_name'] == 'DLinear':
            row['model_name'] = 'TimeXer'
            row['artifact_version'] = row['artifact_version'].replace('DLinear', 'TimeXer')
    artifacts['TimeXer'] = artifacts.pop('DLinear')
    artifacts['TimeXer']['artifact_id'] = 'TimeXer:v-new:oof_full_fit_release'
    replacement = build_active8_ensemble_artifact(rows, base_artifacts=artifacts, **arguments)
    validate_active8_ensemble_candidate(legacy)
    validate_active8_ensemble_candidate(replacement)
    assert replacement['model_order'] == list(TIMEXER_MODELS)
    assert len(replacement['observation_artifacts']) == 8
    assert 'DLinear' not in replacement['validation']['same_window_comparison']['models']
    np.testing.assert_array_equal(legacy['fit']['coefficients'], replacement['fit']['coefficients'])
    for artifact, order in ((legacy, LEGACY_MODELS), (replacement, TIMEXER_MODELS)):
        prediction = {'rank_scores': {name: (index+1)/9 for index, name in enumerate(order)}}
        result = _evaluate_validated_ensemble(prediction, artifact, {'complete': True})
        if artifact is legacy:
            expected = result['forecast_pct']
        else:
            assert result['forecast_pct'] == expected
            assert result['model_order'] == list(TIMEXER_MODELS)
    with pytest.raises(ValueError, match='mixed_replacement'):
        model_order([*TIMEXER_MODELS, 'DLinear'])


def test_l4_recipe_must_match_roster_and_reordered_coefficients():
    row = features(.35)
    original = constant_model()
    original['heads']['gain']['beta'] = (np.arange(30)/10000).tolist()
    replacement = deepcopy(original)
    old_names = original['recipe']['names']
    renamed = [name.replace('DLinear_', 'TimeXer_') for name in old_names]
    new_names = l4.feature_names(TIMEXER_MODELS)
    assert new_names == renamed  # Stable input coordinates for seeded neural fits.
    indices = [renamed.index(name) for name in new_names]
    replacement['recipe']['names'] = new_names
    for head in replacement['heads'].values():
        head['beta'] = [head['beta'][index] for index in indices]
    new_row = {key.replace('DLinear_', 'TimeXer_'): value for key, value in row.items()}
    assert l4.predict([{'features': row}], original) == l4.predict([{'features': new_row}], replacement)
    with pytest.raises(ValueError, match='input_roster_mismatch'):
        l4.predict([{'features': new_row}], original)
    with pytest.raises(ValueError, match='input_roster_mismatch'):
        l4.design([{'features': row, 'date': '2026-09-18'}, {'features': new_row, 'date': '2026-09-18'}])
    with pytest.raises(ValueError, match='mixed_replacement'):
        l4.features({**new_row, 'DLinear_available': 0})


def test_optional_timeXer_gap_preserves_declared_eight_model_contract():
    from services.ensemble_v2 import build_formal_model_input_contract
    from services.alpha_model_roster import TIMEXER_MODELS
    result=build_formal_model_input_contract({'rank_scores':{'LightGBM':.5},'ensemble_v2':{'model_order':list(TIMEXER_MODELS)}})
    assert result['active_models']==list(TIMEXER_MODELS)
    assert 'TimeXer' in result['missing_optional_models'] and 'DLinear' not in result['missing_models']


def test_adaptive_quality_uses_declared_timeXer_without_legacy_double_count():
    from services.adaptive import build_ml_confidence_hook,compute_pf_quality_mults
    from services.alpha_model_roster import TIMEXER_MODELS
    rows=[{'model_name':'TimeXer','accuracy':.8,'total_count':20,'profit_factor':1.2},
          {'model_name':'DLinear','accuracy':.1,'total_count':1000,'profit_factor':.3}]
    result=build_ml_confidence_hook(rows,.5,alpha_model_order=list(TIMEXER_MODELS))
    assert result['model_quality_30d']==.8 and result['sample_count_30d']==20
    assert result['ignored_non_active_models']==['DLinear']
    assert compute_pf_quality_mults(rows,rows,alpha_model_order=list(TIMEXER_MODELS))=={'TimeXer':1.2}


@pytest.mark.parametrize('order', [LEGACY_MODELS, TIMEXER_MODELS])
def test_allocation_attribution_names_follow_exact_model_even_with_empty_modeled_pool(order):
    from services.l4_allocation_contract import full_l3_attribution
    names = l4.feature_names(order)
    packet = full_l3_attribution({}, {}, {}, [], model_feature_names=names)
    assert packet['model_feature_names'] == names
    assert packet['model_feature_count'] == 30
    assert any(name.startswith('TimeXer_') for name in packet['model_feature_names']) == ('TimeXer' in order)
    assert any(name.startswith('DLinear_') for name in packet['model_feature_names']) == ('DLinear' in order)
