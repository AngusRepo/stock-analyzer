"""Original NAV publication -> selected coverage -> both runtimes; NOT ROI."""
from copy import deepcopy
from pathlib import Path
import sys

import pytest

from services import ensemble_v2 as ensemble
from services.active8_score_semantics import normalize_active8_cross_sectional_scores, MODEL_TARGET_SEMANTIC_VERSION
from services.active8_nav_inference import restore_frozen_nav_inference
from test_nav_l3_frozen_inference import frozen
from test_nav_l3_adoption import ready
from test_paired_nav_l3_candidate import prepared
from test_paired_nav_candidate_collection import environment

SELECTED = ['TabM', 'GNN', 'DLinear', 'PatchTST', 'iTransformer']


@pytest.mark.parametrize('prepared', [{'selected_models': SELECTED}], indirect=True)
def test_original_nav_selected_bundle_normalizes_and_scores_without_excluded_core(frozen):
    original, pool, artifact, manifest, _ = frozen
    grant = restore_frozen_nav_inference(manifest['active8_nav_inference'], artifact=artifact, pool_models=pool['models'])
    predictions = {str(index): {'stock_meta': {'market': 'TWSE'},
        'rank_scores': {'TabM': value, 'GNN': value},
        'dlinear': {'forecast_pct': value}, 'patchtst': {'forecast_pct': value},
        'itransformer': {'forecast_pct': value}} for index, value in enumerate((.2, .5, .8))}
    kwargs = dict(artifact_versions={name: artifact['base_artifacts'][name]['version'] for name in SELECTED},
        artifact_target_semantics={name: MODEL_TARGET_SEMANTIC_VERSION for name in SELECTED},
        run_date='2026-09-22', active8_ensemble=artifact, pool_models=pool['models'], nav_authority=grant)
    # Candidate diagnostics FAIL, but original committed NAV grants inference.
    before = deepcopy(predictions)
    with pytest.raises(RuntimeError):
        normalize_active8_cross_sectional_scores(predictions, **{**kwargs, 'nav_authority': None})
    assert predictions == before
    summary = normalize_active8_cross_sectional_scores(predictions, **kwargs)
    assert summary['complete_symbols'] == 3
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'ml-service'))
    from app.active8_ensemble_runtime import score_active8_ensemble, Active8EnsembleContractError
    for prediction in predictions.values():
        ensemble.attach_ensemble_v2(prediction, artifact, pool['models'], nav_authority=grant)
        formal = prediction['formal_layer3_contract']
        assert formal['required_models'] == ['TabM', 'GNN'] and formal['complete']
        assert ensemble.build_formal_model_input_contract(prediction)['required_models'] == ['TabM', 'GNN']
        result = score_active8_ensemble(rank_scores=prediction['rank_scores'], artifact=artifact,
            pool_models=pool['models'], current_price=100., nav_authority=grant)
        assert result.forecast_pct == pytest.approx(prediction['ensemble_v2']['ml_expected_net_return'])
        assert prediction['ensemble_v2']['adoption_basis'] == 'committed_paired_nav'
        assert prediction['ensemble_v2']['qualifications']['ranking']['decision'] == 'FAIL'
        assert prediction['ensemble_v2']['signal_role'] == 'advisory_only'
        # Original NAV authority survives diagnostics into the actual L4 consumer.
        from services import recommendation_service as reco
        from test_recommendation_provenance import _screener_rec, _payload, _l4_alpha_ev
        scored = deepcopy(prediction)
        scored['ensemble_v2']['l4_alpha_ev'] = _l4_alpha_ev(.03)
        rows, removed = reco.filter_and_score_recommendations(
            [_screener_rec('2330')], {'2330': scored}, [_payload('2330')])
        assert removed == 0 and len(rows) == 1
        rows = reco.apply_core_family_evidence(rows, {'2330': scored},
            require_lifecycle_weights=True, require_complete_active_models=True)
        rows = reco.apply_sparse_tangent_allocation(rows, {'enabled': True},
            alpha_policy={'allocation': {'controller': 'SparseTangent'}})
        assert rows[0]['has_buy_signal'] == 1
        assert rows[0]['alpha_allocation']['expected_return_owner'] == 'l4_alpha_ev'
    # Required selected core still fails; optional nonfinite behaves as missing,
    # never NaN*zero poisoning the numerical result.
    prediction = deepcopy(predictions['2'])
    prediction['rank_scores']['TabM'] = float('nan')
    ensemble.attach_ensemble_v2(prediction, artifact, pool['models'], nav_authority=grant)
    assert prediction['formal_layer3_contract']['complete'] is False
    assert 'ensemble_v2' not in prediction
    with pytest.raises(Active8EnsembleContractError, match='core_score_missing:TabM'):
        score_active8_ensemble(rank_scores=prediction['rank_scores'], artifact=artifact,
            pool_models=pool['models'], current_price=100., nav_authority=grant)
    prediction = deepcopy(predictions['2'])
    prediction['rank_scores']['DLinear'] = float('nan')
    prediction['rank_scores']['LightGBM'] = float('nan')
    ensemble.attach_ensemble_v2(prediction, artifact, pool['models'], nav_authority=grant)
    result = score_active8_ensemble(rank_scores=prediction['rank_scores'], artifact=artifact,
        pool_models=pool['models'], current_price=100., nav_authority=grant)
    assert result.forecast_pct == pytest.approx(prediction['ensemble_v2']['ml_expected_net_return'])
    assert result.evidence['availability']['DLinear'] is False
    assert original[0].batches == 1


@pytest.mark.parametrize('prepared', [{'selected_models': SELECTED}], indirect=True)
def test_shadow_uses_selected_core_but_retains_exact_original_identity(prepared):
    from services.active8_score_semantics import normalize_active8_challenger_scores
    from services import paired_nav_l3_candidate as l3
    _, _, manifest, inputs, selection = prepared
    candidate = selection['candidates'][0]
    predictions = deepcopy(inputs['predictions'])
    candidate_rows = {row['model']: row for row in manifest['active8_shadow_candidates']}
    for prediction in predictions.values():
        prediction['challenger_rank_scores'] = {name: value for name, value in
            prediction['challenger_raw_model_scores'].items() if name in SELECTED}
    normalize_active8_challenger_scores(predictions, candidate_rows=candidate_rows, run_date='2026-09-07')
    result = l3.infer_candidate_predictions(predictions=predictions, candidate=candidate, signal_date='2026-09-07')
    assert len(result) == 3
    assert all(row['ensemble_v2']['production_effect'] is False for row in result.values())
    assert all(not row['active8_action_authority']['buy_authorized'] for row in result.values())
    for row in result.values():
        assert row['ensemble_v2']['formal_model_input_contract']['required_models'] == ['TabM', 'GNN']
    corrupted = deepcopy(predictions)
    corrupted['2330']['challenger_model_score_lineage']['candidate_artifact_ids']['TabM'] = 'other'
    with pytest.raises(ValueError, match='prediction_identity_mismatch'):
        l3.infer_candidate_predictions(predictions=corrupted, candidate=candidate, signal_date='2026-09-07')
    missing = deepcopy(predictions)
    missing['2330']['challenger_rank_scores'].pop('TabM')
    with pytest.raises(ValueError, match='scores_incomplete'):
        l3.infer_candidate_predictions(predictions=missing, candidate=candidate, signal_date='2026-09-07')
