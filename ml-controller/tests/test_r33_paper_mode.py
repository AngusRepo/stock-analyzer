"""R33 Paper mode and tag (R33-NEW-06). Synthetic fixtures only."""
from copy import deepcopy

import pytest

from services.paper_strategy_mode import MLP_MODE, R33_MODE, refresh_family, validate_model_mode
from services.strategy_ab import FEE_TERMS, R33_RECIPE, R33_SCHEMA, TABPACK_SCHEMA, validate_tag
from test_r33_l4_equal7 import _bundle


def _policy():
    from services.l4_distribution_runtime import distribution_policy_identity
    from test_r33_l4_equal7 import IDENTITY
    policy = {'scope': 'paper', 'artifact': _bundle(), 'operating_mode': R33_MODE, 'strategy_role': 'B',
              'constraints': {'exposure_cap': .9}, 'opb': {'enabled': True}}
    policy['opb']['approved_policy_identity'] = distribution_policy_identity(policy, IDENTITY)
    return policy


# --- R33-NEW-06: mode -------------------------------------------------------------------------

def test_r33_mode_requires_the_equal7_bundle_and_is_required_by_it():
    validate_model_mode(_policy())
    with pytest.raises(ValueError, match='paper_r33_mode_required'):
        validate_model_mode({**_policy(), 'operating_mode': MLP_MODE})
    other = _policy()
    other['artifact'] = {'model': {'residual_mlp': {'schema_version': 'x'}}}
    with pytest.raises(ValueError, match='paper_r33_equal7_required'):
        validate_model_mode(other)


def test_r33_has_no_l4_refresh_family_even_with_an_override():
    for policy in ({'operating_mode': R33_MODE}, {'operating_mode': R33_MODE, 'candidate_model_family': 'tabpack'}):
        with pytest.raises(ValueError, match='paper_r33_has_no_l4_refresh_family'):
            refresh_family({'l4Distribution': policy})
    assert refresh_family({'l4Distribution': {'operating_mode': MLP_MODE}}) == 'full_mlp_median'


def test_r33_tag_is_role_b_with_its_own_recipe():
    tag = {'schema_version': R33_SCHEMA, 'role': 'B', 'recipe': R33_RECIPE, 'experiment_id': 'e' * 64,
           'fee_terms': deepcopy(FEE_TERMS)}
    assert validate_tag(tag) == tag
    for change in ({'role': 'A'}, {'recipe': 'exo137_timexer_three_head_scalar_ev_tabpack'},
                   {'timexer_variant': 'exo131'}, {'baseline_primary': {'role': 'A'}},
                   {'schema_version': TABPACK_SCHEMA}):
        with pytest.raises(ValueError):
            validate_tag({**tag, **change})


# --- admission coupling and the tag binder ---------------------------------------------------

def _admission(monkeypatch, *, artifact=None, mode=R33_MODE, tag_schema=R33_SCHEMA):
    from services import paired_nav_strategy_bundle
    from services.active8_paper_admission import SCHEMA
    from services.paired_nav_journal import digest
    from test_r33_l4_equal7 import IDENTITY, _ensemble
    monkeypatch.setattr(paired_nav_strategy_bundle, 'validate_strategy_bundle', lambda bundle, **kw: bundle)
    policy = {**_policy(), 'operating_mode': mode}
    recipe = R33_RECIPE if tag_schema == R33_SCHEMA else 'exo137_timexer_three_head_full_mlp_median_e0'
    trading = {'fees': {'commission': .001425}, 'l4Distribution': policy}
    admission = {'schema_version': SCHEMA, 'scope': 'paper', 'approved': True, 'efficacy_status': 'unproven',
                 'nav_gate_role': 'performance_review_after_paper_admission', 'source_reference': 'SYNTHETIC',
                 'approved_at': '2026-11-08T12:00:00Z', 'business_date': '2026-11-10',
                 'strategy_bundle': {'candidate_l3_identity': IDENTITY, 'candidate_trading_config': trading,
                                     'strategy_ab': {'schema_version': tag_schema, 'role': 'B', 'recipe': recipe,
                                                     'experiment_id': 'e' * 64, 'fee_terms': deepcopy(FEE_TERMS)}},
                 'configuration': {'trading_config': deepcopy(trading), 'risk_config': {'position': {}},
                                   'allocator_source_identity': {'a.py': 'a' * 64},
                                   'l3_inference_source_identity': {'b.py': 'b' * 64},
                                   'native_execution_policy': {'schema_version': 'paired-nav-execution-policy-v1',
                                                               'variables': {'LIVE_EXECUTION_CLIENT_ENABLED': '0'}}}}
    admission['admission_checksum'] = digest(admission)
    return admission, artifact or _ensemble()


def test_r33_admission_requires_object_mode_and_tag_together(monkeypatch):
    from datetime import datetime, timezone
    from services.active8_paper_admission import validate_admission
    now = datetime(2026, 11, 10, 1, tzinfo=timezone.utc)
    admission, ensemble = _admission(monkeypatch)
    assert validate_admission(admission, artifact=ensemble, now=now) == admission
    tabpack_tagged, _ = _admission(monkeypatch, tag_schema='strategy-b-exo-full-mlp-median-paper-v1')
    with pytest.raises(ValueError, match='active8_paper_r33_identity_mismatch'):
        validate_admission(tabpack_tagged, artifact=ensemble, now=now)
    mlp_mode, _ = _admission(monkeypatch, mode='single_b_full_mlp_median_v1')
    with pytest.raises(ValueError):                    # an R33 bundle under another mode never validates
        validate_admission(mlp_mode, artifact=ensemble, now=now)
    legacy = {**ensemble, 'kind': 'active8'}           # same identity fields, not the R33 object
    with pytest.raises(ValueError, match='active8_paper_r33_identity_mismatch'):
        validate_admission(admission, artifact=legacy, now=now)


def test_bind_r33_tags_only_the_matching_r33_bundle(monkeypatch):
    from services import paired_nav_strategy_bundle
    from services.paired_nav_journal import digest
    from services.strategy_ab import bind_r33
    from test_r33_l4_equal7 import IDENTITY, _ensemble
    monkeypatch.setattr(paired_nav_strategy_bundle, 'validate_strategy_bundle', lambda bundle, **kw: bundle)
    bundle = {'declared_signal_date': '2026-11-10', 'candidate_l3_identity': IDENTITY,
              'candidate_trading_config': {'l4Distribution': _policy()}}
    tagged = bind_r33(bundle, experiment_id='e' * 64, ensemble=_ensemble())
    assert tagged['strategy_ab']['schema_version'] == R33_SCHEMA and tagged['strategy_ab']['role'] == 'B'
    assert tagged['bundle_checksum'] == digest({k: v for k, v in tagged.items() if k != 'bundle_checksum'})
    with pytest.raises(ValueError, match='strategy_ab_l3_identity_mismatch'):
        bind_r33({**bundle, 'candidate_l3_identity': {**IDENTITY, 'payload_checksum': '0' * 64}},
                 experiment_id='e' * 64, ensemble=_ensemble())
    non_r33 = deepcopy(bundle)
    non_r33['candidate_trading_config']['l4Distribution']['artifact'] = {'model': {'schema_version': 'x'}}
    with pytest.raises(ValueError, match='strategy_ab_l4_recipe_mismatch'):
        bind_r33(non_r33, experiment_id='e' * 64, ensemble=_ensemble())
    with pytest.raises(ValueError, match='strategy_ab_identity_invalid'):
        bind_r33(bundle, experiment_id='short', ensemble=_ensemble())
