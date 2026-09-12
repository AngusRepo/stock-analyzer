"""Exact arithmetic replay invariance, not estimated investment performance."""
from itertools import permutations

from services.expected_return_numeric import evaluate_linear_net


def test_original_linear_model_and_cost_are_invariant_to_json_key_order():
    items=[('ml_edge_norm',.008),('fundamental_quality_norm',.006),('chip_flow_norm',.004),
           ('technical_structure_norm',.004),('ensemble_directional_margin',.012)]
    features=dict(zip([name for name,_ in items],[.2,.3,.4,.5,.1]))
    outputs=[evaluate_linear_net(intercept=.05,coefficients=dict(order),features=features,
        artifact={'output_is_net_of_costs':True,'cost_model_bps':18},clip={}) for order in permutations(items)]
    assert all(value==outputs[0] for value in outputs)
    assert outputs[0][0]==.0582


def test_cancellation_is_accurate_and_cost_is_not_duplicated():
    value,metadata=evaluate_linear_net(intercept=1e16,coefficients={'z':-1e16,'a':1.},
        features={'a':1.,'z':1.},artifact={'output_is_net_of_costs':False,'cost_model_bps':18},clip={})
    assert metadata['raw_linear_prediction']==1.
    assert value==.9982
