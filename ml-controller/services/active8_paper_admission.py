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
    if validate_tag(bundle.get('strategy_ab'))['role'] != 'A':
        raise ValueError('active8_paper_primary_A_required')
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


def verify_active_approval(admission):
    from services import kv_client
    if kv_client.get_json(KEY, default=None, strict=True) != admission:
        raise RuntimeError('active8_paper_operator_approval_missing_changed_or_revoked')


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
