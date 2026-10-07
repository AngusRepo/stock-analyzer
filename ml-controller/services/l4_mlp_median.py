"""Atomic, immutable residual ensemble: Anchor + lambda * median(seed deltas).

Each member is the complete 34-input residual MLP, including its own fitted
scaler and residual scale. Heads are evaluated once from the shared Anchor.
Missing/corrupt members fail closed; neither two-seed voting nor TabPack is a
fallback. The output remains a five-session gross decimal return.
"""
from __future__ import annotations

import re
import numpy as np

from services.l4_distribution import digest
from services import l4_residual_mlp as single

SCHEMA = 'l4-three-head-residual-mlp-median-v1'
SEEDS = (42, 43, 44)


def validate(model, *, anchor_model, signal_date=None):
    members = model.get('members') or []
    if (model.get('schema_version') != SCHEMA
            or model.get('aggregation') != 'median_residual_per_symbol'
            or model.get('residual_multiplier') not in (0.5, 1.0)
            or isinstance(model.get('residual_multiplier'), bool)
            or model.get('missing_member_policy') != 'fail_closed'
            or model.get('anchor_model_checksum') != digest(anchor_model)
            or model.get('payload_checksum') != digest({k:v for k,v in model.items() if k != 'payload_checksum'})
            or len(members) != len(SEEDS)
            or [m.get('seed') for m in members] != list(SEEDS)):
        raise ValueError('l4_mlp_median_contract_invalid')
    recipes = []
    for member in members:
        value = member.get('model') or {}
        single.validate(value, anchor_model=anchor_model, signal_date=signal_date)
        provenance = member.get('provenance') or {}
        if (provenance.get('seed') != member['seed']
                or any(not re.fullmatch('[a-f0-9]{64}', provenance.get(key, ''))
                       for key in ('checkpoint_sha256', 'training_receipt_sha256', 'partition_sha256'))):
            raise ValueError('l4_mlp_median_member_provenance_invalid')
        recipes.append(value['recipe'])
    if any(recipe != recipes[0] for recipe in recipes[1:]):
        raise ValueError('l4_mlp_median_member_recipe_mismatch')
    if (len({m['provenance']['partition_sha256'] for m in members}) != 1
            or len({m['model']['training_label_known_max'] for m in members}) != 1):
        raise ValueError('l4_mlp_median_member_partition_mismatch')
    if model.get('training_label_known_max') != max(m['model']['training_label_known_max'] for m in members):
        raise ValueError('l4_mlp_median_training_cutoff_invalid')


def apply(rows, outputs, model, *, anchor_model):
    validate(model, anchor_model=anchor_model)
    if len(rows) != len(outputs):
        raise ValueError('l4_mlp_median_pool_mismatch')
    predicted = [single.apply(rows, outputs, member['model'], anchor_model=anchor_model)
                 for member in model['members']]
    deltas = np.asarray([[p['residual_ev_correction'] for p in values]
                         for values in predicted], dtype=np.float32)
    correction = np.median(deltas, axis=0) * np.float32(model['residual_multiplier'])
    anchor = np.asarray([row['expected_return_gross'] for row in outputs], dtype=np.float32)
    expected = anchor + correction
    if not np.isfinite(expected).all():
        raise ValueError('l4_mlp_median_nonfinite_prediction')
    return [{**row, 'three_head_expected_return_gross': row['expected_return_gross'],
             'expected_return_gross': float(expected[i]),
             'residual_ev_correction': float(correction[i]),
             'residual_member_corrections': {str(m['seed']): float(deltas[j, i])
                 for j,m in enumerate(model['members'])},
             'residual_aggregation': model['aggregation'],
             'residual_multiplier': model['residual_multiplier'],
             'calibration_model': SCHEMA, 'calibration_checksum': model['payload_checksum']}
            for i,row in enumerate(outputs)]
