"""Daily transport of the original NAV verdict through the existing serving owner.

No new evaluator, statistical threshold, history writer or training dispatch.
Selection is deterministic oldest ready frozen candidate, never highest return.
Production entries request verified projection recovery, not new qualification.
"""
from services.expected_return_candidate_forward_evaluator import (
    ACTIVE_CANDIDATE_STATES, ELIGIBLE_CANDIDATE_STATES, OBSERVABLE_REJECTED_CANDIDATE_STATES,
)

EV_OWNERS = ('l4_alpha_ev', 'allocator_ev_fusion')
OPB_OWNER = 'opb_arm_prior'
L3_OWNER = 'ensemble'
ROUTE_OWNER = 'l15_route'
ATOMIC_OWNER = 'atomic_strategy'
OWNERS = (*EV_OWNERS, OPB_OWNER, L3_OWNER, ROUTE_OWNER, ATOMIC_OWNER)


def nav_worker_timeout(controller_reads):
    """Finite transport allowance, NOT an efficacy gate or successful receipt.

    Match the original Worker's nested Controller read timeout. Counts at call
    sites include preflight, commit and projection/recovery rechecks. An outer
    30-second request must not expire before a permitted 60-second inner read.
    """
    import json
    from pathlib import Path
    policy = json.loads(Path(__file__).with_name('paired_nav_transport_policy.json').read_text(encoding='utf-8'))
    if type(controller_reads) is not int or controller_reads < 0:
        raise ValueError('nav_transport_read_count_invalid')
    return float(policy['worker_operation_overhead_seconds']
                 + controller_reads * policy['controller_read_timeout_seconds'])


def select_daily_adoption_requests(candidates):
    eligible_states = (ACTIVE_CANDIDATE_STATES | ELIGIBLE_CANDIDATE_STATES
                       | OBSERVABLE_REJECTED_CANDIDATE_STATES) - {'production'}
    requested, waiting = {}, []
    for owner in OWNERS:
        items = [item for item in candidates if item['owner'] == owner]
        production = [item for item in items if item['registry_state'] == 'production']
        if len(production) > 1:
            raise ValueError('nav_adoption_multiple_production_candidates')
        owner_states = eligible_states | ({'candidate'} if owner in {L3_OWNER, ROUTE_OWNER, ATOMIC_OWNER} else set())
        ready = sorted((item for item in items if item['registry_state'] in owner_states
            and item['payload']['prospective_validation']['decision'] == 'PASS'),
            key=lambda item: (item['payload']['source_run_date'], item['payload']['artifact_id']))
        selected = ready[0] if ready else production[0] if production else None
        if selected:
            requested[owner] = selected['payload']
    l4, fusion = requested.get(OWNERS[0]), requested.get(OWNERS[1])
    if l4 and fusion:
        base = fusion['prospective_validation']['nav_validation'].get('baseline_checksum')
        # A production recovery does not need today's NAV comparison. New Fusion
        # adoption does, and Worker still verifies its exact committed L4 baseline.
        fusion_recovery = any(item['owner'] == OWNERS[1] and item['registry_state'] == 'production'
            and item['payload']['artifact_id'] == fusion['artifact_id'] for item in candidates)
        if not fusion_recovery and base != l4['artifact_checksum']:
            waiting.append({'owner': OWNERS[1], 'artifact_id': fusion['artifact_id'],
                            'reason': 'exact_l4_dependency_not_selected'})
            requested.pop(OWNERS[1])
    return requested, waiting


async def run_daily_ev_adoption(*, candidates, business_date):
    from routers.walk_forward import _candidate_forward_promotion_closure, _refresh_expected_return_opb
    from services.worker_config_client import worker_fetch

    result = {'status': 'incomplete', 'as_of_date': business_date,
              'requested_artifacts': {}, 'waiting': [], 'training_dispatched': False}
    stage = 'selection'
    try:
        atomic = [item for item in candidates if item['owner'] == ATOMIC_OWNER]
        if atomic:
            stage = 'atomic_reconciliation'
            if any(item['payload'].get('evaluation_business_date') != business_date for item in atomic):
                return {**result, 'stage': stage, 'reason': 'nav_atomic_evaluation_date_changed'}
            request = {'business_date': business_date, 'candidates': [dict(
                artifact_id=item['payload']['artifact_id'], artifact_checksum=item['payload']['artifact_checksum'],
                baseline_checksum=item['payload']['prospective_validation']['nav_validation'].get('baseline_checksum'))
                for item in atomic]}
            if any(item['payload']['prospective_validation']['decision'] == 'PASS'
                   and not item['payload']['prospective_validation']['nav_validation'].get('baseline_checksum') for item in atomic):
                raise ValueError('nav_atomic_reconciliation_pass_baseline_missing')
            response = await worker_fetch('/api/admin/config/strategy-atomic/reconcile', method='POST',
                                          json_body=request, timeout=nav_worker_timeout(3 * len(atomic)))
            atomic_request = request
            candidates, reconciliation = apply_atomic_reconciliation(candidates, request, response)
            result['atomic_reconciliation'] = reconciliation
            result['waiting'].extend(_atomic_waiting(reconciliation))
            stage = 'selection'
        routes = [item for item in candidates if item['owner'] == ROUTE_OWNER]
        if routes:
            stage = 'route_reconciliation'
            if any(item['payload'].get('evaluation_business_date') != business_date for item in routes):
                return {**result, 'stage': stage, 'reason': 'nav_route_evaluation_date_changed'}
            request = {'business_date': business_date, 'candidates': [dict(
                artifact_id=item['payload']['artifact_id'], artifact_checksum=item['payload']['artifact_checksum'])
                for item in routes]}
            route_request = request
            response = await worker_fetch('/api/admin/config/strategy-route/reconcile', method='POST',
                                          json_body=request, timeout=nav_worker_timeout(2 * len(routes)))
            candidates, reconciliation = apply_route_reconciliation(candidates, request, response)
            result['route_reconciliation'] = reconciliation
            result['waiting'].extend(_route_waiting(reconciliation))
            stage = 'selection'
        # Newly connected daily owners must never disappear as no_adoption_due.
        # Keep supported-owner progress, but disclose unfinished publication
        # plumbing until that owner's verified transaction is connected.
        # L3's immutable registry calls an admitted candidate "candidate", not
        # EV's "shadowing". Do not erase a real ready owner from closure merely
        # because its registry has a different lifecycle vocabulary.
        eligible_states = ACTIVE_CANDIDATE_STATES | ELIGIBLE_CANDIDATE_STATES | OBSERVABLE_REJECTED_CANDIDATE_STATES | {'candidate'}
        unhandled = [{'owner': item['owner'], 'artifact_id': item['payload']['artifact_id']}
            for item in candidates if item['owner'] not in OWNERS
            and (item['registry_state'] == 'production' or item['registry_state'] in eligible_states
                and item['payload']['prospective_validation']['decision'] == 'PASS')]
        if unhandled:
            result.update(unhandled_ready_candidates=unhandled,
                          reason='nav_adoption_owner_unhandled', stage='owner_publication')
        requested, waiting = select_daily_adoption_requests(candidates)
        result['waiting'].extend(waiting)
        result['requested_artifacts'] = {owner: p['artifact_id'] for owner, p in requested.items()}
        if not requested:
            return result if unhandled else {**result, 'status': 'no_adoption_due'}
        ev_requested = {owner: p for owner, p in requested.items() if owner in EV_OWNERS}
        if ev_requested:
            stage = 'pointer_and_projection'
            response = await worker_fetch('/api/admin/config/expected-return/promote', method='POST',
                                          json_body=ev_requested, timeout=nav_worker_timeout(2 * len(ev_requested)))
            closure = _candidate_forward_promotion_closure(ev_requested, response, business_date=business_date)
            result['closure'] = closure
            result['waiting'].extend({'owner': owner, 'artifact_id': ev_requested[owner]['artifact_id'],
                'state': value['state'], 'reason': value['reason'],
                'observation_checksum': value['observation_checksum']}
                for owner, value in closure['waiting_by_owner'].items())
            if not closure['processing_complete']:
                return {**result, 'stage': stage, 'reason': 'nav_adoption_projection_incomplete'}
            result['opb_candidate_registration'] = {'status': 'no_effective_owner_change'}
            if closure['promoted_any']:
                stage = 'opb_candidate_registration'
                owner = response.get('effective_owner')
                if owner not in EV_OWNERS:
                    return {**result, 'stage': stage, 'reason': 'nav_effective_owner_unverified'}
                outcome = (response.get('outcomes') or {}).get(owner)
                if outcome is not None:
                    from datetime import date
                    review_date = (outcome.get('pointer_commit') or {}).get('nav_review_date')
                    if (not isinstance(review_date, str) or date.fromisoformat(review_date).isoformat() != review_date
                            or review_date > business_date):
                        return {**result, 'stage': stage, 'reason': 'nav_adoption_event_date_unverified'}
                    # Registration only; recover immutable bytes for the original event date.
                    result['opb_candidate_registration'] = await _refresh_expected_return_opb(review_date, owner)
        result['opb'] = {'status': 'no_adoption_due'}
        if OPB_OWNER in requested:
            stage = 'opb_publication'
            # Consume the original mature candidate, never rebuild today's prior
            # and immediately require it to have already passed prospective NAV.
            payload = requested[OPB_OWNER]
            response = await worker_fetch('/api/admin/config/opb/promote', method='POST',
                                          json_body=payload, timeout=nav_worker_timeout(5))
            comparison = opb_comparison_wait(payload, response, business_date=business_date)
            retirement = opb_retirement_receipt(payload, response, business_date=business_date)
            if retirement is not None:
                result['opb'] = retirement
            elif comparison is not None:
                if any(item['owner'] == OPB_OWNER and item['registry_state'] == 'production'
                       and item['payload']['artifact_id'] == payload['artifact_id'] for item in candidates):
                    raise ValueError('nav_opb_published_candidate_cannot_be_observation_wait')
                result['opb'] = {**response, 'complete': False}
                result['waiting'].append({'owner': OPB_OWNER, 'artifact_id': payload['artifact_id'],
                    'state': comparison['state'], 'reason': comparison['reason'],
                    'observation_checksum': comparison['observation_checksum']})
            else:
                result['opb'] = opb_adoption_receipt(payload, response)
                if not result['opb']['complete']:
                    return {**result, 'stage': stage, 'reason': 'nav_opb_adoption_incomplete'}
        if L3_OWNER in requested:
            stage = 'ensemble_publication'
            result['ensemble'] = await adopt_daily_ensemble(requested[L3_OWNER], business_date)
            if result['ensemble'].get('status') == 'waiting':
                if any(item['owner'] == L3_OWNER and item['registry_state'] == 'production'
                       and item['payload']['artifact_id'] == requested[L3_OWNER]['artifact_id'] for item in candidates):
                    raise ValueError('nav_ensemble_published_candidate_cannot_be_observation_wait')
                comparison = result['ensemble']['comparison']
                result['waiting'].append({'owner': L3_OWNER, 'artifact_id': requested[L3_OWNER]['artifact_id'],
                    'state': comparison['state'], 'reason': comparison['reason'],
                    'observation_checksum': comparison['observation_checksum']})
            elif not result['ensemble']['complete']:
                return {**result, 'stage': stage, 'reason': 'nav_ensemble_adoption_incomplete'}
        if routes and (ev_requested or OPB_OWNER in requested or L3_OWNER in requested):
            # Earlier owners can change the ML/config baseline after initial
            # eligibility. Re-read the original Route owner before selecting it.
            stage = 'route_post_dependency_reconciliation'
            response = await worker_fetch('/api/admin/config/strategy-route/reconcile', method='POST',
                                          json_body=route_request, timeout=nav_worker_timeout(2 * len(routes)))
            candidates, reconciliation = apply_route_reconciliation(candidates, route_request, response)
            result['route_post_dependency_reconciliation'] = reconciliation
            result['waiting'] = [row for row in result['waiting'] if row['owner'] != ROUTE_OWNER]
            result['waiting'].extend(_route_waiting(reconciliation))
            requested.pop(ROUTE_OWNER, None)
            result['requested_artifacts'].pop(ROUTE_OWNER, None)
            refreshed, _ = select_daily_adoption_requests([item for item in candidates if item['owner'] == ROUTE_OWNER])
            if ROUTE_OWNER in refreshed:
                requested[ROUTE_OWNER] = refreshed[ROUTE_OWNER]
                result['requested_artifacts'][ROUTE_OWNER] = refreshed[ROUTE_OWNER]['artifact_id']
        if ROUTE_OWNER in requested:
            stage = 'route_publication'
            payload = requested[ROUTE_OWNER]
            if payload.get('evaluation_business_date') != business_date:
                return {**result, 'stage': stage, 'reason': 'nav_route_evaluation_date_changed'}
            response = await worker_fetch('/api/admin/config/strategy-route/promote', method='POST',
                                          json_body=payload, timeout=nav_worker_timeout(4))
            result['route'] = route_adoption_receipt(payload, response)
            if not result['route']['complete']:
                return {**result, 'stage': stage, 'reason': 'nav_route_adoption_incomplete'}
        if atomic and (ev_requested or any(owner in requested for owner in (OPB_OWNER, L3_OWNER, ROUTE_OWNER))):
            # ANY upstream publication can invalidate the original Atomic
            # comparator, even when no Route is ready. Read the existing owner
            # once after all upstream operations; preserve the historical NAV.
            stage = ('atomic_post_route_reconciliation' if ROUTE_OWNER in requested
                     else 'atomic_post_dependency_reconciliation')
            response = await worker_fetch('/api/admin/config/strategy-atomic/reconcile', method='POST',
                                          json_body=atomic_request, timeout=nav_worker_timeout(3 * len(atomic)))
            candidates, reconciliation = apply_atomic_reconciliation(candidates, atomic_request, response)
            result[stage] = reconciliation
            requested.pop(ATOMIC_OWNER, None)
            result['requested_artifacts'].pop(ATOMIC_OWNER, None)
            refreshed, _ = select_daily_adoption_requests([item for item in candidates if item['owner'] == ATOMIC_OWNER])
            selected = refreshed.get(ATOMIC_OWNER)
            result['waiting'] = [row for row in result['waiting'] if row['owner'] != ATOMIC_OWNER]
            result['waiting'].extend(_atomic_waiting(reconciliation))
            if selected:
                requested[ATOMIC_OWNER] = selected
                result['requested_artifacts'][ATOMIC_OWNER] = selected['artifact_id']
        if ATOMIC_OWNER in requested:
            stage = 'atomic_publication'
            payload = requested[ATOMIC_OWNER]
            if payload.get('evaluation_business_date') != business_date:
                return {**result, 'stage': stage, 'reason': 'nav_atomic_evaluation_date_changed'}
            response = await worker_fetch('/api/admin/config/strategy-atomic/promote', method='POST',
                                          json_body=payload, timeout=nav_worker_timeout(3))
            result['atomic'] = atomic_adoption_receipt(payload, response)
            if not result['atomic']['complete']:
                return {**result, 'stage': stage, 'reason': 'nav_atomic_adoption_incomplete'}
        return result if unhandled else {**result, 'status': 'completed'}
    except Exception as exc:
        return {**result, 'stage': stage, 'reason': 'nav_daily_adoption_incomplete',
                'error_type': type(exc).__name__}


def apply_atomic_reconciliation(candidates, request, response):
    """Validate read-only lifecycle transport; never mint a numerical PASS."""
    from copy import deepcopy
    from services.paired_nav_journal import digest
    response = response if isinstance(response, dict) else {}
    entries = response.get('entries')
    identities = {(row['artifact_id'], row['artifact_checksum']) for row in request['candidates']}
    states = {'candidate', 'published', 'published_superseded', 'baseline_changed', 'awaiting_current_source', 'observing'}
    if (response.get('schema_version') != 'strategy-atomic-nav-reconciliation-v1'
            or response.get('complete') is not True or response.get('read_only') is not True
            or response.get('owner') != ATOMIC_OWNER or response.get('as_of_date') != request['business_date']
            or response.get('source') != 'original_atomic_registry_policy_and_receipts'
            or response.get('request_checksum') != digest(request)
            or not isinstance(entries, list) or len(entries) != len(identities)
            or any(not isinstance(row, dict) or row.get('state') not in states for row in entries)
            or {(row.get('artifact_id'), row.get('artifact_checksum')) for row in entries} != identities
            or response.get('entries_checksum') != digest(entries)
            or response.get('promotion_allowed') is not False
            or type(response.get('nav_maturity_credit')) is not int or response['nav_maturity_credit'] != 0):
        raise ValueError('nav_atomic_reconciliation_invalid')
    def sealed(value):
        return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)
    if (not all(sealed(response.get(key)) for key in ('current_registry_checksum', 'canonical_source_checksum', 'canonical_policy_checksum', 'route_dependency_checksum'))
            or type(response.get('route_dependency_matches_canonical')) is not bool
            or response['route_dependency_matches_canonical'] is False and any(row['state'] == 'candidate' for row in entries)):
        raise ValueError('nav_atomic_reconciliation_source_invalid')
    by_id = {row['artifact_id']: row for row in entries}
    output = deepcopy(candidates)
    for item in output:
        if item['owner'] != ATOMIC_OWNER or item['payload']['artifact_id'] not in by_id:
            continue
        row = by_id[item['payload']['artifact_id']]
        if not row['state'].startswith('published'):
            expected = item['payload']['prospective_validation']['nav_validation'].get('decision_checksum')
            if not sealed(expected) or row.get('decision_checksum') != expected:
                raise ValueError('nav_atomic_reconciliation_decision_changed')
            if row['state'] != 'observing' and not sealed(row.get('context_checksum')):
                raise ValueError('nav_atomic_reconciliation_context_missing')
        if row['state'].startswith('published') and (not sealed(row.get('publication_receipt_checksum'))
                or not sealed(row.get('policy_checksum')) or not isinstance(row.get('supersession_receipt_checksums'), list)
                or not all(sealed(value) for value in row['supersession_receipt_checksums'])):
            raise ValueError('nav_atomic_reconciliation_publication_invalid')
        if row['state'] == 'published_superseded' and not row['supersession_receipt_checksums']:
            raise ValueError('nav_atomic_reconciliation_supersession_missing')
        if row['state'].startswith('published'):
            verify_screener_observation(row.get('execution_observation'), owner=ATOMIC_OWNER,
                artifact_id=row['artifact_id'], artifact_checksum=row['artifact_checksum'],
                publication_receipt_checksum=row['publication_receipt_checksum'], business_date=request['business_date'])
        item['registry_state'] = row['state']
        item['registry_state_source'] = 'verified_original_atomic_publication_reconciliation'
    return output, response


def atomic_adoption_receipt(payload, response):
    """Publication transport only; execution is a separate observed event."""
    import math
    from services.paired_nav_journal import _timestamp
    response = response if isinstance(response, dict) else {}
    policy = response.get('policy') if isinstance(response.get('policy'), dict) else {}
    weights = policy.get('weights') if isinstance(policy.get('weights'), dict) else {}
    def sealed(value):
        return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)
    try:
        _timestamp(policy['created_at'])
        from datetime import date
        cutoff = date.fromisoformat(policy['knowledge_cutoff_date'])
        time_valid = cutoff.isoformat() == policy['knowledge_cutoff_date'] and cutoff.isoformat() <= payload['evaluation_business_date']
    except (KeyError, TypeError, ValueError, AttributeError):
        time_valid = False
    replacement = payload['policy_definition']['replacement']
    weights_valid = (bool(weights) and {replacement['candidateId'], replacement['incumbentId']} <= set(weights)
        and all(type(value) in (int, float) and math.isfinite(value) and value >= 0 for value in weights.values())
        and weights.get(replacement['incumbentId']) == 0)
    complete = (response.get('complete') is True and response.get('owner') == ATOMIC_OWNER
        and response.get('completion_scope') == 'publication'
        and response.get('source') == 'original_registry_and_policy_reader'
        and response.get('artifact_id') == payload['artifact_id']
        and response.get('artifact_checksum') == payload['artifact_checksum']
        and response.get('pointer_committed') is True and response.get('serving_readers_verified') is True
        and sealed(response.get('publication_receipt_checksum')) and sealed(policy.get('checksum'))
        and time_valid and weights_valid)
    return {**response, 'complete': complete, 'serving_activation_verified': False}


def _atomic_waiting(response):
    return [{'owner': ATOMIC_OWNER, 'artifact_id': row['artifact_id'], 'state': row['state'], 'reason': row['reason']}
        for row in response.get('entries', []) if row['state'] in {'baseline_changed', 'awaiting_current_source'}]


def _route_waiting(response):
    return [{'owner': ROUTE_OWNER, 'artifact_id': row['artifact_id'], 'state': row['state'], 'reason': row['reason']}
        for row in response.get('entries', []) if row['state'] == 'baseline_changed']


def apply_route_reconciliation(candidates, request, response):
    from copy import deepcopy
    from services.paired_nav_journal import digest
    response = response if isinstance(response, dict) else {}
    body = {key: value for key, value in response.items() if key != 'reconciliation_checksum'}
    if (response.get('schema_version') != 'strategy-route-nav-reconciliation-v1'
            or response.get('complete') is not True or response.get('read_only') is not True
            or response.get('owner') != ROUTE_OWNER or response.get('business_date') != request['business_date']
            or response.get('source') != 'original_route_head_and_canonical_selection'
            or response.get('request_checksum') != digest(request) or response.get('reconciliation_checksum') != digest(body)
            or response.get('promotion_allowed') is not False or type(response.get('nav_maturity_credit')) is not int
            or response['nav_maturity_credit'] != 0 or 'publication' not in response):
        raise ValueError('nav_route_reconciliation_invalid')
    output = deepcopy(candidates)
    if 'candidates' in request:
        entries = response.get('entries')
        identities = {(item['artifact_id'], item['artifact_checksum']) for item in request['candidates']}
        def sealed(value):
            return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)
        if (not isinstance(entries, list) or len(entries) != len(identities)
                or any(not isinstance(row, dict) or row.get('state') not in {'candidate', 'observing', 'baseline_changed', 'published'}
                    or not isinstance(row.get('reason'), str) for row in entries)
                or {(row.get('artifact_id'), row.get('artifact_checksum')) for row in entries} != identities
                or response.get('entries_checksum') != digest(entries)):
            raise ValueError('nav_route_reconciliation_inventory_invalid')
        by_id = {row['artifact_id']: row for row in entries}
        for item in output:
            if item['owner'] != ROUTE_OWNER:
                continue
            row = by_id[item['payload']['artifact_id']]
            if row['state'] != 'published' and (not sealed(row.get('decision_checksum'))
                    or row['decision_checksum'] != item['payload']['prospective_validation']['nav_validation'].get('decision_checksum')
                    or row['state'] != 'observing' and not sealed(row.get('context_checksum'))):
                raise ValueError('nav_route_reconciliation_decision_changed')
            if row['state'] == 'published' and (response.get('publication') or {}).get('artifact_id') != row['artifact_id']:
                raise ValueError('nav_route_reconciliation_publication_missing')
            item['registry_state'] = row['state']
            item['registry_state_source'] = 'verified_original_route_publication_reconciliation'
            item['registry_state_reason'] = row['reason']
    publication = response['publication']
    if publication is not None:
        if not isinstance(publication, dict):
            raise ValueError('nav_route_reconciliation_publication_invalid')
        matches = [item for item in output if item['owner'] == ROUTE_OWNER
            and item['payload']['artifact_id'] == publication.get('artifact_id')
            and item['payload']['artifact_checksum'] == publication.get('artifact_checksum')]
        if len(matches) != 1 or not route_adoption_receipt(matches[0]['payload'], publication)['complete']:
            raise ValueError('nav_route_published_inventory_unverified')
        matches[0]['registry_state'] = 'published'
        matches[0]['registry_state_source'] = 'verified_original_route_publication_reconciliation'
    return output, response


def verify_screener_observation(value, *, owner, artifact_id, artifact_checksum, publication_receipt_checksum, business_date):
    """Transport ORIGINAL canonical selection proof; never claim orders or NAV."""
    from services.paired_nav_journal import digest, _timestamp
    def sealed(text):
        return isinstance(text, str) and len(text) == 64 and all(c in '0123456789abcdef' for c in text)
    if not isinstance(value, dict):
        raise ValueError('nav_screener_observation_missing')
    checksum = value.get('observation_checksum')
    body = {key: item for key, item in value.items() if key != 'observation_checksum'}
    if (not sealed(checksum) or digest(body) != checksum
            or value.get('schema_version') != 'nav-canonical-screener-observation-v1'
            or value.get('owner') != owner or value.get('artifact_id') != artifact_id
            or value.get('artifact_checksum') != artifact_checksum
            or value.get('publication_receipt_checksum') != publication_receipt_checksum
            or value.get('business_date') != business_date or value.get('source') != 'original_canonical_screener'
            or value.get('scope') != 'canonical_l1_l15_selection' or value.get('read_only') is not True
            or value.get('promotion_allowed') is not False or value.get('orders_executed_verified') is not False
            or type(value.get('nav_maturity_credit')) is not int or value['nav_maturity_credit'] != 0
            or type(value.get('executed')) is not bool
            or value.get('status') != ('observed' if value['executed'] else 'not_observed')):
        raise ValueError('nav_screener_observation_invalid')
    published = _timestamp(value['published_at'])
    present = value.get('canonical_artifact_id') is not None
    fields = ('canonical_artifact_checksum', 'producer_run_id', 'source_checksum', 'source_observed_at', 'baseline_checksum')
    if present:
        if (not isinstance(value['canonical_artifact_id'], str) or not value['canonical_artifact_id']
                or not isinstance(value.get('producer_run_id'), str) or not value['producer_run_id']
                or not isinstance(value.get('canonical_artifact_checksum'), str)
                or not value['canonical_artifact_checksum'].startswith('sha256:')
                or not sealed(value['canonical_artifact_checksum'][7:])
                or not all(sealed(value.get(key)) for key in ('source_checksum', 'baseline_checksum'))):
            raise ValueError('nav_screener_observation_source_invalid')
        observed = _timestamp(value['source_observed_at'])
        if value['executed'] and observed < published:
            raise ValueError('nav_screener_observation_before_publication')
    elif any(value.get(key) is not None for key in fields) or value['executed']:
        raise ValueError('nav_screener_observation_source_missing')
    if owner == ATOMIC_OWNER and value['executed'] and not sealed(value.get('policy_checksum')):
        raise ValueError('nav_screener_observation_policy_missing')
    return value['executed']


def route_adoption_receipt(payload, response):
    """Verify publication transport; do not claim the next screener has executed."""
    response = response if isinstance(response, dict) else {}
    checksum = response.get('publication_receipt_checksum')
    sealed = isinstance(checksum, str) and len(checksum) == 64 and all(c in '0123456789abcdef' for c in checksum)
    serving = response.get('serving') or {}
    if not isinstance(serving, dict):
        serving = {}
    try:
        executed = verify_screener_observation(response.get('execution_observation'), owner=ROUTE_OWNER,
            artifact_id=payload['artifact_id'], artifact_checksum=payload['artifact_checksum'],
            publication_receipt_checksum=checksum, business_date=payload['evaluation_business_date'])
        execution_valid = response.get('serving_activation_verified') is executed
    except (ValueError, KeyError, TypeError):
        executed, execution_valid = False, False
    complete = (execution_valid and response.get('complete') is True and response.get('owner') == ROUTE_OWNER
        and response.get('completion_scope') == 'publication'
        and response.get('source') == 'route_head_and_original_reader'
        and response.get('artifact_id') == payload['artifact_id']
        and response.get('artifact_checksum') == payload['artifact_checksum']
        and response.get('pointer_committed') is True and response.get('serving_readers_verified') is True
        and sealed and isinstance(serving.get('runId'), str) and bool(serving['runId'])
        and serving.get('routeVersion') == payload['policy_definition']['challenger_version']
        and serving.get('routeFloor') is None)
    return {**response, 'complete': complete, 'serving_activation_verified': executed if complete else False}


async def adopt_daily_ensemble(payload, business_date):
    """Use the original API/transaction and verify its actual serving readers.

    This receipt closes publication only. It does not assert a model has run,
    create another evidence owner, or re-spend the original NAV review.
    """
    import json
    from routers import model_pool
    from services import model_artifact_registry as registry
    from services.active8_nav_adoption import load_committed_nav_serving_grant
    from services.active8_nav_inference import capture_frozen_nav_inference
    from services.model_serving_resolver import load_d1_champion_pool
    from services.ensemble_v2 import validate_active8_ensemble_candidate, ensemble_artifact_id
    from services.paired_nav_journal import digest

    if payload['evaluation_business_date'] != business_date:
        raise ValueError('nav_ensemble_adoption_date_mismatch')
    validate_active8_ensemble_candidate(payload['artifact'])
    if (ensemble_artifact_id(payload['artifact']) != payload['artifact_id']
            or payload['artifact']['payload_checksum'] != payload['artifact_checksum']):
        raise ValueError('nav_ensemble_adoption_requested_identity_mismatch')
    request = model_pool.Active8BundlePromotionControllerRequest(
        training_run_id=payload['training_run_id'], ensemble_artifact_id=payload['artifact_id'],
        ensemble_payload_checksum=payload['artifact_checksum'], evaluation_business_date=business_date,
        confirm=True, reason='daily_paired_nav_ensemble')
    response = await model_pool.artifact_registry_active8_bundle_promotion_controller(request)
    comparison = candidate_comparison_wait(payload, response, business_date=business_date, owner=L3_OWNER)
    if comparison is not None:
        return {**response, 'complete': False, 'serving_activation_verified': False}
    if (response.get('can_promote') is not True or response.get('readback_verified') is not True
            or response.get('ensemble_artifact_id') != payload['artifact_id']):
        return {'complete': False, 'status': 'incomplete', 'publication': response}
    grant = load_committed_nav_serving_grant(query=registry.d1_client.query)
    if grant is None or json.loads(grant.payload_json) != payload['artifact']:
        raise ValueError('nav_ensemble_adoption_committed_identity_mismatch')
    artifact = json.loads(grant.payload_json)
    pool = load_d1_champion_pool(required_models=tuple(artifact['selected_models']), sidecar_models=())
    capture_frozen_nav_inference(grant, artifact=artifact, pool_models=pool['models'])
    # A successful transaction or a readable artifact is not actual inference.
    # The original live grant already validates and normalizes D1's native UTC
    # timestamp. Recovery must not reinterpret it as an external proof timestamp.
    recovered = response.get('recovered_existing_commit') is True
    inference = {'status': 'awaiting_next_inference', 'executed': False,
        'observation_scope': 'publication_only', 'published_at': grant.published_at,
        'reason': 'publication_precedes_next_inference'}
    if recovered:
        from services.active8_nav_execution import observe_published_execution
        from services.recommendation_service import _predictions_query
        inference = {**observe_published_execution(query=_predictions_query, grant=grant, business_date=business_date),
            'published_at': grant.published_at}
    return {'complete': True, 'status': 'completed', 'completion_scope': 'publication',
        'owner': L3_OWNER, 'artifact_id': payload['artifact_id'],
        'artifact_checksum': payload['artifact_checksum'], 'pointer_committed': True,
        'serving_readers_verified': True, 'serving_activation_verified': inference.get('executed') is True,
        'publication_receipt_checksum': digest(json.loads(grant.receipt_json)),
        'recovered_existing_commit': recovered,
        # No records means not observed, not proof that inference never ran.
        'inference': inference}


def opb_comparison_wait(payload, response, *, business_date):
    return candidate_comparison_wait(payload, response, business_date=business_date, owner=OPB_OWNER)


def candidate_comparison_wait(payload, response, *, business_date, owner):
    """Read-only original owner observation, NEVER a publication/control PASS."""
    from services.paired_nav_journal import digest
    if not isinstance(response, dict) or response.get('status') != 'waiting':
        return None
    if owner not in {OPB_OWNER, L3_OWNER, *EV_OWNERS}:
        raise ValueError('nav_comparison_owner_invalid')
    is_ev = owner in EV_OWNERS
    error_owner = 'ev' if is_ev else 'opb' if owner == OPB_OWNER else 'ensemble'
    value = response.get('comparison')
    nav = payload['prospective_validation']['nav_validation']
    if not isinstance(value, dict):
        raise ValueError(f'nav_{error_owner}_comparison_observation_missing')
    body = {key: item for key, item in value.items() if key != 'observation_checksum'}
    def sealed(text):
        return isinstance(text, str) and len(text) == 64 and all(c in '0123456789abcdef' for c in text)
    changes = value.get('changed_fields')
    is_opb = owner == OPB_OWNER
    false_flags = ('pointer_committed', 'already_committed', *(
        ('promoted',) if is_ev else
        ('success', 'config_projection_verified', 'control_activation_verified') if is_opb
        else ('can_promote', 'readback_verified')))
    allowed = {'trading_config', 'risk_config', 'formal_ml'} | (
        ({'l4_dependency'} if owner == 'allocator_ev_fusion' else set()) if is_ev else {'serving_ev'} if is_opb
        else {'allocator_source_identity', 'l3_inference_source_identity', 'native_execution_policy'})
    dependency_only = owner == 'allocator_ev_fusion' and changes == ['l4_dependency']
    if (response.get('owner') != owner or response.get('artifact_id') != payload['artifact_id']
            or response.get('artifact_checksum') != payload['artifact_checksum']
            or response.get('completion_scope') != 'candidate_comparison'
            or any(response.get(key) is not False for key in false_flags)
            or value.get('schema_version') != error_owner + '-nav-comparison-observation-v1'
            or value.get('owner') != owner or value.get('artifact_id') != payload['artifact_id']
            or value.get('artifact_checksum') != payload['artifact_checksum']
            or value.get('as_of_date') != business_date or nav.get('as_of_date') != business_date
            or value.get('decision_checksum') != nav.get('decision_checksum')
            or value.get('frozen_configuration_checksum') != nav.get('configuration_checksum')
            or not all(sealed(value.get(key)) for key in ('decision_checksum', 'frozen_configuration_checksum',
                'current_context_checksum', 'observation_checksum'))
            or digest(body) != value['observation_checksum']
            or value.get('state') != ('awaiting_dependency' if dependency_only else 'baseline_changed')
            or value.get('reason') != ('exact_l4_dependency_not_serving' if dependency_only else 'awaiting_next_frozen_comparison')
            or value.get('source') != ('original_nav_proof_and_current_ml_ev_config' if is_opb or is_ev
                else 'original_nav_proof_and_current_ml_execution_config')
            or value.get('read_only') is not True or value.get('promotion_allowed') is not False
            or type(value.get('nav_maturity_credit')) is not int or value['nav_maturity_credit'] != 0
            or not isinstance(changes, list) or not changes or any(not isinstance(k, str) for k in changes)
            or len(set(changes)) != len(changes)
            or not set(changes) <= allowed):
        raise ValueError(f'nav_{error_owner}_comparison_observation_invalid')
    return value


def opb_retirement_receipt(payload, response, *, business_date):
    """Validate original owner retirement; NOT a publication or efficacy PASS."""
    if not isinstance(response, dict) or response.get('status') != 'retired':
        return None
    from datetime import timedelta, timezone
    from services.paired_nav_journal import digest, _timestamp
    schema = 'opb-nav-context-retirement-v1'
    value = response.get('retirement')
    if not isinstance(value, dict):
        raise ValueError('nav_opb_retirement_missing')
    body = {k: v for k, v in value.items() if k != 'retirement_checksum'}
    def sealed(v):
        return isinstance(v, str) and len(v) == 64 and all(c in '0123456789abcdef' for c in v)
    controls = value.get('restored_controls')
    changes = value.get('changed_fields')
    retired_day = _timestamp(value['retired_at']).astimezone(timezone(timedelta(hours=8))).date().isoformat()
    if (response.get('schema_version') != schema or value.get('schema_version') != schema
            or any(obj.get('owner') != OPB_OWNER or obj.get('artifact_id') != payload['artifact_id']
                or obj.get('artifact_checksum') != payload['artifact_checksum'] for obj in (response, value))
            or response.get('completion_scope') != 'retirement'
            or any(response.get(k) is not True for k in ('success', 'retired', 'config_projection_verified'))
            or any(response.get(k) is not False for k in ('pointer_committed', 'promotion_allowed', 'control_activation_verified'))
            or value.get('promotion_allowed') is not False
            or any(type(obj.get('nav_maturity_credit')) is not int or obj['nav_maturity_credit'] != 0 for obj in (response, value))
            or value.get('source') != 'original_opb_publication_and_verified_current_context'
            or not all(sealed(value.get(k)) for k in ('retirement_checksum', 'decision_checksum',
                'publication_receipt_checksum', 'restored_config_checksum', 'current_context_checksum'))
            or digest(body) != value['retirement_checksum'] or retired_day > business_date
            or value.get('original_history_event_id') != f"opb-nav:{payload['artifact_checksum']}:{value['decision_checksum']}"
            or not isinstance(controls, dict) or not controls.get('controller')
            or controls['controller'] == 'OnlinePortfolioBandit'
            or not isinstance(changes, list) or not changes
            or any(k not in {'formal_ml', 'serving_ev', 'risk_config', 'trading_config'} for k in changes)
            or len(set(changes)) != len(changes)):
        raise ValueError('nav_opb_retirement_invalid')
    return {**response, 'complete': True}


def opb_adoption_receipt(payload, response):
    """Transport integrity only; original Worker owns evidence and serving checks."""
    response = response if isinstance(response, dict) else {}
    checksum = response.get('publication_receipt_checksum')
    identity_matches = (response.get('owner') == OPB_OWNER
        and response.get('artifact_id') == payload['artifact_id']
        and response.get('artifact_checksum') == payload['artifact_checksum'])
    receipt_present = (isinstance(checksum, str) and len(checksum) == 64
        and all(c in '0123456789abcdef' for c in checksum))
    flags = {key: response.get(key) is True for key in (
        'pointer_committed', 'config_projection_verified', 'control_activation_verified')}
    control = response.get('control') if isinstance(response.get('control'), dict) else {}
    control_identity = (control.get('artifact_id') == payload['artifact_id']
        and control.get('artifact_checksum') == payload['artifact_checksum']
        and control.get('publication_receipt_checksum') == checksum and control.get('can_write_order') is False)
    sealed = all(isinstance(control.get(key), str) and len(control[key]) == 64
        and all(c in '0123456789abcdef' for c in control[key]) for key in ('snapshot_id', 'payload_checksum'))
    from services.paired_nav_journal import _timestamp
    try:
        published = _timestamp(control['published_at'])
        clock_valid = not sealed or _timestamp(control['frozen_at']) >= published
    except (KeyError, TypeError, ValueError, AttributeError):
        clock_valid = False
    pending = (control.get('status') == 'awaiting_next_allocation'
        and control.get('control_executed') is False and not flags['control_activation_verified']
        and control.get('snapshot_id') is None and control.get('payload_checksum') is None
        and control.get('reason') == 'publication_precedes_next_allocation'
        and isinstance(control.get('published_at'), str))
    observed = sealed and (
        control.get('status') == 'completed' and control.get('control_executed') is True
        and flags['control_activation_verified'] or control.get('status') == 'not_applicable'
        and control.get('control_executed') is False and not flags['control_activation_verified']
        and control.get('reason') == 'no_enabled_eligible_allocation')
    complete = (identity_matches and receipt_present and flags['pointer_committed']
        and flags['config_projection_verified'] and control_identity and clock_valid and (pending or observed)
        and response.get('schema_version') == 'opb-nav-adoption-receipt-v1'
        and response.get('completion_scope') == 'publication'
        and response.get('success') is True and response.get('status') == 'completed')
    return {'status': 'completed' if complete else 'incomplete', 'complete': complete,
        'completion_scope': 'publication', 'control': control,
        'owner': OPB_OWNER, 'artifact_id': payload['artifact_id'], **flags,
        'identity_matches': identity_matches, 'publication_receipt_checksum': checksum,
        'reason': response.get('reason') if not complete else None}
