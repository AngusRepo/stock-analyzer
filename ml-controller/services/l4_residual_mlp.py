"""Exact inference export of the accepted scalar EV challenger, without Torch.

The 34 inputs are the full L3 design plus all four three-head outputs. The
trained network corrects EV only; it does not pretend to recalibrate the heads.
LayerNorm/GELU/residual operations match the research PyTorch eval network.
"""
from __future__ import annotations

import numpy as np
from scipy.special import erf

from services.l4_distribution import design, digest, finite

SCHEMA = 'l4-three-head-residual-mlp-v1'
OUTPUTS = ['p_loss', 'gain', 'loss', 'expected_return_gross']


def _array(state, name, shape):
    value = np.asarray(state.get(name), dtype=np.float32)
    if value.shape != shape or not np.isfinite(value).all():
        raise ValueError('l4_mlp_weight_invalid:' + name)
    return value


def validate(model, *, anchor_model, signal_date=None):
    if (model.get('schema_version') != SCHEMA
            or model.get('inputs') != 34 or model.get('width') != 128
            or model.get('blocks') != 3 or model.get('output') != 'scalar_ev_correction'
            or model.get('anchor_model_checksum') != digest(anchor_model)
            or model.get('payload_checksum') != digest({k:v for k,v in model.items() if k != 'payload_checksum'})):
        raise ValueError('l4_mlp_contract_invalid')
    from datetime import date
    known = date.fromisoformat(model['training_label_known_max'])
    if signal_date is not None and known >= date.fromisoformat(signal_date):
        raise ValueError('l4_mlp_training_after_decision')
    recipe = model['recipe']
    from services.l4_distribution import recipe_order
    recipe_order(recipe['native'])
    if (recipe.get('head_names') != OUTPUTS
            or finite(model.get('residual_scale'), 'mlp_scale') <= 0):
        raise ValueError('l4_mlp_recipe_invalid')
    for name in ('mean', 'scale'):
        value = np.asarray(recipe[name], float)
        if value.shape != (4,) or not np.isfinite(value).all() or (name == 'scale' and (value <= 0).any()):
            raise ValueError('l4_mlp_scaler_invalid')
    shapes = {'input.weight': (128, 34), 'input.bias': (128,),
              'output.weight': (1, 128), 'output.bias': (1,)}
    for block in range(3):
        prefix = f'blocks.{block}.transform.'
        shapes.update({prefix+'0.weight': (128,), prefix+'0.bias': (128,),
                       prefix+'1.weight': (128,128), prefix+'1.bias': (128,),
                       prefix+'4.weight': (128,128), prefix+'4.bias': (128,)})
    if set(model['state']) != set(shapes):
        raise ValueError('l4_mlp_state_fields_invalid')
    for name, shape in shapes.items():
        _array(model['state'], name, shape)


def apply(rows, outputs, model, *, anchor_model):
    validate(model, anchor_model=anchor_model)
    native, _ = design(rows, model['recipe']['native'])
    raw = np.asarray([[row[key] for key in OUTPUTS] for row in outputs], float)
    recipe = model['recipe']
    x = np.asarray(np.column_stack([native, (raw-np.asarray(recipe['mean']))/np.asarray(recipe['scale'])]), np.float32)
    state = {key: np.asarray(value, np.float32) for key,value in model['state'].items()}
    def linear(value, prefix):
        return value @ state[prefix+'.weight'].T + state[prefix+'.bias']
    def gelu(value):
        return value * np.float32(.5) * (np.float32(1) + erf(value / np.float32(np.sqrt(2))))
    x = gelu(linear(x, 'input'))
    for block in range(3):
        prefix = f'blocks.{block}.transform.'
        centered = x-x.mean(axis=-1, keepdims=True)
        normalized = centered / np.sqrt((centered*centered).mean(axis=-1, keepdims=True)+np.float32(1e-5))
        normalized = normalized*state[prefix+'0.weight']+state[prefix+'0.bias']
        x = x + linear(gelu(linear(normalized, prefix+'1')), prefix+'4')
    correction = linear(x, 'output').reshape(-1)*np.float32(model['residual_scale'])
    expected = np.asarray(raw[:,3], np.float32) + correction
    if not np.isfinite(expected).all():
        raise ValueError('l4_mlp_nonfinite_prediction')
    return [{**row, 'three_head_expected_return_gross': row['expected_return_gross'],
             'expected_return_gross': float(expected[index]),
             'residual_ev_correction': float(correction[index]),
             'calibration_model': SCHEMA, 'calibration_checksum': model['payload_checksum']}
            for index,row in enumerate(outputs)]
