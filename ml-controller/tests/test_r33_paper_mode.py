"""R33 Paper mode and tag (R33-NEW-06). Synthetic fixtures only."""
from copy import deepcopy

import pytest

from services.paper_strategy_mode import MLP_MODE, R33_MODE, refresh_family, validate_model_mode
from services.strategy_ab import FEE_TERMS, R33_RECIPE, R33_SCHEMA, TABPACK_SCHEMA, validate_tag
from test_r33_l4_equal7 import _bundle


def _policy():
    return {'scope': 'paper', 'artifact': _bundle(), 'operating_mode': R33_MODE, 'strategy_role': 'B',
            'constraints': {'exposure_cap': .9}, 'opb': {'enabled': True, 'approved_policy_identity': 'n' * 64}}


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
