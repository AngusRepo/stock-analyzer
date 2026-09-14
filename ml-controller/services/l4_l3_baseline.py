"""Native L3 mean/probability evidence. Never infers returns from ranks."""
from services.l4_distribution import digest, finite

SCHEMA = 'l4-native-l3-baseline-v1'
NET_LABEL_SCHEMA = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'
CANONICAL_LABEL_COST = .0018


def validate_baseline(packet):
    if (not isinstance(packet, dict) or packet.get('schema_version') != SCHEMA
            or packet.get('target_semantic_version') != NET_LABEL_SCHEMA
            or packet.get('horizon_sessions') != 5
            or packet.get('probability_event') != 'net_return_gt_zero'
            or packet.get('source') != 'active8_ensemble_expected_net_return'
            or packet.get('canonical_label_cost') != CANONICAL_LABEL_COST):
        raise ValueError('l4_l3_baseline_semantic_mismatch')
    net = finite(packet.get('expected_return_net'), 'l3_mean_net')
    gross = finite(packet.get('expected_return_gross'), 'l3_mean_gross')
    probability = finite(packet.get('probability_positive_net_return'), 'l3_probability')
    if abs(gross - net - CANONICAL_LABEL_COST) > 1e-12 or not 0 <= probability <= 1:
        raise ValueError('l4_l3_baseline_value_mismatch')
    for key in ('artifact_id', 'artifact_checksum', 'cohort_id', 'base_artifact_set_checksum'):
        if not isinstance(packet.get(key), str) or not packet[key]:
            raise ValueError('l4_l3_baseline_lineage_missing:' + key)
    if packet.get('checksum') != digest({k:v for k,v in packet.items() if k != 'checksum'}):
        raise ValueError('l4_l3_baseline_checksum_mismatch')
    return packet


def native_baseline(prediction, identity=None):
    ensemble = prediction.get('ensemble_v2') or {}
    if (ensemble.get('target_semantic_version') != NET_LABEL_SCHEMA
            or ensemble.get('forecast_horizon_bars') != 5
            or ensemble.get('forecast_return_5bar_source') != 'active8_ensemble_expected_net_return'
            or ensemble.get('forecast_return_5bar_owner') != 'active8_ensemble_artifact'
            or ensemble.get('lineage_status') != 'complete'):
        raise ValueError('l4_l3_baseline_semantic_mismatch')
    net = finite(ensemble.get('ml_expected_net_return'), 'l3_mean_net')
    if abs(net - finite(ensemble.get('forecast_return_5bar'), 'l3_mean_alias')) > 1e-12:
        raise ValueError('l4_l3_baseline_alias_mismatch')
    if identity is not None:
        for source, key in (('artifact_id','artifact_id'), ('artifact_checksum','payload_checksum'),
                            ('cohort_id','cohort_id'), ('base_artifact_set_checksum','base_artifact_set_checksum')):
            if ensemble.get(source) != identity.get(key):
                raise ValueError('l4_l3_baseline_identity_mismatch')
    packet = {'schema_version':SCHEMA, 'target_semantic_version':NET_LABEL_SCHEMA,
        'horizon_sessions':5, 'expected_return_net':net,
        'expected_return_gross':net + CANONICAL_LABEL_COST,
        'canonical_label_cost':CANONICAL_LABEL_COST,
        'probability_positive_net_return':finite(ensemble.get('probability_positive_net_return'),'l3_probability'),
        'probability_event':'net_return_gt_zero', 'source':'active8_ensemble_expected_net_return',
        **{k:ensemble.get(k) for k in ('artifact_id','artifact_checksum','cohort_id','base_artifact_set_checksum')}}
    packet['checksum'] = digest(packet)
    return validate_baseline(packet)


def attach_baseline(output, packet):
    """Expose erosion without claiming the diagnostic three heads are anchored."""
    validate_baseline(packet)
    return {**output, 'l3_baseline':packet,
        'mean_policy':'independent_three_head',
        'l4_minus_l3_expected_gross':output['expected_return_gross'] - packet['expected_return_gross'],
        'incremental_efficacy':'unproven'}
