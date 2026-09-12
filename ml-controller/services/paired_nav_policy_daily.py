"""Original Atomic/route policy inventory -> the shared daily NAV decision.

No surrogate return, registry table, policy writer, training or promotion here.
Policies are executable frozen comparisons, not model-registry artifacts.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone

from services.paired_nav_candidate_decision import read_nav_candidate_decision, NavCandidateDecisionReadScope
from services.paired_nav_comparison import resolve_allocation_comparison
from services.paired_nav_journal import digest, _timestamp
from services.paired_nav_population import _manifest_rows


OWNERS = {'atomic_strategy', 'l15_route'}


def _definitions(owner, saved):
    context = saved['payload']['content']
    if context.get('upstream_allocation_context_snapshot_id'):
        return {}  # Atomic model-arm parents repeat the original source, not admissions.
    if owner == 'atomic_strategy':
        from services.paired_nav_atomic_policy import validate_atomic_policy
        prepared = context.get('atomic_recommendation_inputs')
        if prepared is None:
            return {}
        if not isinstance(prepared, dict) or not isinstance(prepared.get('definitions'), dict):
            raise ValueError('nav_policy_original_definitions_missing')
        population = prepared.get('policy_population') or {}
        if not prepared['definitions'] and not population.get('replacements'):
            return {}
        policy = validate_atomic_policy(population)
        if set(policy['definitions']) != set(prepared['definitions']):
            raise ValueError('nav_policy_original_population_changed')
        if prepared.get('input_hash') != digest({k: v for k, v in prepared.items() if k != 'input_hash'}):
            raise ValueError('nav_policy_original_inputs_changed')
        return policy['definitions']
    from services.paired_nav_route_effect import frozen_route_source
    from services.paired_nav_route_candidate import route_identity
    source = frozen_route_source(saved)
    if source['status'] == 'unavailable_legacy_route_inputs':
        return {}
    if source['status'] != 'pit_route_source_verified':
        raise ValueError('nav_policy_original_route_source_invalid')
    definition = {key: source[key] for key in ('challenger_version', 'slate_builder_version')}
    return {route_identity(definition['challenger_version'], definition['slate_builder_version']): definition}


def frozen_policy_inventory(*, owner, business_date, query, now):
    if owner not in OWNERS:
        raise ValueError('nav_policy_owner_invalid')
    items = {}
    for saved in _manifest_rows(query, business_date, 'allocation_context', 50):
        for checksum, definition in _definitions(owner, saved).items():
            manifest = saved['manifest']
            if _timestamp(manifest['frozen_at']) > now:
                raise ValueError('nav_policy_original_source_in_future')
            artifact_id = (owner + ':' + definition['challenger_version'] + ':' + checksum
                           if owner == 'l15_route' else owner + ':' + checksum)
            item = items.setdefault(checksum, {'owner': owner, 'candidate_checksum': checksum,
                'candidate_artifact_id': artifact_id, 'definition': deepcopy(definition),
                'source_snapshot_ids': [], 'allocation_snapshot_ids': [],
                'source_run_date': manifest['signal_date']})
            if item['definition'] != definition or item['candidate_artifact_id'] != artifact_id:
                raise ValueError('nav_policy_original_definition_conflict')
            item['source_run_date'] = min(item['source_run_date'], manifest['signal_date'])
            item['source_snapshot_ids'].append(manifest['snapshot_id'])
    for saved in _manifest_rows(query, business_date, 'allocation_pair', 50):
        plan, manifest = saved['payload']['content'], saved['manifest']
        if plan.get('owner') != owner:
            continue
        if _timestamp(manifest['frozen_at']) > now:
            raise ValueError('nav_policy_original_allocation_in_future')
        resolve_allocation_comparison(query=query, allocation=saved)
        checksum = plan['candidate_checksum']
        item = items.setdefault(checksum, {'owner': owner, 'candidate_checksum': checksum,
            'candidate_artifact_id': plan['candidate_artifact_id'], 'definition': None,
            'source_snapshot_ids': [], 'allocation_snapshot_ids': [],
            'source_run_date': manifest['signal_date']})
        if item['candidate_artifact_id'] != plan['candidate_artifact_id']:
            raise ValueError('nav_policy_original_allocation_identity_changed')
        item['allocation_snapshot_ids'].append(manifest['snapshot_id'])
    return [items[key] for key in sorted(items)]


def _clock(business_date, now):
    clock = now or datetime.now(timezone.utc)
    day = date.fromisoformat(business_date)
    if (clock.tzinfo is None or clock.utcoffset() is None or day.isoformat() != business_date
            or day > clock.astimezone(timezone(timedelta(hours=8))).date()):
        raise ValueError('nav_policy_daily_time_invalid')
    return clock


def _require_source(item):
    if item['definition'] is None or not item['source_snapshot_ids']:
        raise ValueError('nav_policy_original_admission_missing')
    if not item['allocation_snapshot_ids']:
        raise ValueError('nav_policy_original_allocation_missing')


def _decision_payload(item, nav, business_date):
    return {'artifact_id': item['candidate_artifact_id'],
        'artifact_checksum': item['candidate_checksum'],
        'policy_definition': deepcopy(item['definition']),
        'source_run_date': item['source_run_date'],
        'evaluation_business_date': business_date,
        'prospective_validation': {'decision': nav['decision'], 'nav_validation': nav}}


def read_policy_candidate_decision(*, owner, candidate_artifact_id, candidate_checksum,
                                  business_date, query, now=None):
    """Re-read original policy authority; caller supplies identity, never a verdict.

    The complete inventory is retained. This does not publish, reserve another
    review, infer current registry state, or turn PENDING/HOLD into an approval.
    """
    clock = _clock(business_date, now)
    inventory = frozen_policy_inventory(owner=owner, business_date=business_date, query=query, now=clock)
    matches = [item for item in inventory if item['candidate_artifact_id'] == candidate_artifact_id
               and item['candidate_checksum'] == candidate_checksum]
    if len(matches) != 1:
        raise ValueError('nav_policy_requested_identity_missing')
    item = matches[0]
    _require_source(item)
    nav = read_nav_candidate_decision(owner=owner, candidate_artifact_id=candidate_artifact_id,
        candidate_checksum=candidate_checksum, business_date=business_date, query=query, now=clock)
    return _decision_payload(item, nav, business_date)


def _refresh(*, owner, business_date, query, now=None, adoption_candidates=None):
    clock = _clock(business_date, now)
    inventory = frozen_policy_inventory(owner=owner, business_date=business_date, query=query, now=clock)
    decisions, failures = [], []
    for item in inventory:
        identity = {key: item[key] for key in ('owner', 'candidate_artifact_id', 'candidate_checksum')}
        stage = 'original_source'
        try:
            _require_source(item)
            stage = 'decision'
            nav = read_nav_candidate_decision(**identity, business_date=business_date, query=query, now=clock)
            decisions.append({**identity, 'decision': nav['decision'], 'reason': nav['reason'],
                'nav_decision_checksum': nav['decision_checksum'],
                'evaluable_date_count': nav.get('evaluable_date_count', 0)})
            if adoption_candidates is not None:
                adoption_candidates.append({'owner': owner, 'registry_state': 'candidate',
                    'registry_state_source': 'original_frozen_policy_contrast_not_model_registry',
                    'payload': _decision_payload(item, nav, business_date)})
        except Exception as exc:
            reason = str(exc) if stage == 'original_source' else 'nav_policy_primary_evaluation_failed'
            failures.append({**identity, 'stage': stage, 'reason': reason, 'error_type': type(exc).__name__})
    return {'schema_version': 'paired-nav-daily-candidates-v1', 'owner': owner,
        'as_of_date': business_date, 'status': 'partial_nav_candidate_decisions' if failures else 'nav_candidate_decisions_current',
        'inventory_checksum': digest(inventory), 'candidate_count': len(inventory),
        'evaluated_count': len(decisions), 'failure_count': len(failures),
        'decisions': decisions, 'decisions_checksum': digest(decisions), 'failures': failures,
        'registry_state_unchanged': True, 'promotion_allowed': False}


def refresh_registered_atomic_nav_decisions(**kwargs):
    return _refresh(owner='atomic_strategy', **kwargs)


def refresh_registered_route_nav_decisions(**kwargs):
    return _refresh(owner='l15_route', **kwargs)


def read_strategy_nav_evidence(*, strategy_id, strategy_version, business_date, query, now=None):
    """On-demand strategy display, using the SAME original policy/NAV reader.

    Never evaluates a new statistical review or writes a projection. A request-
    local read cache shares immutable source reads between all matching policies;
    it is not persisted and cannot serve a different date/request.
    """
    clock = _clock(business_date, now)
    cached = {}

    def read(sql, params):
        key = (sql, digest(params))
        if key not in cached:
            cached[key] = deepcopy(query(sql, params))
        return deepcopy(cached[key])

    inventory = frozen_policy_inventory(owner='atomic_strategy', business_date=business_date,
        query=read, now=clock)
    decisions = NavCandidateDecisionReadScope(query=read, business_date=business_date, now=clock)
    entries = []
    for item in inventory:
        definition = item['definition']
        if definition is None:
            # An orphan allocation cannot be silently assigned to another strategy.
            raise ValueError('nav_policy_original_admission_missing')
        roles = [role for role in ('candidate', 'incumbent')
            if definition[role]['id'] == strategy_id and definition[role]['version'] == strategy_version]
        if not roles:
            continue
        entry = {'artifact_id': item['candidate_artifact_id'], 'artifact_checksum': item['candidate_checksum'],
            'source_run_date': item['source_run_date'], 'policy_definition': deepcopy(definition),
            'strategy_roles': roles, 'status': 'available', 'error': None, 'nav': None}
        try:
            _require_source(item)
            entry['nav'] = decisions.read(owner='atomic_strategy',
                candidate_artifact_id=item['candidate_artifact_id'], candidate_checksum=item['candidate_checksum'],
            )
        except (ValueError, RuntimeError, KeyError, TypeError) as exc:
            entry['status'] = 'unavailable'
            entry['error'] = str(exc) if str(exc).startswith('nav_policy_') else 'nav_policy_original_evidence_unavailable'
        entries.append(entry)
    return {'schema_version': 'strategy-nav-evidence-v1', 'strategy_id': strategy_id,
        'strategy_version': strategy_version, 'as_of_date': business_date, 'observed_at': clock.isoformat(),
        'source': 'original_frozen_policy_and_verified_nav', 'read_only': True, 'promotion_allowed': False,
        'status': 'unavailable' if any(e['status'] != 'available' for e in entries)
            else 'available' if entries else 'not_registered',
        'entries': entries, 'entry_count': len(entries)}
