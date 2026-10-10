"""Three complete official-core packs; per-symbol median, no missing-seed fallback."""
from copy import deepcopy
import re
import numpy as np
from services.l4_distribution import digest
from services.l4_tabpack_budget_protocol import RECIPE, MEDIAN_RECIPE, SEEDS, N_MODELS
from services import l4_tabpack_weights as weights

SCHEMA = 'l4-three-head-tabpack-core16-median-v1'


def validate(model, *, anchor_model, signal_date=None):
    from services import l4_residual_tabpack as single
    members = model.get('members') or []
    if (model.get('schema_version') != SCHEMA or model.get('training_recipe') != MEDIAN_RECIPE
            or model.get('aggregation') != 'median_residual_per_symbol'
            or model.get('missing_member_policy') != 'fail_closed'
            or model.get('anchor_model_checksum') != digest(anchor_model)
            or model.get('payload_checksum') != digest({k:v for k,v in model.items() if k != 'payload_checksum'})
            or len(members) != 3 or [m.get('seed') for m in members] != list(SEEDS)):
        raise ValueError('tabpack_median_contract_invalid')
    signatures = []
    for member in members:
        value = member.get('model') or {}
        p = value.get('provenance') or {}
        if (value.get('schema_version') != weights.SCHEMA or p.get('seed') != member['seed']
                or p.get('training_recipe') != RECIPE or p.get('n_models') != N_MODELS
                or p.get('selection_rule') != 'official_online_greedy_validation_only'
                or any(not re.fullmatch('[a-f0-9]{64}', str(p.get(k, '')))
                       for k in ('partition_checksum', 'source_rows_checksum'))
                or p.get('checkpoint_sha256') != value.get('weights', {}).get('sha256')
                or any(type(m.get('member_id')) is not int or not 0 <= m['member_id'] < N_MODELS
                       for m in value.get('members', []))):
            raise ValueError('tabpack_median_member_identity_invalid')
        single.validate(value, anchor_model=anchor_model, signal_date=signal_date)
        signatures.append(digest({'recipe':value['recipe'], 'partition':p['partition_checksum'],
            'rows':p['source_rows_checksum'], 'known':value['training_label_known_max'],
            'mean':value['residual_mean'], 'scale':value['residual_scale']}))
    if len(set(signatures)) != 1 or model.get('training_label_known_max') != members[0]['model']['training_label_known_max']:
        raise ValueError('tabpack_median_partition_or_scaler_mismatch')


def ensemble(anchor_model, members):
    result = {'schema_version':SCHEMA, 'training_recipe':MEDIAN_RECIPE,
        'aggregation':'median_residual_per_symbol', 'missing_member_policy':'fail_closed',
        'anchor_model_checksum':digest(anchor_model), 'members':deepcopy(members),
        'training_label_known_max':members[0]['model']['training_label_known_max'] if members else None}
    result['payload_checksum'] = digest(result)
    validate(result, anchor_model=anchor_model)
    return result


def apply(rows, outputs, model, *, anchor_model):
    from services import l4_residual_tabpack as single
    validate(model, anchor_model=anchor_model)
    if len(rows) != len(outputs):
        raise ValueError('tabpack_median_pool_mismatch')
    if not rows:
        return []
    predictions = [single.apply(rows, outputs, m['model'], anchor_model=anchor_model) for m in model['members']]
    deltas = np.asarray([[p['residual_ev_correction'] for p in values] for values in predictions], np.float64)
    correction = np.median(deltas, axis=0)
    expected = np.asarray([p['expected_return_gross'] for p in outputs], np.float64) + correction
    if not np.isfinite(expected).all():
        raise ValueError('tabpack_median_prediction_nonfinite')
    return [{**p, 'three_head_expected_return_gross':p['expected_return_gross'],
        'expected_return_gross':float(expected[i]), 'residual_ev_correction':float(correction[i]),
        'residual_member_corrections':{str(seed):float(deltas[j,i]) for j,seed in enumerate(SEEDS)},
        'residual_aggregation':model['aggregation'], 'calibration_model':SCHEMA,
        'calibration_checksum':model['payload_checksum']} for i,p in enumerate(outputs)]
