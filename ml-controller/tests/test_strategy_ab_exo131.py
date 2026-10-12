from copy import deepcopy
import pytest
from services.strategy_ab import bind, validate_tag, TABPACK_SCHEMA, TABPACK_RECIPE, TABPACK_131_RECIPE, FEE_TERMS


def test_explicit_131_identity_cannot_relabel_137_or_other_recipes():
    legacy = dict(schema_version=TABPACK_SCHEMA, role='B', recipe=TABPACK_RECIPE,
                  experiment_id='a'*64, fee_terms=deepcopy(FEE_TERMS))
    assert validate_tag(legacy) == legacy
    current = {**legacy, 'recipe':TABPACK_131_RECIPE, 'timexer_variant':'exo131'}
    assert validate_tag(current) == current
    for change in ({'recipe':TABPACK_RECIPE}, {'timexer_variant':None},
                   {'role':'A'}, {'timexer_variant':'exo137'},
                   {'schema_version':'strategy-b-exo-full-mlp-median-paper-v1'}):
        with pytest.raises(ValueError, match='identity_invalid'):
            validate_tag({**current, **change})


def test_binding_keeps_exact_weight_and_semantic_identity(monkeypatch):
    from services import timexer_contract, paired_nav_strategy_bundle
    from services.alpha_model_roster import TIMEXER_MODELS
    # Isolate tag binding; metadata validation and full bundle checks are covered
    # by their native suites and the actual saved-model publication preflight.
    monkeypatch.setattr(timexer_contract, 'metadata_contract', lambda meta: {'variant':meta['variant']})
    monkeypatch.setattr(paired_nav_strategy_bundle, 'validate_strategy_bundle', lambda bundle, **_:bundle)
    ensemble = dict(model_order=list(TIMEXER_MODELS), payload_checksum='p',
        observation_artifacts={'TimeXer':{'checksum':'a'*64,'version':'v1'}})
    bundle = dict(candidate_l3_identity={'payload_checksum':'p'}, declared_signal_date='2026-10-08',
        candidate_trading_config={'l4Distribution':{'artifact':{'model':{'residual_tabpack':{'present':True}}}}})
    meta = dict(checksum='a'*64,version='v1',variant='exo131')
    result = bind(bundle,role='B',experiment_id='b'*64,ensemble=ensemble,timexer_metadata=meta)
    assert result['strategy_ab']['recipe'] == TABPACK_131_RECIPE
    assert result['strategy_ab']['timexer_variant'] == 'exo131'
    assert 'strategy_ab' not in bundle
    for changed in ({'checksum':'c'*64},{'version':'v2'},{'variant':'price131'}):
        with pytest.raises(ValueError,match='variant_or_identity_mismatch'):
            bind(bundle,role='B',experiment_id='b'*64,ensemble=ensemble,timexer_metadata={**meta,**changed})
