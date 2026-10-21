"""Bind each shadow day to its own frozen full chain and existing native serializer."""
from copy import deepcopy
from datetime import date
from services.l4_challenger_comparison import digest,verify,instant
from services.l4_distribution import validate_bundle
from services.l4_distribution_runtime import native_features
from services.l4_private_execution import frozen_p6_loader, frozen_legacy_loader


def configuration_checksum(trading_config,risk_config):
    config=deepcopy(trading_config)
    policy=config.get('l4Distribution') or {}
    # Model and calibration have independent registry components. Only immutable
    # execution settings belong to allocator_policy; daily account/input data do not.
    config['l4Distribution']={k:v for k,v in policy.items() if k not in ('artifact','runtime','scope')}
    return digest(dict(trading_config=config,risk_config=risk_config))


def validate(packet,entry):
    verify(packet)
    day=packet['signal_date'];session=packet['session_date']
    if (date.fromisoformat(day).isoformat()!=day or date.fromisoformat(session).isoformat()!=session
            or day>=session or not packet.get('source_receipt_shas')
            or any(len(h)!=64 or any(c not in '0123456789abcdef' for c in h) for h in packet['source_receipt_shas'])):
        raise ValueError('shadow_daily_source_invalid')
    opening=instant(packet['next_open'])
    from datetime import timezone,timedelta
    if opening.astimezone(timezone(timedelta(hours=8))).date().isoformat()!=session:
        raise ValueError('shadow_daily_open_date_mismatch')
    if packet['serving_identity']!=entry['serving_identity']:
        raise ValueError('shadow_daily_full_chain_mismatch')
    inputs=packet['l4_allocation_inputs'];policy=inputs['alpha_policy']['l4Distribution']
    bundle=policy['artifact'];runtime=policy['runtime'];l3=runtime['l3_identity']
    if (bundle['model_checksum']!=entry['components']['L4']
            or l3['payload_checksum']!=entry['components']['L3']
            or bundle['l3_identity']!=l3 or runtime['signal_date']!=day
            or packet['trading_config']['l4Distribution']!=policy
            or inputs['recommendations']!=packet['recommendations']
            or inputs.get('r2_shadow') is not None):
        raise ValueError('shadow_daily_model_or_input_mismatch')
    if configuration_checksum(packet['trading_config'],packet['risk_config'])!=entry['components']['allocator_policy']:
        raise ValueError('shadow_daily_execution_policy_changed')
    from services.l4_tabpack_weights import private_weight_reader
    with private_weight_reader(frozen_legacy_loader(inputs,bundle)):
        validate_bundle(bundle,l3_identity=l3,signal_date=day,require_paper_release=False)
    # Check actual native predictions, not just the caller's model label.
    for row in packet['recommendations']:
        native_features(row,runtime['predictions'][row['symbol']],l3)
    frozen_p6_loader(inputs,bundle)
    context=packet.get('execution_context')
    if context is not None:
        from services.paired_native_session import STRATEGY_SESSION_POLICY
        if (context.get('session_policy')!=STRATEGY_SESSION_POLICY
                or set(context)!={'session_policy','variables','source_tables','capture_kv_reads','kv_read_policy'}
                or not isinstance(context['variables'],dict) or not isinstance(context['source_tables'],dict)
                or context['capture_kv_reads'] is not True or not isinstance(context['kv_read_policy'],dict)
                or entry['components'].get('execution_context')!=digest(context)):
            raise ValueError('shadow_execution_context_not_frozen')
    return packet
