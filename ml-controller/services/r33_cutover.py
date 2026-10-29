"""R33 Paper cutover grant (R33-NEW-07): the L3 ensemble and its L4 recipe change together.

A new operator Paper admission names the R33 ensemble as its candidate and the
running pointer/config as its baseline. Its runtime approval carries
`approved_r33_cutover` (the r33_cutover evidence) and the prior runtime approval
that authorised the running configuration. Only the listed trading_config paths
may differ from that prior configuration; risk, execution policy and sources stay
pinned. No NAV verdict, maturity or reward transfers to the new strategy.
"""
from copy import deepcopy
from datetime import date
import re

from services.paired_nav_journal import digest, _timestamp

SCHEMA = 'r33-cutover-evidence-v1'
RANK_POOL_SCHEMA = 'r33-attested-rank-pool-v1'
# The only trading_config paths an R33 cutover may change; the evidence names the ones it does.
SCOPE_PATHS = (
    'trading:config.l4Distribution.artifact',
    'trading:config.l4Distribution.operating_mode',
    'trading:config.l4Distribution.strategy_role',
    'trading:config.l4Distribution.opb.approved_policy_identity',
)
_FIELDS = {'schema_version', 'mode', 'candidate_bundle', 'artifacts', 'base_artifact_set_checksum', 'ensemble',
           'calibration', 'rank_pool_schema', 'feature_schema', 'l4_model_checksum', 'economics_change_scope',
           'first_night', 'wei_approval'}
_BUNDLE = {'path', 'sha256', 'cohort_id', 'manifest_checksum', 'oof_checks_checksum', 'oof_checks_status',
           'pit_certified'}
_HEX = re.compile('[0-9a-f]{64}')


def _fail(reason):
    return RuntimeError('r33_cutover_invalid:' + reason)


def _hex(value):
    return isinstance(value, str) and _HEX.fullmatch(value) is not None


def _get(config, path):
    node = config
    for key in path.split('.')[1:]:
        if not isinstance(node, dict) or key not in node:
            return _ABSENT
        node = node[key]
    return node


def _set(config, path, value):
    keys = path.split('.')[1:]
    node = config
    for key in keys[:-1]:
        node = node.setdefault(key, {})
    if value is _ABSENT:
        node.pop(keys[-1], None)
    else:
        node[keys[-1]] = deepcopy(value)


_ABSENT = object()


def changed_paths(before, after):
    """The SCOPE_PATHS whose values differ; raises if anything outside them differs."""
    changed = [path for path in SCOPE_PATHS if _get(before, path) != _get(after, path)]
    expected = deepcopy(before)
    for path in changed:
        _set(expected, path, _get(after, path))
    if digest(expected) != digest(after):
        raise _fail('change_outside_scope')
    return changed


def validate_evidence(evidence, admission):
    """Bind the evidence to the admission's candidate identity and L4 artifact."""
    from services.l3_equal_weight_bundle import FEATURE_SCHEMA, is_equal7
    from services.paper_strategy_mode import R33_MODE
    from services.r33_crossfit_serving import TABLE_NAME
    from services.r33_monthly_lifecycle import BUNDLE_PREFIX
    if not isinstance(evidence, dict) or set(evidence) != _FIELDS or evidence['schema_version'] != SCHEMA:
        raise _fail('schema')
    bundle = admission['strategy_bundle']
    identity = bundle['candidate_l3_identity']
    policy = bundle['candidate_trading_config']['l4Distribution']
    artifact = policy['artifact']
    candidate, calibration = evidence['candidate_bundle'], evidence['calibration']
    if (evidence['mode'] != R33_MODE or policy.get('operating_mode') != R33_MODE
            or policy.get('strategy_role') != 'B' or policy.get('scope') != 'paper' or not is_equal7(artifact)):
        raise _fail('mode')
    if (evidence['ensemble'] != {'artifact_id': identity['artifact_id'], 'payload_checksum': identity['payload_checksum']}
            or evidence['base_artifact_set_checksum'] != identity['base_artifact_set_checksum']
            or artifact['l3_identity'] != identity
            or artifact['model']['ensemble_payload_checksum'] != identity['payload_checksum']):
        raise _fail('l3_identity')
    if (evidence['feature_schema'] != FEATURE_SCHEMA or artifact['feature_schema'] != FEATURE_SCHEMA
            or evidence['l4_model_checksum'] != artifact['model_checksum']
            or evidence['rank_pool_schema'] != RANK_POOL_SCHEMA):
        raise _fail('l4_artifact')
    if (not isinstance(candidate, dict) or set(candidate) != _BUNDLE
            or candidate['oof_checks_status'] != 'pass' or candidate['pit_certified'] is not True
            or candidate['cohort_id'] != identity['cohort_id']
            or candidate['path'] != f"{BUNDLE_PREFIX}/{identity['cohort_id']}/bundle.json"
            or not all(_hex(candidate[k]) for k in ('sha256', 'manifest_checksum', 'oof_checks_checksum'))):
        raise _fail('candidate_bundle')
    if (not isinstance(calibration, dict)
            or set(calibration) != {'source_payload_checksum', 'serving_table_path', 'serving_table_checksum'}
            or not _hex(calibration['source_payload_checksum']) or not _hex(calibration['serving_table_checksum'])
            or calibration['serving_table_checksum'] != artifact['model']['calibration_checksum']
            or calibration['serving_table_path'] != f"{BUNDLE_PREFIX}/{identity['cohort_id']}/{TABLE_NAME}"):
        raise _fail('calibration')
    from services.l4_distribution_runtime import distribution_policy_identity
    from services.r33_isotonic_calibration import checksum
    if (not isinstance(evidence['artifacts'], dict) or not evidence['artifacts']
            or checksum(evidence['artifacts']) != identity['base_artifact_set_checksum']):
        raise _fail('artifacts')
    if (policy.get('opb') or {}).get('approved_policy_identity') != distribution_policy_identity(policy, identity):
        raise _fail('opb_policy_identity')
    approval = evidence['wei_approval']
    if (not isinstance(approval, dict) or set(approval) != {'approved', 'scope', 'approved_at', 'source_reference'}
            or approval['approved'] is not True or approval['scope'] != 'paper'
            or not isinstance(approval['source_reference'], str) or not approval['source_reference'].strip()):
        raise _fail('wei_approval')
    _timestamp(approval['approved_at'])
    return candidate


def validate_against_ensemble(evidence, ensemble):
    """At serving: the evidence describes the exact published R33 object, field for field."""
    from services.r33_ensemble import validate_ensemble
    validate_ensemble(ensemble)
    source = ensemble['source_bundle']
    candidate, calibration = evidence['candidate_bundle'], evidence['calibration']
    if (evidence['ensemble'] != {'artifact_id': ensemble['artifact_id'], 'payload_checksum': ensemble['payload_checksum']}
            or evidence['artifacts'] != ensemble['base_artifacts']
            or evidence['base_artifact_set_checksum'] != ensemble['base_artifact_set_checksum']
            or candidate['cohort_id'] != ensemble['cohort_id']
            or any(candidate[k] != source[k] for k in ('path', 'sha256', 'manifest_checksum', 'oof_checks_checksum'))
            or candidate['oof_checks_status'] != ensemble['validation']['oof_checks_status']
            or candidate['pit_certified'] is not ensemble['validation']['pit_certified']
            or calibration['source_payload_checksum'] != source['source_calibration_checksum']
            or calibration['serving_table_checksum'] != ensemble['serving_calibration']['payload_checksum']):
        raise _fail('ensemble_mismatch')


def validate_cutover(approval, admission, *, now):
    """Evidence + the prior authority chain. The caller then compares approval vs admission configuration."""
    from services.active8_paper_admission import runtime_configuration_identity, validate_runtime_approval
    evidence = approval['approved_r33_cutover']
    validate_evidence(evidence, admission)
    # The prior is the grant active when the switch tool ran (R33-NEW-15 checks it against KV
    # before writing); a prior R33 cutover is allowed, so the next R33 cohort cuts over the same way.
    prior = approval.get('prior_runtime_approval')
    if not isinstance(prior, dict):
        raise _fail('prior_runtime_required')
    old_admission = prior.get('admission')
    if not isinstance(old_admission, dict) or old_admission == admission:
        raise _fail('prior_admission_required')
    validate_runtime_approval(prior, old_admission, now=now)
    bundle = admission['strategy_bundle']
    old_identity = old_admission['strategy_bundle']['candidate_l3_identity']
    if any(bundle['baseline_l3_identity'].get(k) != old_identity.get(k)
           for k in ('artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')):
        raise _fail('baseline_not_prior_candidate')
    before = runtime_configuration_identity(prior['configuration'])
    after = runtime_configuration_identity(approval['configuration'])
    if digest(bundle['baseline_trading_config']) != digest(before['trading_config']):
        raise _fail('baseline_not_prior_configuration')
    changed = changed_paths(before['trading_config'], after['trading_config'])
    if sorted(evidence['economics_change_scope']) != sorted(changed) or not changed:
        raise _fail('economics_change_scope')
    before['trading_config'] = deepcopy(after['trading_config'])
    if digest(before) != digest(after):
        raise _fail('non_trading_configuration_changed')
    old_policy = prior['configuration']['trading_config'].get('l4Distribution') or {}
    first = evidence['first_night']
    if (not isinstance(first, dict) or set(first) != {'supersedes_plan_policy_identity', 'effective_signal_date'}
            or first['supersedes_plan_policy_identity'] != (old_policy.get('opb') or {}).get('approved_policy_identity')
            or not isinstance(first['effective_signal_date'], str)
            or date.fromisoformat(first['effective_signal_date']).isoformat() != first['effective_signal_date']
            or first['effective_signal_date'] < admission['business_date']):
        raise _fail('first_night')
    approved_at = _timestamp(evidence['wei_approval']['approved_at'])
    if not approved_at <= _timestamp(admission['approved_at']) <= _timestamp(approval['approved_at']):
        raise _fail('approval_order')
    return evidence


# Grant kinds whose prior_runtime_approval the validator pins (release manifest checksum or
# a reviewed provenance transition). Only through these may serving reach an older cutover.
_PINNED_PRIOR = ('approved_strategy_nav_source_change', 'approved_capture_provenance_source_change')


def cutover_evidence(approval, admission):
    """The cutover evidence behind an active approval for this admission.

    Later source releases embed the approval they replace as prior_runtime_approval,
    so the cutover grant stays reachable through that chain under the same admission.
    Any other nested prior is unvalidated data and is never followed.
    """
    node = approval
    while isinstance(node, dict) and node.get('admission') == admission:
        if node.get('approved_r33_cutover') is not None:
            return node['approved_r33_cutover']
        if not any(node.get(key) is not None for key in _PINNED_PRIOR):
            return None
        node = node.get('prior_runtime_approval')
    return None


def verify_serving(approval, admission, ensemble):
    """Serving an R33 object needs its cutover evidence; a non-R33 object must not claim one."""
    from services.r33_ensemble import is_r33
    evidence = cutover_evidence(approval, admission)
    if is_r33(ensemble) != (evidence is not None):
        raise _fail('serving_requires_cutover_evidence')
    if evidence is not None:
        validate_against_ensemble(evidence, ensemble)
