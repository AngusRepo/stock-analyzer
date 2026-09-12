"""Frozen OPB candidate inventory -> original isolated allocation -> shared NAV.

No additional efficacy gate, history backfill, family-budget reset or publisher.
Every declared candidate remains in the denominator even when inference fails.
"""
from datetime import date, datetime, timezone
from copy import deepcopy
import json
import re

from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, _timestamp
from services.paired_nav_collection import allocator_source_identity, shadow_failure
from services.paired_nav_intervention import run_isolated_allocation
from services.paired_nav_opb_prior import verify_opb_prior

OWNER = 'opb_arm_prior'
SELECTION = 'paired-nav-opb-selection-v1'
_FIELDS = ('artifact_id', 'model_name', 'version', 'candidate_type', 'checksum',
    'source_run_date', 'training_run_id', 'created_at', 'state', 'offline_evidence_json')
IDENTITY_FIELDS = tuple(field for field in _FIELDS if field != 'state')


def _registered_at(value):
    # SQLite CURRENT_TIMESTAMP is explicitly UTC, unlike an artifact's arbitrary
    # timezone-free timestamp. Preserve the original database value in the seal.
    if isinstance(value, str) and re.fullmatch(r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d', value):
        value = value.replace(' ', 'T') + '+00:00'
    try:
        return _timestamp(value)
    except (TypeError, ValueError, AttributeError) as exc:
        raise ValueError('paired_nav_opb_registration_clock_invalid') from exc


def select_opb_candidates(*, query, signal_date, now=None):
    """Called only for a NEW pre-inference parent, never from a later retry."""
    date.fromisoformat(signal_date)
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError('paired_nav_timezone_required')
    rows, cursor, scanned = [], '', 0
    where = "model_name='opb_arm_prior' AND state NOT IN ('archived','rejected')"
    while True:
        page = query('SELECT * FROM model_artifact_registry WHERE ' + where
            + ' AND artifact_id>? ORDER BY artifact_id LIMIT 50', [cursor])
        if not page:
            break
        scanned += len(page)
        for row in page:
            if (_registered_at(row.get('created_at')) <= clock
                    and date.fromisoformat(row['source_run_date']).isoformat() <= signal_date):
                rows.append({key: row.get(key) for key in _FIELDS})
        cursor = page[-1]['artifact_id']
    count = query('SELECT COUNT(*) AS n FROM model_artifact_registry WHERE ' + where, [])
    if len(count) != 1 or count[0]['n'] != scanned:
        raise RuntimeError('paired_nav_opb_inventory_changed_retry')
    rows = _retain_registered_candidates(rows, signal_date=signal_date, query=query, clock=clock)
    return {'schema_version': SELECTION, 'signal_date': signal_date,
        'decision_cutoff_at': clock.isoformat(), 'registry_rows': rows}


def _retain_registered_candidates(rows, *, signal_date, query, clock):
    """An archive label is not a NAV lifecycle closure.

    Continue only actually registered, unclosed comparisons using their original
    pre-inference artifact. Never admit arbitrary archived rows or substitute the
    newest prior. State changes cannot reset evidence or the hypothesis budget.
    """
    from services.paired_nav_lifecycle import registered_pairs
    selected = {row['checksum']: row for row in rows}
    if len(selected) != len(rows):
        raise ValueError('paired_nav_opb_selection_identity_invalid')
    pinned = {}
    for registration in registered_pairs(signal_date=signal_date, query=query):
        saved = registration['allocation']
        plan = saved['payload']['content']
        if plan['owner'] != OWNER:
            continue
        parent = read_snapshot(query, plan['allocation_context_snapshot_id'])
        if (parent['manifest']['snapshot_kind'] != 'allocation_context'
                or parent['manifest']['prospective'] != 1
                or parent['manifest']['signal_date'] != saved['manifest']['signal_date']
                or _timestamp(parent['manifest']['frozen_at']) > clock):
            raise ValueError('paired_nav_registered_opb_parent_invalid')
        selection = frozen_opb_selection(parent)
        matches = [row for row in (selection or {}).get('registry_rows', [])
                   if row['checksum'] == plan['candidate_checksum']]
        if len(matches) != 1:
            raise ValueError('paired_nav_registered_opb_original_artifact_missing')
        row = matches[0]
        _artifact(row, selection)  # Original integrity/time admission, not today's status.
        if (row['artifact_id'] != plan['candidate_artifact_id']
                or row['training_run_id'] != plan['candidate_training_run_id']):
            raise ValueError('paired_nav_registered_opb_identity_conflict')
        key = row['checksum']
        for previous in (pinned.get(key), selected.get(key)):
            if previous is not None and any(previous.get(field) != row.get(field) for field in IDENTITY_FIELDS):
                raise ValueError('paired_nav_registered_opb_identity_conflict')
        pinned[key] = deepcopy(row)
    selected.update(pinned)
    return sorted(selected.values(), key=lambda row: row['artifact_id'])


def frozen_opb_selection(saved):
    selection = saved['payload']['content'].get('opb_candidate_selection')
    if selection is None:
        return None
    if selection.get('status') == 'failed':
        raise ValueError('paired_nav_opb_selection_source_failed')
    if (selection.get('schema_version') != SELECTION
            or selection.get('signal_date') != saved['manifest']['signal_date']
            or _timestamp(selection['decision_cutoff_at']) > _timestamp(saved['manifest']['frozen_at'])
            or not isinstance(selection.get('registry_rows'), list)):
        raise ValueError('paired_nav_opb_selection_invalid')
    identities, checksums = set(), set()
    for row in selection['registry_rows']:
        key, checksum = row.get('artifact_id'), row.get('checksum')
        if (not isinstance(key, str) or not key or key in identities
                or not isinstance(checksum, str) or not re.fullmatch('[0-9a-f]{64}', checksum)
                or checksum in checksums):
            raise ValueError('paired_nav_opb_selection_identity_invalid')
        identities.add(key)
        checksums.add(checksum)
    return selection


def _artifact(row, selection):
    cutoff = _timestamp(selection['decision_cutoff_at'])
    artifact = json.loads(row.get('offline_evidence_json') or 'null')
    verify_opb_prior(artifact, checksum=row['checksum'], decision_at=cutoff)
    if (row.get('model_name') != OWNER or row.get('candidate_type') != 'opb_arm_prior_refresh'
            or row.get('artifact_id') != artifact['artifact_id'] or row.get('version') != artifact['model_version']
            or row.get('source_run_date') != artifact['trained_until']
            or row.get('training_run_id') != f"opb_arm_prior_refresh:{artifact['trained_until']}:{artifact['expected_return_owner']}"
            or row.get('state') in {'archived', 'rejected'}
            or _registered_at(row.get('created_at')) > cutoff
            or artifact['trained_until'] > selection['signal_date']):
        raise ValueError('paired_nav_opb_registry_identity_invalid')
    return artifact


def _ev_identity_rows(capture):
    return capture.get('allocation_candidates') or capture.get('empty_pool_expected_return_sources') or []


def _configuration(saved):
    from services.paired_nav_candidate_collection import allocation_policy_identity
    from services.paired_nav_execution_environment import configuration_environment
    context = saved['payload']['content']
    if not context.get('risk_config') or not context.get('trading_config'):
        raise ValueError('paired_nav_full_configuration_missing')
    fields = ('expected_return_owner', 'expected_return_contract_version', 'expected_return_semantic',
              'expected_return_model_version', 'expected_return_trained_until')
    versions = set()
    for row in _ev_identity_rows(context['capture']):
        if row.get('expected_return_owner') not in {'l4_alpha_ev', 'allocator_ev_fusion'}:
            continue
        if any(not isinstance(row.get(key), str) or not row[key] for key in fields):
            raise ValueError('paired_nav_opb_serving_ev_identity_missing')
        versions.add(tuple(row[key] for key in fields))
    return {**{key: context[key] for key in ('trading_config', 'risk_config',
        'allocator_source_identity', 'formal_baseline_identity')},
        'opb_serving_ev_identity': [dict(zip(fields, values)) for values in sorted(versions)],
        'allocator_policies': allocation_policy_identity(context['inputs']),
        **configuration_environment(saved)}


def opb_dependency_wait(row, saved):
    """Known inapplicable owner != failed computation; validate prior FIRST."""
    selection = frozen_opb_selection(saved)
    artifact = _artifact(row, selection)
    context = saved['payload']['content']
    capture = context.get('capture') or {}
    contract = capture.get('allocation_contract') or {}
    owner_rows = _ev_identity_rows(capture)
    owners = {item.get('expected_return_owner') for item in owner_rows
              if item.get('expected_return_owner') in {'l4_alpha_ev', 'allocator_ev_fusion'}}
    reason = None
    if (contract.get('allocation_mode') == 'formal_ml_buy_risk_budget_continuity'
            and contract.get('allocation_utility_owner') == 'formal_ml_buy_admission' and not owners
            and context.get('formal_baseline_identity') and contract.get('continuity_admission_cannot_promote_l4') is True):
        reason = 'awaiting_formal_expected_return_owner'
    elif (contract.get('allocation_mode') == 'learned_expected_return_owner' and not owners
            and capture.get('schema_version') == 'formal-sparse-allocation-capture-v1'
            and capture.get('allocation_candidates') == []
            and capture.get('effective_weights') == {}
            and contract.get('allocation_candidate_pool_size') == 0
            and contract.get('allocation_utility_owner') == 'expected_return_owner'
            and contract.get('ml_signal_role') == 'advisory_only'
            and contract.get('final_decision_owner') == 'allocator_opb_policy'
            and context.get('formal_baseline_identity')
            and isinstance(context.get('formal_output'), list)
            and not any(item.get('selected') or item.get('has_buy_signal') or item.get('allocation_weight')
                        for item in context['formal_output'])):
        # No validated EV source, rather than merely no selected stocks. Valid
        # negative-EV/risk-off rows keep their identity and execute OPB normally.
        reason = 'awaiting_formal_expected_return_owner'
    elif (contract.get('allocation_mode') == 'learned_expected_return_owner' and len(owners) == 1
            and artifact['expected_return_owner'] not in owners):
        _configuration(saved)  # Missing actual model identity is NOT an acceptable wait.
        reason = 'awaiting_owner_compatible_expected_return'
    if reason is None:
        return None
    return {'allocation_context_snapshot_id': saved['manifest']['snapshot_id'], 'owner': OWNER,
        'candidate_checksum': row['checksum'], 'candidate_artifact_id': row['artifact_id'],
        'status': 'awaiting_dependency', 'reason': reason, 'production_effect': False,
        'promotion_allowed': False, 'nav_maturity_credit': 0}


def collect_opb_allocations(*, snapshot_id, query, writer):
    from services.paired_nav_lifecycle import resolve_pair_id, prepare_comparison_transitions
    saved = read_snapshot(query, snapshot_id)
    manifest, context = saved['manifest'], saved['payload']['content']
    base = {'plans': [], 'production_effect': False, 'promotion_allowed': False,
        'can_write_order': False, 'nav_maturity_credit': 0}
    if manifest['snapshot_kind'] != 'allocation_context':
        raise ValueError('paired_nav_allocation_context_required')
    if not manifest['prospective']:
        return {**base, 'status': 'historical_not_prospective'}
    selection = frozen_opb_selection(saved)
    if selection is None:
        return {**base, 'status': 'legacy_context_without_opb_selection'}
    if not selection['registry_rows']:
        return {**base, 'status': 'no_registered_opb_candidates'}
    if context.get('allocator_source_identity') != allocator_source_identity():
        raise ValueError('paired_nav_allocator_source_changed')
    if not context.get('formal_baseline_identity'):
        raise ValueError('paired_nav_formal_baseline_identity_missing')
    inputs = context['inputs']
    inherited = context['capture'].get('inherited_state') or {}
    if context.get('recommendation_context') is not None:
        from services.paired_nav_recommendation_path import replay_frozen_recommendation_allocation
        incumbent = replay_frozen_recommendation_allocation(snapshot_id=snapshot_id, query=query)['allocation']
    else:
        incumbent = run_isolated_allocation(inputs=inputs, inherited_state=inherited)
    if incumbent['output'] != context['formal_output']:
        raise ValueError('paired_nav_opb_incumbent_replay_mismatch')
    configuration = _configuration(saved)
    config_checksum = digest(configuration)
    # Bind the entire incumbent allocator policy (including its exact EV model),
    # not daily forecasts/returns and not just the upstream ML bundle pointer.
    baseline_checksum = digest(['paired-nav-opb-incumbent-v1', config_checksum])
    plans, failures, transitions, pending = [], [], [], []
    for row in selection['registry_rows']:
        stage = 'opb_prior_load'
        try:
            artifact = _artifact(row, selection)
            waiting = opb_dependency_wait(row, saved)
            if waiting is not None:
                pending.append(waiting)
                continue
            stage = 'opb_candidate_allocation'
            candidate = run_isolated_allocation(inputs=inputs, inherited_state=inherited,
                owner=OWNER, candidate_checksum=row['checksum'], opb_prior=artifact,
                decision_at=_timestamp(selection['decision_cutoff_at']))
            root = digest([OWNER, row['checksum'], baseline_checksum, config_checksum])
            pair_id = resolve_pair_id(root, signal_date=manifest['signal_date'], query=query)
            stage = 'opb_candidate_seal'
            receipt = freeze_snapshot(signal_date=manifest['signal_date'], source_run_id=pair_id,
                snapshot_kind='allocation_pair', query=query, writer=writer, content={
                    'pair_id': pair_id, 'root_pair_id': root, 'owner': OWNER,
                    'candidate_checksum': row['checksum'], 'baseline_checksum': baseline_checksum,
                    'candidate_artifact_id': row['artifact_id'], 'candidate_training_run_id': row['training_run_id'],
                    'allocation_context_snapshot_id': snapshot_id, 'configuration': configuration,
                    'configuration_checksum': config_checksum, 'allocation_input_checksum': digest(inputs),
                    'model_predictions_checksum': digest(context.get('model_predictions')),
                    'baseline': incumbent, 'candidate': candidate,
                    'production_effect': False, 'promotion_allowed': False, 'can_write_order': False,
                    'nav_maturity_credit': 0})
            item = {'snapshot_id': receipt['snapshot_id'], 'pair_id': pair_id, 'owner': OWNER}
            stage = 'opb_lifecycle_prepare'
            changes = prepare_comparison_transitions(plans=[item], signal_date=manifest['signal_date'], query=query)
            transitions.extend(changes)
            plans.append(item)
        except Exception as exc:
            failures.append({**shadow_failure(stage, exc), 'owner': OWNER,
                'candidate_checksum': row['checksum'], 'candidate_artifact_id': row['artifact_id']})
    return {**base, 'plans': plans,
        'status': ('partial_allocation_pairs' if plans else 'candidate_allocations_failed') if failures else (
            'allocation_pairs_frozen' if plans else 'awaiting_opb_dependency'),
        'lifecycle_transition_plan': transitions, 'lifecycle_transitions': [],
        **({'pending_dependencies': pending} if pending else {}),
        **({'candidate_failures': failures} if failures else {})}


def verify_opb_comparison(plan, parent):
    selection = frozen_opb_selection(parent)
    rows = [row for row in (selection or {}).get('registry_rows', []) if row['checksum'] == plan['candidate_checksum']]
    if len(rows) != 1:
        raise ValueError('paired_nav_opb_comparison_candidate_missing')
    artifact = _artifact(rows[0], selection)
    context = parent['payload']['content']
    config = _configuration(parent)
    candidate = plan['candidate']
    capture = candidate.get('capture') or {}
    packet = capture.get('opb_packet') or {}
    contract = capture.get('allocation_contract') or {}
    if (plan['configuration'] != config
            or plan['baseline_checksum'] != digest(['paired-nav-opb-incumbent-v1', digest(config)])
            or plan['baseline']['output'] != context['formal_output']
            or plan['allocation_input_checksum'] != digest(context['inputs'])
            or candidate.get('input_checksum') != plan['allocation_input_checksum']
            or candidate.get('candidate_checksum') != rows[0]['checksum'] or candidate.get('owner') != OWNER
            or plan.get('candidate_artifact_id') != artifact['artifact_id']
            or plan.get('candidate_training_run_id') != rows[0]['training_run_id']
            or any(candidate.get(flag) is not False for flag in ('production_effect', 'promotion_allowed', 'can_write_order'))
            or packet.get('status') != 'ok' or packet.get('stage') != 'isolated_nav_candidate_allocation'
            or (packet.get('prior_artifact') or {}).get('candidate_checksum') != rows[0]['checksum']
            or contract.get('controller_effective') != 'OnlinePortfolioBandit'
            or contract.get('opb_production_control_allowed') is not False):
        raise ValueError('paired_nav_opb_comparison_identity_mismatch')
