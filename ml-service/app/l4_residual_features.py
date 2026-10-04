"""Causal 30 L3 + four head feature adapter, independent of any trainer."""
import numpy as np
from services import l4_distribution as native

OUTPUTS = ['p_loss', 'gain', 'loss', 'expected_return_gross']


def matrix(rows, outputs, recipe=None):
    x, native_recipe = native.design(rows, None if recipe is None else recipe['native'])
    heads = np.asarray([[p[k] for k in OUTPUTS] for p in outputs],float)
    if recipe is None:
        weights = native.date_weights(rows)[:,None]
        mean = (weights*heads).sum(0)
        scale = np.maximum(np.sqrt((weights*(heads-mean)**2).sum(0)),.001)
        recipe = {'native':native_recipe,'head_names':OUTPUTS,'mean':mean.tolist(),'scale':scale.tolist()}
    values = np.column_stack([x,(heads-np.asarray(recipe['mean']))/np.asarray(recipe['scale'])])
    if not np.isfinite(values).all():
        raise ValueError('l4_mlp_nonfinite_training_matrix')
    return values, recipe
