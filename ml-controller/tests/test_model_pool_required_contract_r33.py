import pytest

from graphs import daily_pipeline_v2 as graph
from services.alpha_model_roster import LEGACY_MODELS, R33_MODELS, TIMEXER_MODELS


def pool(order):
    return {'models': {name: {'status': 'active', 'version': 'v1'} for name in order},
            'l2_feature_sidecars': {'TimesFM': {'status': 'active', 'version': 'v1'}}}


@pytest.mark.parametrize('order', [LEGACY_MODELS, TIMEXER_MODELS, R33_MODELS])
def test_published_roster_pool_passes_the_serving_contract(order, monkeypatch):
    # 11/19 cutover: the core4 R33 pool failed here as "missing XGBoost, DLinear, PatchTST, iTransformer".
    monkeypatch.setattr('services.model_serving_resolver.resolve_serving_pool', lambda **_: pool(order))
    status, _ = graph._load_active8_serving_pool()
    assert tuple(name for name in status if name != 'TimesFM') == order
    versions = graph._load_model_pool_versions()
    assert set(versions[0]) == {*order, 'TimesFM'}


@pytest.mark.parametrize('order', [LEGACY_MODELS, TIMEXER_MODELS, R33_MODELS])
def test_pool_missing_a_roster_model_is_still_rejected(order):
    for name in order:
        p = pool(order)
        del p['models'][name]
        with pytest.raises(RuntimeError, match='missing required model entries'):
            graph._require_model_pool_required_contract(p, 'test')


def test_r33_pool_with_an_invalid_status_is_rejected():
    p = pool(R33_MODELS)
    p['models']['TabM']['status'] = 'bogus'
    with pytest.raises(RuntimeError, match='invalid lifecycle status: TabM=bogus'):
        graph._require_model_pool_required_contract(p, 'test')
