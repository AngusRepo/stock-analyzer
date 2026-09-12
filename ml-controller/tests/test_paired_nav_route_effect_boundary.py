"""Do not substitute score-weighted returns for the actual allocator NAV path."""
from copy import deepcopy

from services.paired_nav_intervention import run_isolated_allocation
from test_paired_nav_intervention import inputs


def test_route_diagnostics_alone_do_not_implicitly_reweight_actual_allocator():
    original = inputs()
    alternative = deepcopy(original)
    for index, row in enumerate(original['recommendations']):
        score = 10 if index == 0 else 90
        row['strategy_router_score'] = score
        row['candidate_route_score'] = score
        row['strategy_router_components'] = {'continuous_weight_multiplier': .75 + score / 200}
    for index, row in enumerate(alternative['recommendations']):
        score = 90 if index == 0 else 10
        row['strategy_router_score'] = score
        row['candidate_route_score'] = score
        row['strategy_router_components'] = {'continuous_weight_multiplier': .75 + score / 200}
    baseline = run_isolated_allocation(inputs=original, inherited_state={})
    candidate = run_isolated_allocation(inputs=alternative, inherited_state={})
    assert baseline['capture']['effective_weights']
    assert candidate['capture']['effective_weights'] == baseline['capture']['effective_weights']
    assert candidate['output'] == baseline['output']
    assert baseline['promotion_allowed'] is candidate['promotion_allowed'] is False
    # An arithmetic score-weighted outcome is a DIFFERENT estimator. It can
    # look better even when the actual allocated portfolio is unchanged.
    outcomes = {'2330': .05, '2317': -.03}  # synthetic, never investment evidence
    def diagnostic(rows):
        weights = [r['strategy_router_components']['continuous_weight_multiplier'] for r in rows]
        return sum(outcomes[r['symbol']] * weight for r, weight in zip(rows, weights)) / sum(weights)
    assert abs(diagnostic(original['recommendations']) - .002) < 1e-12
    assert abs(diagnostic(alternative['recommendations']) - .018) < 1e-12
