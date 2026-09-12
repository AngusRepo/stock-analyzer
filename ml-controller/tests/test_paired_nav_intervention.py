from copy import deepcopy

import pytest

from services.paired_nav_intervention import active_intervention, run_isolated_allocation
from services.paired_nav_collection import allocation_projection
from services import recommendation_service as service
from test_allocator_direction_authority import _formal_l4_row, _validated_l4_prior


def inputs(controller='SparseTangent'):
    return dict(recommendations=[_formal_l4_row('2330'), _formal_l4_row('2317')],
                ranking_config={'enabled': True, 'promoteMinMlEdge': 0},
                ensemble_v2_cfg={}, regime_label='bull', regime_surface={},
                alpha_policy={'allocation': {'controller': controller, 'method': 'sparse_tangent_inverse_risk',
                                             'opb_arm_prior': _validated_l4_prior()}},
                return_history={'2330': [.01, -.01, .02, 0, -.02] * 10,
                                '2317': [.02, .01, -.01, 0, -.02] * 10}, opb_reward_ledger=[])


@pytest.fixture(autouse=True)
def reject_observer_io(monkeypatch):
    def forbidden(*a, **k):
        pytest.fail('isolated allocation must not read current paper/model observer data')
    for name in ('load_inherited_paper_weights', 'build_portfolio_ml_shadow_inputs', 'build_rfs_implementable_frontier_shadow'):
        monkeypatch.setattr(service, name, forbidden)


@pytest.mark.parametrize('controller', ['SparseTangent', 'OnlinePortfolioBandit'])
def test_identical_ev_uses_same_real_allocator_and_keeps_input_and_context(controller):
    original = inputs(controller)
    before = deepcopy(original)
    incumbent = run_isolated_allocation(inputs=original, inherited_state={})
    candidate = run_isolated_allocation(inputs=original, inherited_state={}, owner='l4_alpha_ev',
        candidate_checksum='c' * 64, forecasts={'2330': .05, '2317': .05})
    assert candidate['output'] == incumbent['output']
    assert candidate['capture']['effective_weights'] == incumbent['capture']['effective_weights']
    assert candidate['capture']['allocation_contract']['controller_effective'] == incumbent['capture']['allocation_contract']['controller_effective']
    assert original == before
    assert active_intervention() is None
    assert candidate['production_effect'] is False
    assert candidate['can_write_order'] is False
    assert candidate['nav_maturity_credit'] == 0
    assert candidate['execution_parity_decision'] == 'NOT_EVALUATED'


def test_ev_intervention_changes_real_weights_without_faking_approval():
    original = inputs()
    incumbent = run_isolated_allocation(inputs=original, inherited_state={})
    candidate = run_isolated_allocation(inputs=original, inherited_state={}, owner='l4_alpha_ev',
        candidate_checksum='c' * 64, forecasts={'2330': -.05, '2317': .1})
    assert '2330' not in candidate['capture']['effective_weights']
    assert candidate['capture']['effective_weights'] != incumbent['capture']['effective_weights']
    assert active_intervention() is None
    # The very next invocation has no residual override and reproduces baseline.
    assert run_isolated_allocation(inputs=original, inherited_state={})['output'] == incumbent['output']


def test_solver_failure_cannot_leak_override_to_formal_request(monkeypatch):
    def failure(**kw):
        assert active_intervention() is not None
        raise RuntimeError('solver_error')
    monkeypatch.setattr(service, 'apply_sparse_tangent_allocation', failure)
    with pytest.raises(RuntimeError, match='solver_error'):
        run_isolated_allocation(inputs=inputs(), inherited_state={}, owner='l4_alpha_ev',
            candidate_checksum='c' * 64, forecasts={'2330': .01, '2317': .01})
    assert active_intervention() is None


@pytest.mark.parametrize('forecasts', [{'2330': .01}, {'2330': None, '2317': .01}, {'2330': float('nan'), '2317': .01}])
def test_incomplete_or_nonfinite_counterfactual_cannot_silently_use_incumbent(forecasts):
    with pytest.raises(ValueError):
        run_isolated_allocation(inputs=inputs(), inherited_state={}, owner='l4_alpha_ev',
            candidate_checksum='c' * 64, forecasts=forecasts)
    assert active_intervention() is None
