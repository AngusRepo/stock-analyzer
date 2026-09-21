from copy import deepcopy
import pytest
from app.alpha_model_roster import LEGACY_MODELS,TIMEXER_MODELS
from app.prediction_runtime import _require_model_pool_contract,ModelPoolContractError
from app.batch_prediction import _model_pool_status

def pool(order):
    return {'models':{n:{'status':'active'} for n in order},
            'l2_feature_sidecars':{'TimesFM':{'status':'challenger'}}}

@pytest.mark.parametrize('order',[LEGACY_MODELS,TIMEXER_MODELS])
def test_exact_eight_model_pool_reaches_native_feature_status_resolution(order):
    p=pool(order);before=deepcopy(p)
    _require_model_pool_contract(p)
    assert tuple(_model_pool_status(p))==order
    assert p==before

@pytest.mark.parametrize('order',[LEGACY_MODELS,TIMEXER_MODELS])
def test_missing_core_or_sequence_is_still_rejected(order):
    for name in order:
        p=pool(order);del p['models'][name]
        with pytest.raises(ModelPoolContractError,match='missing model_pool.models entries'):
            _model_pool_status(p)

def test_both_replacement_models_are_rejected_even_when_one_retired():
    p=pool(TIMEXER_MODELS);p['models']['DLinear']={'status':'retired'}
    with pytest.raises(ModelPoolContractError,match='mixed_replacement'):
        _model_pool_status(p)

def test_timexer_health_and_status_are_not_bypassed():
    p=pool(TIMEXER_MODELS);p['models']['TimeXer']['serving_eligible']=False
    assert _model_pool_status(p)['TimeXer']=='challenger'
    p['models']['TimeXer']['status']='bogus'
    with pytest.raises(ModelPoolContractError,match='invalid model_pool lifecycle status'):
        _model_pool_status(p)


def test_short_history_preserves_native_batch_evidence_without_fabricating_scores():
    from types import SimpleNamespace
    from app import prediction_runtime as runtime
    scores={'XGBoost':0.2,'LightGBM':0.3,'ExtraTrees':0.4,'TabM':0.5}
    req=SimpleNamespace(prices=[{'close':100.0}]*5,stock_id=1,symbol='SHORT',runtime_options={
        runtime._BATCH_FEATURE_RANK_SCORES_KEY:scores,
        runtime._BATCH_MODEL_POOL_KEY:pool(TIMEXER_MODELS),
        runtime._BATCH_FEATURE_CONTEXT_KEY:{'feature_names':['f']},
    })
    result=runtime.predict_stock_v2(req)
    assert result['rank_scores']==scores and result['signal']=='HOLD'
    assert result['production_effect'] is False
    del req.runtime_options[runtime._BATCH_FEATURE_RANK_SCORES_KEY]
    with pytest.raises(ValueError,match='controller_batch_evidence_required'):
        runtime.predict_stock_v2(req)
    req.prices=[]
    with pytest.raises(ValueError,match='current_price_missing'):
        runtime.predict_stock_v2(req)
