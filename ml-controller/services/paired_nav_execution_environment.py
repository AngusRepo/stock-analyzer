"""One pre-allocation execution environment; timestamps are evidence, not policy.

Changing executable code or frozen policy starts an explicit comparison segment.
It never rewrites historical accounts or credits their maturity to the successor.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json

from services.paired_nav_journal import _timestamp, digest


def frozen_policy_identity(source):
    """Separate the canonical risk-assess daily state from its governing policy.

    Values still reach BOTH native accounts in full. Only stable experiment
    identity uses this projection. Unknown schemas/fields remain conservative.
    Sources: adaptive.compute_adaptive_params, Worker normalizeAdaptiveParams.
    """
    values = {key: json.loads(raw) if raw is not None else None
              for key, raw in (source or {}).get('frozen_kv', {}).items()}
    adaptive = values.get('ml:adaptive_params')
    provenance = adaptive.get('provenance') if isinstance(adaptive, dict) else None
    if (not isinstance(provenance, dict) or provenance.get('owner') != 'ml-controller'
            or provenance.get('schema_version') != 'adaptive-params-v2'
            or provenance.get('update_frequency') != 'daily_after_verify'
            or provenance.get('source') not in {'ml-controller', 'risk-assess'}
            or provenance.get('fallback') is not False):
        return values
    observed = _timestamp(source['observed_at'])
    for packet, field in ((adaptive, 'computed_at'), (provenance, 'computed_at'), (provenance, 'updated_at')):
        if field == 'updated_at' and field not in packet:
            continue
        if _timestamp(packet[field]) > observed:
            raise ValueError('paired_native_adaptive_observed_before_computed')
    stable = deepcopy(adaptive)
    for field in ('confidence_delta', 'threshold_components', 'position_pct_delta', 'sltp_add',
                  'pf_quality_mult', 'screener', 'bandit_max_mult', 'bandit_force_explore',
                  'computed_at', 'market_risk_score', 'recent_accuracy_30d', 'regime_at_compute',
                  'regime_overrides', 'version', 'confidence_threshold', 'sl_tp_override', 'ml_confidence_hook'):
        stable.pop(field, None)
    for field in ('computed_at', 'updated_at', 'regime', 'regime_as_of_date'):
        stable['provenance'].pop(field, None)
    bandit = stable.get('bandit_context')
    if isinstance(bandit, dict):
        for field in ('losses_5d', 'total_5d', 'loss_rate', 'decision'):
            bandit.pop(field, None)
        # The raw controller response contains a daily effect explanation;
        # Worker persists the independently-owned GA context instead. Preserve
        # GA identity/policy; remove only the calculated before/after annotation.
        effect = (bandit.get('ga_optimizer') or {}).get('applied_effect')
        if isinstance(effect, dict):
            for field in ('bandit_max_mult_before', 'bandit_max_mult_after', 'applied', 'reason'):
                effect.pop(field, None)
    # model_allocator, GA context, meta_layer, threshold constants and unknown
    # fields deliberately remain. A Meta policy change is NOT a daily observation.
    values['ml:adaptive_params'] = stable
    return values


def execution_policy(environment, *, frozen_at=None):
    if (not isinstance(environment, dict)
            or environment.get('schema_version') != 'paired-nav-execution-environment-v1'
            or not isinstance(environment.get('execution_owner_version'), str)
            or not environment['execution_owner_version']
            or type(environment.get('account_id')) is not int or environment['account_id'] <= 0
            or not isinstance(environment.get('kv_read_policy'), dict)):
        raise ValueError('paired_native_execution_environment_invalid')
    source = environment.get('source_context')
    if (not isinstance(source, dict) or source.get('schema_version') != 'native-paper-source-context-v1'
            or not isinstance(source.get('variables'), dict) or not isinstance(source.get('frozen_kv'), dict)):
        raise ValueError('paired_native_execution_environment_source_invalid')
    observed = _timestamp(source['observed_at'])
    if frozen_at is not None and observed > _timestamp(frozen_at):
        raise ValueError('paired_native_execution_environment_after_freeze')
    for flag in ('LIVE_EXECUTION_CLIENT_ENABLED', 'LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'):
        if str(source['variables'].get(flag, '')).lower() in {'1', 'true', 'yes', 'enabled', 'on'}:
            raise ValueError('native_registration_live_submission_enabled')
    return deepcopy({'schema_version': 'paired-nav-execution-policy-v1',
        'execution_owner_version': environment['execution_owner_version'],
        'account_id': environment['account_id'], 'kv_read_policy': environment['kv_read_policy'],
        'variables': source['variables'],
        # Do not reset comparisons for harmless JSON formatting/key-order changes.
        # Missing keys and explicit null values remain distinct as in carry guard.
        'frozen_kv': frozen_policy_identity(source)})


def configuration_environment(saved):
    content = saved['payload']['content']
    if 'native_execution_environment' not in content:
        return {}  # Immutable pre-change captures are not retroactively enriched.
    return {'native_execution_policy': execution_policy(content['native_execution_environment'],
        frozen_at=saved['manifest']['frozen_at'])}


def capture_execution_environment(*, context_reader=None, runner=None, clock=None):
    from services.native_paper_sandbox import native_runtime_manifest
    from services.paired_native_runtime import KV_READ_POLICY, read_worker_context
    clock = clock or (lambda: datetime.now(timezone.utc))
    context = (context_reader or read_worker_context)()
    runtime = native_runtime_manifest(runner)
    packet = {'schema_version': 'paired-nav-execution-environment-v1',
        'execution_owner_version': runtime['execution_owner_version'], 'account_id': 1,
        'kv_read_policy': deepcopy(KV_READ_POLICY), 'source_context': deepcopy(context)}
    execution_policy(packet, frozen_at=clock().isoformat())
    return packet


def capture_pipeline_execution_environment(*, signal_date, source_run_id, objects=None,
                                         context_reader=None, runner=None, clock=None):
    """Reuse the existing immutable source inbox, including a failed D1 seal.

    Do not acquire a newer environment when allocation parts were written but
    their manifest acknowledgement failed. There is no new table or scheduler.
    """
    if objects is None:
        from services.paper_corporate_source import production_objects
        objects = production_objects()
    identity = {'kind': 'paired-nav-execution-environment-v1',
                'signal_date': signal_date, 'source_run_id': source_run_id}
    delivery = digest(identity)
    address = objects.lookup_delivery(delivery)
    if address is None:
        environment = capture_execution_environment(context_reader=context_reader, runner=runner, clock=clock)
        address = objects.publish_delivery(delivery, objects.put({'identity': identity, 'environment': environment}))
        if not address:
            raise RuntimeError('paired_native_execution_environment_delivery_missing')
    saved = objects.get(address)
    if saved.get('identity') != identity:
        raise ValueError('paired_native_execution_environment_delivery_mismatch')
    execution_policy(saved['environment'])
    return saved['environment']


def validate_registered_environment(*, parent, allocation, runtime, account_id,
                                    variables, kv_read_policy, source_context):
    expected = configuration_environment(parent)
    actual = allocation['configuration'].get('native_execution_policy')
    if not expected:
        if actual is not None:
            raise ValueError('paired_native_execution_environment_parent_missing')
        return
    observed = execution_policy({'schema_version': 'paired-nav-execution-environment-v1',
        'execution_owner_version': runtime['execution_owner_version'], 'account_id': account_id,
        'kv_read_policy': kv_read_policy, 'source_context': source_context})
    if (actual != expected['native_execution_policy'] or observed != actual
            or source_context != parent['payload']['content']['native_execution_environment']['source_context']
            or variables != source_context['variables']):
        raise ValueError('paired_native_execution_environment_changed_after_freeze')
