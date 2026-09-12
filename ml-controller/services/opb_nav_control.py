"""Consume the original D1 NAV publication; no new efficacy test or publisher.

Live grants come from the Learning DB before allocation. A sealed copy is used
only inside the isolated replay scope, never as JSON production authority.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from services.paired_nav_journal import digest, _timestamp

_SQL = json.loads(Path(__file__).with_name('opb_nav_serving_source.json').read_text(encoding='utf-8'))
CONTROL_SQL = _SQL['control_snapshot_sql'].replace('__EV_FENCE__', _SQL['ev_fence_sql'])
_SEAL = object()
_ACTIVE = ContextVar('original_opb_nav_control', default=None)


@dataclass(frozen=True)
class _Control:
    checksum: str
    artifact_id: str
    receipt_checksum: str
    arms: tuple
    artifact: dict
    allocation_policy: dict
    ranking_config: dict
    ensemble_config: dict
    formal_identity: dict
    ev_identity: dict
    scope: str
    seal: object


def configured_prior(config):
    allocation = (config.get('alphaFramework') or config.get('alpha_framework') or {}).get('allocation') or {}
    return allocation.get('opbArmPrior', allocation.get('opb_arm_prior'))


def needs_nav_control(config):
    prior = configured_prior(config)
    return isinstance(prior, dict) and prior.get('schema_version') == 'opb-arm-prior-artifact-v3'


def _without_prior(config):
    config = deepcopy(config)
    for root in ('alphaFramework', 'alpha_framework'):
        allocation = (config.get(root) or {}).get('allocation') or {}
        allocation.pop('opbArmPrior', None)
        allocation.pop('opb_arm_prior', None)
        allocation.pop('controller', None)
    return config


def _error(reason):
    raise ValueError('paired_nav_opb_control_' + reason)


def _utc_now():
    return datetime.now(timezone.utc)


def _same_json(actual, expected):
    """KV uses JS numbers (0.0 becomes 0); booleans must NOT become numbers."""
    if type(actual) in (int, float) and type(expected) in (int, float):
        return actual == expected
    if type(actual) is not type(expected):
        return False
    if isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(_same_json(actual[k], v) for k, v in expected.items())
    if isinstance(expected, list):
        return len(actual) == len(expected) and all(_same_json(a, b) for a, b in zip(actual, expected))
    return actual == expected


def _history_time(value):
    # The original D1 table's CURRENT_TIMESTAMP is UTC without a suffix.
    # Do not loosen the journal's timezone rule for external evidence clocks.
    if isinstance(value, str) and len(value) == 19 and value[10] == ' ':
        return datetime.strptime(value, '%Y-%m-%d %H:%M:%S').replace(tzinfo=timezone.utc)
    return _timestamp(value)


def _grant(context, *, scope, decision_at):
    if scope not in {'live_capture', 'frozen_replay'}:
        _error('scope_invalid')
    if not isinstance(decision_at, datetime) or decision_at.tzinfo is None:
        _error('clock_invalid')
    if (not isinstance(context, dict) or context.get('schema_version') != 'opb-nav-control-context-v1'
            or context.get('content_checksum') != digest({k: v for k, v in context.items() if k != 'content_checksum'})
            or _timestamp(context['observed_at']) > decision_at):
        _error('source_invalid')
    row = context['record']
    if row is None:
        return None  # No canonical adoption yet. Incumbent sparse remains available.
    evidence = json.loads(row['promotion_evidence_json'])
    history = json.loads(row['history_json'])
    gate = evidence.get('gate') or {}
    nav = gate.get('nav_validation') or {}
    raw = gate.get('candidate_payload_json')
    if (evidence.get('schema_version') != 'opb-nav-pointer-adoption-v1'
            or row['promotion_reason'] != evidence['schema_version']
            or row['model_name'] != 'opb_arm_prior' or row['candidate_type'] != 'opb_arm_prior_refresh'
            or row['state'] != 'production' or row['version'] != row['champion_version']
            or evidence.get('owner') != 'opb_arm_prior' or evidence.get('artifact_id') != row['champion_artifact_id']
            or evidence.get('artifact_checksum') != row['checksum']
            or gate.get('decision') != 'PASS' or nav.get('decision') != 'PASS'
            or evidence.get('decision_checksum') != gate.get('evaluation_evidence_checksum')
            or evidence.get('decision_checksum') != nav.get('decision_checksum')
            or not isinstance(raw, str) or hashlib.sha256(raw.encode()).hexdigest() != row['checksum']):
        _error('publication_invalid')
    artifact = json.loads(raw)
    if (artifact != json.loads(row['offline_evidence_json']) or artifact['model_version'] != row['version']
            or artifact['artifact_id'] != row['champion_artifact_id']
            or artifact['trained_until'] != row['source_run_date']
            or row['training_run_id'] != f"opb_arm_prior_refresh:{row['source_run_date']}:{artifact['expected_return_owner']}"):
        _error('prior_changed')
    if (len(history) != 1 or history[0]['event_id'] != f"opb-nav:{row['checksum']}:{evidence['decision_checksum']}"
            or history[0]['artifact_id'] != row['champion_artifact_id'] or history[0]['version'] != row['version']
            or history[0]['source'] != 'model_champion_history' or history[0]['evidence_grade'] != 'exact'
            or history[0]['evidence_json'] != row['promotion_evidence_json']
            or _history_time(history[0]['effective_at']) > _timestamp(context['observed_at'])):
        _error('history_invalid')
    frozen = evidence['configuration']
    formal = json.loads(row['formal_json'] or 'null')
    if not formal or any(formal[k] != frozen['formal_baseline_identity'][k] for k in (
            'artifact_id', 'cohort_id', 'payload_checksum', 'base_artifact_set_checksum')):
        _error('ml_changed')
    if row['current_ev_fence'] != evidence['serving_fence']:
        _error('ev_changed')
    config, risk = context['trading_config'], context['risk_config']
    allocation = (config.get('alphaFramework') or config.get('alpha_framework') or {}).get('allocation') or {}
    if (allocation.get('controller') != 'OnlinePortfolioBandit'
            or not _same_json(configured_prior(config), artifact) or not _same_json(risk, frozen['risk_config'])
            or not _same_json(_without_prior(config), _without_prior(frozen['trading_config']))):
        _error('configuration_changed')
    identities = evidence['serving_ev_identity']
    if len(identities) != 1 or identities != frozen['opb_serving_ev_identity']:
        _error('ev_identity_invalid')
    from services.paired_nav_opb_prior import verify_opb_prior
    from services.alpha_framework import normalize_alpha_policy
    arms = verify_opb_prior(artifact, checksum=row['checksum'], decision_at=_timestamp(context['observed_at']))
    return _Control(row['checksum'], artifact['artifact_id'],
        hashlib.sha256(row['promotion_evidence_json'].encode()).hexdigest(), arms, deepcopy(artifact),
        normalize_alpha_policy(config.get('alphaFramework') or config.get('alpha_framework') or {})['allocation'],
        deepcopy(config.get('ranking') or {}), deepcopy(config.get('ensemble_v2') or {}),
        deepcopy(formal),
        deepcopy(identities[0]), scope, _SEAL)


def capture_nav_control(*, query, trading_config, risk_config, now=None):
    rows = query(CONTROL_SQL, [])  # One DB snapshot for pointer/registry/history/ML/EV.
    if len(rows) > 1:
        _error('ambiguous_pointer')
    clock = now or _utc_now()
    mode_sql = """SELECT p.model_name,x.serving_mode,s.owner_state
        FROM model_champion_pointers p
        LEFT JOIN expected_return_artifact_payloads x ON x.artifact_id=p.champion_artifact_id
        LEFT JOIN expected_return_owner_state_v2 s ON s.owner=p.model_name
        WHERE p.model_name IN ('l4_alpha_ev','allocator_ev_fusion') ORDER BY p.model_name"""
    modes = query(mode_sql, []) if rows else []
    if rows:
        # The legacy frozen EV token does not include serving_mode. Keep that
        # immutable replay identity; validate the live mode independently before
        # granting control, and fence a mode-only race with a second read below.
        if not modes or any(row['serving_mode'] != 'alpha'
                and not (row['serving_mode'] == 'abstention_baseline'
                         and row['owner_state'] != 'learned_champion') for row in modes):
            _error('ev_serving_mode_invalid')
        # A NAV-adopted L3 legitimately retains offline FAIL. Verify its original
        # committed publication, not a JSON PASS and not the serving reader
        # (which itself verifies this independently adopted OPB configuration).
        pointers = query('SELECT * FROM active8_ensemble_pointer_v1 WHERE singleton_id=1', [])
        if len(pointers) != 1:
            _error('ml_changed')
        pointer = pointers[0]
        receipt = json.loads(pointer.get('promotion_evidence_json') or '{}')
        if not isinstance(receipt, dict):
            _error('ml_receipt_invalid')
        if 'nav_validation' in receipt:
            from services.active8_nav_adoption import load_committed_nav_publication
            publication = load_committed_nav_publication(query=query, now=clock)
            if publication is None or json.loads(publication.receipt_json) != receipt:
                _error('ml_publication_unverified')
        else:
            artifacts = query('SELECT * FROM active8_ensemble_artifacts_v1 WHERE artifact_id=?', [pointer['artifact_id']])
            if len(artifacts) != 1 or artifacts[0]['validation_decision'] != 'PASS':
                _error('ml_publication_unverified')
    content = {'schema_version': 'opb-nav-control-context-v1', 'observed_at': clock.isoformat(),
        'record': deepcopy(rows[0]) if rows else None,
        'trading_config': deepcopy(trading_config), 'risk_config': deepcopy(risk_config)}
    context = {**content, 'content_checksum': digest(content)}
    grant = _grant(context, scope='live_capture', decision_at=clock)
    if query(CONTROL_SQL, []) != rows or rows and query(mode_sql, []) != modes:
        _error('source_changed')
    return context, grant


def replay_nav_control(context):
    # Only the isolated runner calls this. There is intentionally no DB reader.
    return _grant(context, scope='frozen_replay', decision_at=_timestamp(context['observed_at']))


def restore_captured_nav_control(context, *, query, trading_config, risk_config):
    """Only used after the original snapshot reader verifies a same-parent retry."""
    if context['trading_config'] != trading_config or context['risk_config'] != risk_config:
        _error('retry_configuration_changed')
    # A formal retry is not a historical replay: recheck the current serving
    # source before reusing the first seal. No re-evaluation or budget spending.
    current, _ = capture_nav_control(query=query, trading_config=trading_config, risk_config=risk_config)
    if current['record'] != context['record']:
        _error('retry_source_changed')
    return _grant(context, scope='live_capture', decision_at=_utc_now())


def verify_control_inputs(grant, alpha_policy, baseline_identity, ranking_config, ensemble_config):
    """Bind actual allocator knobs to the adopted config, not just its prior."""
    if grant is None:
        return
    if (not isinstance(baseline_identity, dict)
            or any(baseline_identity.get(k) != value for k, value in grant.formal_identity.items())):
        _error('runtime_ml_changed')
    if (not _same_json(ranking_config, grant.ranking_config)
            or not _same_json(ensemble_config, grant.ensemble_config)):
        _error('runtime_configuration_changed')
    from services.alpha_framework import normalize_alpha_policy
    if not _same_json(normalize_alpha_policy(alpha_policy)['allocation'], grant.allocation_policy):
        _error('runtime_policy_changed')


def control_execution(grant, capture):
    """Report the actual execution; normal no-eligible-stock is not a failure."""
    if grant is None:
        return None
    base = {'artifact_id': grant.artifact_id, 'artifact_checksum': grant.checksum,
        'publication_receipt_checksum': grant.receipt_checksum, 'can_write_order': False}
    if (capture.get('status') == 'allocation_disabled_by_frozen_config'
            or capture.get('allocation_candidates') == []):
        return {**base, 'status': 'not_applicable', 'reason': 'no_enabled_eligible_allocation',
            'control_executed': False}
    packet = capture.get('opb_packet') or {}
    prior = packet.get('prior_artifact') or {}
    contract = capture.get('allocation_contract') or {}
    executed = (packet.get('status') == 'ok'
        and contract.get('controller_effective') == 'OnlinePortfolioBandit'
        and contract.get('opb_production_control_allowed') is True
        and prior.get('production_control_ready') is True
        and prior.get('candidate_checksum') == grant.checksum
        and prior.get('publication_receipt_checksum') == grant.receipt_checksum)
    return {**base, 'status': 'completed' if executed else 'failed', 'control_executed': executed,
        'reason': None if executed else 'paired_nav_opb_control_execution_incomplete'}


@contextmanager
def control_scope(grant):
    if grant is not None and (not isinstance(grant, _Control) or grant.seal is not _SEAL):
        _error('unverified_grant')
    token = _ACTIVE.set(grant)
    try:
        yield
    finally:
        _ACTIVE.reset(token)


def resolve_nav_control(artifact, *, owner, contract, semantic, model_version=None, trained_until=None):
    grant = _ACTIVE.get()
    if not isinstance(grant, _Control) or grant.seal is not _SEAL or not _same_json(artifact, grant.artifact):
        return None, 'nav_control_authority_missing'
    from services.paired_nav_intervention import active_intervention
    isolated = active_intervention()
    if (grant.scope == 'frozen_replay') != (isolated is not None):
        return None, 'nav_control_scope_mismatch'
    # A counterfactual changes EV ONLY. Keep the exact already-frozen allocator
    # knobs/priors; this exception is inaccessible to production JSON/config.
    if isolated is None or isolated.forecasts is None:
        expected = grant.ev_identity
        if (owner, contract, semantic, model_version, trained_until) != tuple(expected[k] for k in (
                'expected_return_owner', 'expected_return_contract_version', 'expected_return_semantic',
                'expected_return_model_version', 'expected_return_trained_until')):
            return None, 'nav_control_runtime_ev_changed'
    return grant, None
