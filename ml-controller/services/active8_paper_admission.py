"""Explicit operator-approved Paper admission; never an investment/NAV verdict.

Uses the existing atomic ensemble publisher and immutable receipt. The active
approval must match KV while serving; revocation, config drift and live execution
fail closed. No new publisher, training job or automatic promotion is introduced.
"""
from copy import deepcopy
from datetime import datetime, timezone, timedelta
import json

from services.paired_nav_journal import digest, _timestamp

SCHEMA = 'active8-paper-experiment-admission-v1'
KEY = 'ml:active8:paper_admission:v1'


def validate_admission(admission, *, artifact, now=None):
    from services.ensemble_v2 import ensemble_artifact_id
    from services.paired_nav_strategy_bundle import validate_strategy_bundle
    from services.strategy_ab import validate_tag
    clock = now or datetime.now(timezone.utc)
    if (not isinstance(admission, dict) or admission.get('schema_version') != SCHEMA
            or admission.get('scope') != 'paper' or admission.get('approved') is not True
            or admission.get('efficacy_status') != 'unproven'
            or admission.get('nav_gate_role') != 'performance_review_after_paper_admission'
            or not isinstance(admission.get('source_reference'), str)
            or not admission['source_reference'].strip()
            or admission.get('admission_checksum') != digest({k:v for k,v in admission.items() if k!='admission_checksum'})
            or _timestamp(admission['approved_at']) > clock):
        raise ValueError('active8_paper_admission_invalid')
    identity = {'schema_version':'paired-nav-formal-ml-baseline-v1',
        'artifact_id':ensemble_artifact_id(artifact),
        **{k:artifact[k] for k in ('cohort_id','payload_checksum','base_artifact_set_checksum')}}
    bundle = validate_strategy_bundle(admission['strategy_bundle'], candidate_identity=identity,
        signal_date=admission['business_date'])
    tag=validate_tag(bundle.get('strategy_ab'))
    from services.paper_strategy_mode import single_b_policy
    from services.strategy_ab import TABPACK_SCHEMA
    mode=single_b_policy(bundle['candidate_trading_config'],signal_date=admission['business_date'])
    if tag['role']!='A' and not (mode and tag['role']=='B' and tag['schema_version']==TABPACK_SCHEMA):
        raise ValueError('active8_paper_primary_A_required')
    if mode and tag['role']!='B':raise ValueError('active8_paper_single_B_identity_required')
    release = bundle['candidate_trading_config']['l4Distribution']['artifact']['release']
    if release.get('acceptance_mode') != 'paper_experiment' or release.get('efficacy_status') != 'unproven':
        raise ValueError('active8_paper_engineering_acceptance_required')
    from services.l4_distribution_lifecycle import validate_acceptance
    validate_acceptance(release['validation_receipt'], bundle['candidate_trading_config']['l4Distribution']['artifact'])
    config = admission['configuration']
    if config.get('trading_config') != bundle['candidate_trading_config']:
        raise ValueError('active8_paper_configuration_pairing_mismatch')
    for key in ('trading_config','risk_config','allocator_source_identity',
                'l3_inference_source_identity','native_execution_policy'):
        if not isinstance(config.get(key), dict) or not config[key]:
            raise ValueError('active8_paper_execution_configuration_incomplete:'+key)
    policy = config['native_execution_policy']
    if policy.get('schema_version') != 'paired-nav-execution-policy-v1' or not isinstance(policy.get('variables'), dict):
        raise ValueError('active8_paper_execution_policy_invalid')
    for flag in ('LIVE_EXECUTION_CLIENT_ENABLED','LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'):
        if str(policy['variables'].get(flag, '')).lower() in {'1','true','yes','enabled','on'}:
            raise ValueError('active8_paper_live_execution_forbidden')
    if admission['business_date'] > clock.astimezone(timezone(timedelta(hours=8))).date().isoformat():
        raise ValueError('active8_paper_future_business_date')
    return deepcopy(admission)


RUNTIME_SCHEMA = 'active8-paper-runtime-approval-v1'
RUNTIME_KEY = 'ml:active8:paper_runtime_approval:v1'
RUNTIME_RELEASE_KEY = RUNTIME_KEY + ':2026-10-02-budget-ledger-recovery'

SWING_RUNTIME_RELEASE_KEY = RUNTIME_KEY + ':2026-10-02-single-plan-swing'
SWING_POLICY_CHANGE = {
    'schema_version':'paper-single-plan-swing-change-v1',
    'scope':'paper', 'maturity_transfer':False, 'efficacy_status':'unproven',
    'variables':{
        'PAPER_INTRADAY_ENTRY_OWNER':{'previous':'or15_vwap_v1','approved':'or15-5m-orl8-20-v1'},
        'PAPER_DAILY_PLAN_OWNER':{'previous':None,'approved':'premarket_once_v1'},
    },
    'allocator_sources':{'l4_distribution_context.py':{
        'previous':'471d8a905838b84c1498fcb3915856d98a00c8b4893e7d256bc1b0fa415730f2',
        'approved':'7bb742c3ec3cde5c173e1d37d04117c1f577c5f84369d36a7a9f5ef6dee0719f'}},
}

ODD_LOT_QUOTE_AGE_CHANGE = {
    'schema_version': 'active8-paper-odd-lot-quote-age-change-v1',
    'variable': 'FINLAB_L5_ODD_LOT_MAX_QUOTE_AGE_MS',
    'previous': 'absent',
    'approved': '10000',
}


PAPER_ENTRY_OWNER_CHANGE = {
    'release': '2026-10-01-existing-or15-context-parity',
    'previous': {'S12_INTRADAY_PRIMARY_OWNER_ENABLED': '1'},
    'approved': {'S12_INTRADAY_PRIMARY_OWNER_ENABLED': '0',
                 'PAPER_INTRADAY_ENTRY_OWNER': 'or15_vwap_v1'},
}

PERFORMANCE_SOURCE_CHANGE = {
    'release': '2026-10-01-native-nav-performance',
    'scope': 'paper',
    'maturity_transfer': False,
    'sources': {
        'allocator_source_identity': {
            'paired_nav_collection.py': {
                'previous': '419cf1c77e601179945c6601d763b2105efc39488239d6d79849aa2529e9d288',
                'approved': '8c117cbefe84f0b84a9f6627bf4fa53e640da85935679851e5dacfaeaf4893f2',
            },
        },
        'l3_inference_source_identity': {
            'paired_nav_strategy_bundle.py': {
                'previous': '561d4926573ba93c93e9310be464a47aa40c7f41f320a2ffdc704196956caa42',
                'approved': '4e52c91257cc9c9124cdfaaf787918da3eb20ba96db5f3a55e7cf3729efcad70',
            },
        },
    },
}


def runtime_configuration_identity(configuration):
    """Project only explicitly non-trading GA candidate diagnostics."""
    result = deepcopy(configuration)
    adaptive = result.get('native_execution_policy', {}).get('frozen_kv', {}).get('ml:adaptive_params')
    ga = ((adaptive or {}).get('bandit_context') or {}).get('ga_optimizer')
    if (isinstance(ga, dict) and ga.get('runtime_role') == 'shadow_learning_context'
            and ga.get('applies_to_trading_config') is False
            and (ga.get('effect_policy') or {}).get('mutates_trading_config') is False):
        ga.pop('candidate_latest', None)
    return result


def validate_runtime_approval(approval, admission, *, now=None):
    """Exact supplementary operator authorization, not a NAV verdict."""
    clock = now or datetime.now(timezone.utc)
    if (not isinstance(approval, dict) or approval.get('schema_version') != RUNTIME_SCHEMA
            or approval.get('admission') != admission or approval.get('scope') != 'paper'
            or approval.get('approved') is not True or approval.get('maturity_transfer') is not False
            or approval.get('efficacy_status') != 'unproven'
            or not isinstance(approval.get('source_reference'), str) or not approval['source_reference'].strip()
            or not _timestamp(admission['approved_at']) <= _timestamp(approval['approved_at']) <= clock
            or approval.get('approval_checksum') != digest({k:v for k,v in approval.items() if k!='approval_checksum'})):
        raise RuntimeError('active8_paper_runtime_approval_invalid')
    before = runtime_configuration_identity(admission['configuration'])
    after = runtime_configuration_identity(approval['configuration'])
    # Only the two reviewed authority readers may change L3 source identity.
    # Their NEW complete hashes remain pinned by the approved configuration.
    permitted_sources = {'active8_paper_admission.py', 'active8_nav_adoption.py'}
    for config in (before, after):
        sources = config.get('l3_inference_source_identity', {})
        for name in permitted_sources:
            value = sources.pop(name, None)
            if (not isinstance(value, str) or len(value) != 64
                    or any(c not in '0123456789abcdef' for c in value)):
                raise RuntimeError('active8_paper_runtime_source_identity_invalid')
        policy = config['native_execution_policy']
        version = policy.pop('execution_owner_version')
        if (not isinstance(version, str) or not version.startswith('native-paper-v1:')
                or len(version) != 80 or any(c not in '0123456789abcdef' for c in version[16:])):
            raise RuntimeError('active8_paper_runtime_execution_identity_invalid')
        adaptive = policy.get('frozen_kv', {}).get('ml:adaptive_params')
        if isinstance(adaptive, dict):
            meta = adaptive.get('meta_layer') or {}
            for key in ('alpha_vote_models', 'formal_layer3_slots'):
                meta.pop(key, None)
        for flag in ('LIVE_EXECUTION_CLIENT_ENABLED', 'LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'):
            if str(policy['variables'].get(flag, '')).lower() in {'1','true','yes','enabled','on'}:
                raise RuntimeError('active8_paper_live_execution_forbidden')
    swing_change = approval.get('approved_single_plan_swing_change')
    if swing_change is not None:
        if swing_change != SWING_POLICY_CHANGE:
            raise RuntimeError('active8_paper_swing_change_invalid')
        prior=before['native_execution_policy']['variables']
        current=after['native_execution_policy']['variables']
        for key,transition in SWING_POLICY_CHANGE['variables'].items():
            if prior.get(key)!=transition['previous'] or current.get(key)!=transition['approved']:
                raise RuntimeError('active8_paper_swing_variables_invalid')
            if transition['previous'] is None:current.pop(key)
            else:current[key]=transition['previous']
        for name,transition in SWING_POLICY_CHANGE['allocator_sources'].items():
            if before['allocator_source_identity'].get(name)!=transition['previous'] or after['allocator_source_identity'].get(name)!=transition['approved']:
                raise RuntimeError('active8_paper_swing_sources_invalid')
            after['allocator_source_identity'][name]=transition['previous']
    change = approval.get('approved_execution_policy_change')
    if change is not None:
        key = ODD_LOT_QUOTE_AGE_CHANGE['variable']
        prior = before['native_execution_policy']['variables']
        current = after['native_execution_policy']['variables']
        if (change != ODD_LOT_QUOTE_AGE_CHANGE or key in prior
                or current.get(key) != ODD_LOT_QUOTE_AGE_CHANGE['approved']):
            raise RuntimeError('active8_paper_runtime_policy_change_invalid')
        current.pop(key)
    entry_change = approval.get('approved_paper_entry_owner_change')
    if entry_change is not None:
        prior = before['native_execution_policy']['variables']
        current = after['native_execution_policy']['variables']
        if (entry_change != PAPER_ENTRY_OWNER_CHANGE
                or prior.get('S12_INTRADAY_PRIMARY_OWNER_ENABLED') != '1'
                or 'PAPER_INTRADAY_ENTRY_OWNER' in prior
                or current.get('S12_INTRADAY_PRIMARY_OWNER_ENABLED') != '0'
                or current.get('PAPER_INTRADAY_ENTRY_OWNER') != 'or15_vwap_v1'):
            raise RuntimeError('active8_paper_runtime_entry_owner_change_invalid')
        current['S12_INTRADAY_PRIMARY_OWNER_ENABLED'] = '1'
        current.pop('PAPER_INTRADAY_ENTRY_OWNER')
    source_change = approval.get('approved_source_change')
    if source_change is not None:
        # Exact release-scoped Paper reapproval, never an allocator/NAV source
        # equivalence. Serving still compares every current hash to the new
        # configuration, and every unrelated policy field must remain equal.
        if source_change != PERFORMANCE_SOURCE_CHANGE:
            raise RuntimeError('active8_paper_runtime_source_change_invalid')
        for section, sources in PERFORMANCE_SOURCE_CHANGE['sources'].items():
            for name, transition in sources.items():
                if (before.get(section, {}).get(name) != transition['previous']
                        or after.get(section, {}).get(name) != transition['approved']):
                    raise RuntimeError('active8_paper_runtime_source_change_invalid')
                after[section][name] = transition['previous']
    if digest(before) != digest(after):
        raise RuntimeError('active8_paper_runtime_approval_policy_changed')
    return deepcopy(approval)


def verify_active_approval(admission, *, now=None):
    from services import kv_client
    # Preserve the original key for its existing consumers and live-order guard.
    # Supplemental authorization cannot override revocation of that approval.
    active = kv_client.get_json(KEY, default=None, strict=True)
    if active != admission:
        raise RuntimeError('active8_paper_operator_approval_missing_changed_or_revoked')
    # Stage this release's exact approval before routing traffic. Older builds
    # retain their own release key, so a candidate check cannot revoke their grant.
    import os
    release_key=SWING_RUNTIME_RELEASE_KEY if os.environ.get('PIPELINE_DAILY_PLAN_OWNER')=='premarket_once_v1' else RUNTIME_RELEASE_KEY
    runtime = kv_client.get_json(release_key, default=None, strict=True)
    if runtime is None:
        runtime = kv_client.get_json(RUNTIME_KEY, default=None, strict=True)
    if runtime is None:
        return deepcopy(active)
    return validate_runtime_approval(runtime, admission, now=now)


def verify_serving_configuration(admission, approval, *, model_names):
    from services.active8_nav_adoption import current_execution_configuration, verify_current_configuration
    if approval == admission:
        return verify_current_configuration(admission['configuration'])
    current = current_execution_configuration()
    expected = approval['configuration']
    if digest(runtime_configuration_identity(current)) != digest(runtime_configuration_identity(expected)):
        raise RuntimeError('active8_nav_current_configuration_changed_or_unverified')
    from services.alpha_model_roster import model_order
    meta = current['native_execution_policy'].get('frozen_kv', {}).get('ml:adaptive_params', {}).get('meta_layer', {})
    for key in ('alpha_vote_models', 'formal_layer3_slots'):
        if meta.get(key) != list(model_order(model_names, complete=True)):
            raise RuntimeError('active8_paper_runtime_roster_mismatch')
    return current


def prepare_paper_adoption(*, ensemble_row, admission, business_date, query):
    from services.active8_nav_adoption import verify_current_configuration
    artifact = json.loads(ensemble_row['payload_json'])
    validate_admission(admission, artifact=artifact)
    if admission['business_date'] != business_date:
        raise ValueError('active8_paper_admission_date_mismatch')
    verify_active_approval(admission)
    verify_current_configuration(admission['configuration'])
    pointers = query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', [])
    baseline = admission['strategy_bundle']['baseline_l3_identity']
    if len(pointers) != 1 or any(pointers[0].get(k)!=baseline[k]
            for k in ('artifact_id','cohort_id','payload_checksum','base_artifact_set_checksum')):
        raise RuntimeError('active8_paper_baseline_changed')
    # The original publisher adds atomic pointer/artifact/history CAS guards.
    return {'admission':deepcopy(admission), 'configuration':deepcopy(admission['configuration'])}


def validate_publication_receipt(receipt, artifact, *, now=None):
    from services.ensemble_v2 import ensemble_artifact_id
    admission = validate_admission(receipt.get('paper_admission'), artifact=artifact, now=now)
    if ('nav_validation' in receipt or 'nav_configuration' in receipt
            or receipt.get('schema_version') != 'active8-ensemble-atomic-promotion-evidence-v1'
            or receipt.get('ensemble_artifact_id') != ensemble_artifact_id(artifact)
            or receipt.get('ensemble_payload_checksum') != artifact['payload_checksum']
            or receipt.get('base_artifact_set_checksum') != artifact['base_artifact_set_checksum']
            or receipt.get('selected_models') != sorted(artifact['selected_models'])
            or receipt.get('validation') != artifact['validation']
            or receipt.get('evaluation_business_date') != admission['business_date']):
        raise ValueError('active8_paper_publication_receipt_invalid')
    return admission
