"""Post-serving NAV setup; failure is critical for closure, not for incumbent output."""
import logging
import traceback
from copy import deepcopy
from pathlib import Path

from services.paired_nav_collection import shadow_failure
from services.paired_nav_journal import read_snapshot, reuse_frozen_snapshot

logger = logging.getLogger(__name__)


def _verified_late_selection_plans(snapshot_id, *, query):
    """Recover only complete, checksum-verified B plans from the frozen parent."""
    from services.paired_nav_cold import load
    from services.paired_nav_journal import read_context_projection, _timestamp
    from services.strategy_ab import validate_tag

    source = read_snapshot(query, snapshot_id)
    manifest, context = source['manifest'], source['payload']['content']
    candidates = (context.get('recommendation_context') or {}).get('l3_candidate_selection', {}).get('candidates') or []
    expected = {item['artifact']['payload_checksum'] for item in candidates}
    if not expected or len(expected) != len(candidates):
        raise ValueError('paired_nav_b_selection_identity_invalid')
    rows = query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE signal_date=? "
        "AND snapshot_kind='allocation_pair' ORDER BY frozen_at DESC LIMIT 65", [manifest['signal_date']])
    if len(rows) > 64:
        raise ValueError('paired_nav_b_selection_inventory_exceeds_bound')
    prefixes = frozenset({'schema_version', 'signal_date', 'snapshot_kind', 'source_run_id'} | {
        'content.' + field for field in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum',
            'allocation_context_snapshot_id', 'production_effect', 'can_write_order', 'nav_maturity_credit',
            'candidate.output', 'configuration.strategy_bundle.strategy_ab')})
    found = {}
    for row in rows:
        payload = load(query, row, prefixes=prefixes)
        if payload is None:
            payload = read_snapshot(query, row['snapshot_id'])['payload']
        plan = payload.get('content') or {}
        checksum = plan.get('candidate_checksum')
        if checksum not in expected:
            continue
        parent_id = plan.get('allocation_context_snapshot_id')
        if not isinstance(parent_id, str):
            raise ValueError('paired_nav_b_selection_parent_missing')
        parent = read_context_projection(query, parent_id, ('upstream_allocation_context_snapshot_id',))
        if parent['payload']['content'].get('upstream_allocation_context_snapshot_id') != snapshot_id:
            continue
        tag = validate_tag(((plan.get('configuration') or {}).get('strategy_bundle') or {}).get('strategy_ab'))
        if (row['prospective'] not in (0, 1) or row['source_run_id'] != plan.get('pair_id')
                or parent['manifest']['source_run_id'] != 'l3:' + row['source_run_id']
                or parent['manifest']['signal_date'] != manifest['signal_date']
                or _timestamp(row['frozen_at']) < _timestamp(manifest['frozen_at'])
                or plan.get('owner') != 'ensemble'
                or plan.get('baseline_checksum') != context['formal_baseline_identity']['payload_checksum']
                or plan.get('production_effect') is not False or plan.get('can_write_order') is not False
                or plan.get('nav_maturity_credit') != 0 or not isinstance((plan.get('candidate') or {}).get('output'), list)
                or tag['role'] != 'B' or tag['baseline_primary']['role'] != 'A'
                or checksum in found or query("SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 "
                    "WHERE signal_date=? AND snapshot_kind='execution_pair' AND source_run_id=? LIMIT 1",
                    [manifest['signal_date'], row['source_run_id']])):
            raise ValueError('paired_nav_b_selection_readback_invalid')
        found[checksum] = {'pair_id': row['source_run_id'], 'snapshot_id': row['snapshot_id'], 'owner': 'ensemble'}
    return [found[key] for key in sorted(expected)] if set(found) == expected else []


def _verify_registrations(candidates, native, *, signal_date, query):
    if native.get('status') != 'native_execution_pairs_registered':
        raise ValueError('paired_nav_native_registration_incomplete')
    plans = {p['snapshot_id']: p for p in candidates['plans']}
    if len(plans) != len(candidates['plans']):
        raise ValueError('paired_nav_duplicate_allocation_plans')
    seen = set()
    for manifest in native['registrations']:
        frozen = read_snapshot(query, manifest['snapshot_id'])
        saved, packet = frozen['manifest'], frozen['payload']['content']
        parent_id = packet['allocation_snapshot_id']
        if (parent_id not in plans or parent_id in seen
                or saved['snapshot_kind'] != 'execution_pair' or saved['prospective'] != 1
                or packet['pair_id'] != plans[parent_id]['pair_id']
                or packet['owner'] != plans[parent_id]['owner']
                or saved['signal_date'] != signal_date):
            raise ValueError('paired_nav_native_registration_readback_mismatch')
        seen.add(parent_id)
    if seen != set(plans):
        raise ValueError('paired_nav_native_registration_coverage_missing')


def complete_pipeline_shadow(collection, *, query, writer, enforce_execution_window=False):
    """Complete post-serving NAV without reloading the large frozen parent."""
    from services.paper_strategy_mode import STATUS, valid_disabled_receipt, single_b_policy, disabled_receipt
    if isinstance(collection, dict) and collection.get('status') == STATUS:
        if not valid_disabled_receipt(collection):
            raise ValueError('paired_nav_invalid_single_strategy_receipt')
        return deepcopy(collection)
    snapshot_id = collection.get('snapshot_id') if isinstance(collection, dict) else None
    with reuse_frozen_snapshot(snapshot_id):
        if snapshot_id:
            from services.paired_nav_journal import read_context_projection
            try:
                parent = read_context_projection(query, snapshot_id, ('trading_config',))
                mode = single_b_policy(parent['payload']['content'].get('trading_config'),
                    signal_date=parent['manifest']['signal_date'])
            except Exception as exc:
                return {**collection, **shadow_failure('allocation_context_readback', exc)}
            if mode:
                return disabled_receipt(mode, signal_date=parent['manifest']['signal_date'], snapshot_id=snapshot_id)
        return _complete_pipeline_shadow(collection, query=query, writer=writer,
            enforce_execution_window=enforce_execution_window)


def _complete_pipeline_shadow(collection, *, query, writer, enforce_execution_window=False):
    """Independent Atomic setup cannot be starved by another candidate lane."""
    if enforce_execution_window and isinstance(collection, dict) and collection.get('snapshot_id'):
        try:
            from services.paired_nav_execution_window import missed_setup_window, persist_missed_setup_window
            missed = missed_setup_window(collection, query=query)
            if missed is not None:
                # A missed account start forbids NAV registration, but the sealed
                # preopen model inputs can still produce today's B selection.
                # This writes only allocation snapshots; no fills or NAV credit.
                from services.paired_nav_l3_candidate import collect_ensemble_allocations

                plans = _verified_late_selection_plans(collection['snapshot_id'], query=query)
                if not plans:
                    try:
                        selection = collect_ensemble_allocations(
                            snapshot_id=collection['snapshot_id'], query=query, writer=writer)
                    except ValueError as exc:
                        # A retrospective pair is non-prospective. The common
                        # lifecycle planner rejects it after all plans are sealed.
                        if str(exc) != 'paired_nav_lifecycle_successor_invalid':
                            raise
                        plans = _verified_late_selection_plans(collection['snapshot_id'], query=query)
                        if not plans:
                            raise
                    else:
                        if selection.get('status') != 'allocation_pairs_frozen' or not selection.get('plans'):
                            raise ValueError('paired_nav_b_selection_not_frozen')
                return persist_missed_setup_window(missed)
        except Exception as exc:
            return {**collection, **shadow_failure('execution_window_check', exc)}
    atomic = None
    if isinstance(collection, dict) and collection.get('snapshot_id'):
        try:
            parent = read_snapshot(query, collection['snapshot_id'])
            if parent['payload']['content'].get('atomic_recommendation_inputs') is not None:
                from services.paired_nav_atomic_candidate import collect_atomic_allocations
                atomic = collect_atomic_allocations(snapshot_id=collection['snapshot_id'], query=query, writer=writer)
                if atomic['plans']:
                    native, atomic, failures = _register_owner_groups(atomic,
                        signal_date=parent['manifest']['signal_date'], query=query, writer=writer)
                    atomic = {**atomic, 'native_execution': native,
                        'status': 'native_execution_pairs_registered' if atomic['selection_materialization_complete']
                            else 'atomic_partial_native_registration'}
                    if failures:
                        atomic = {**atomic, **next(iter(failures.values())), 'owner_failures': failures}
        except Exception as exc:
            atomic = {**(atomic or {}), **shadow_failure('atomic_candidate_setup', exc)}
    result = _complete_existing_pipeline_shadow(collection, query=query, writer=writer)
    return {**result, 'atomic_collection': atomic} if atomic is not None else result


def _register_owner_groups(candidates, *, signal_date, query, writer):
    """Attempt every candidate; failures stay explicit in their owner group.

    Registration and lifecycle commit use the ORIGINAL per-comparison owners.
    A successful sibling may proceed; a failed successor cannot close its old
    comparison. No member is dropped from the declared candidate population.
    """
    from services.paired_native_runtime import register_candidate_execution_plans
    from services.paired_nav_lifecycle import close_changed_comparisons
    failures, registrations, transitions = {}, [], []
    plans = candidates['plans']
    bootstrap_cache = {}
    if (len({p['snapshot_id'] for p in plans}) != len(plans)
            or len({p['pair_id'] for p in plans}) != len(plans)):
        raise ValueError('paired_nav_duplicate_allocation_plans')
    for plan in plans:
        owner = plan['owner']
        stage = 'native_registration'
        try:
            group = {**candidates, 'plans': [plan]}
            native = register_candidate_execution_plans(collection=group, query=query, writer=writer,
                bootstrap_cache=bootstrap_cache)
            _verify_registrations(group, native, signal_date=signal_date, query=query)
            # Preserve verified registrations even if lifecycle commit needs retry.
            registrations.extend(native['registrations'])
            stage = 'lifecycle_commit'
            transitions.extend(close_changed_comparisons(plans=[plan],
                signal_date=signal_date, query=query, writer=writer))
        except Exception as exc:
            failure = shadow_failure(stage, exc)
            if failure['reason'] == 'paired_nav_source_or_capture_failed':
                # Provider errors can contain credentials. Log only a safe
                # exception class and traceback site for production diagnosis.
                frames = traceback.extract_tb(exc.__traceback__)
                site = frames[-1] if frames else None
                logger.warning('paired_nav_registration_failure owner=%s stage=%s type=%s site=%s:%s',
                    owner, stage, type(exc).__name__, Path(site.filename).name if site else 'unknown',
                    site.lineno if site else 0)
            grouped = failures.setdefault(owner, {**failure, 'candidate_failures': []})
            grouped['candidate_failures'].append({**failure, 'pair_id': plan['pair_id'],
                'allocation_snapshot_id': plan['snapshot_id']})
    native = {'status': 'partial_native_execution_registration' if failures else 'native_execution_pairs_registered',
        'registrations': registrations,
        'production_effect': False, 'nav_maturity_credit': 0, 'promotion_allowed': False}
    return native, {**candidates, 'lifecycle_transitions': transitions}, failures


def _complete_existing_pipeline_shadow(collection, *, query, writer):
    from services.paired_nav_candidate_collection import collect_candidate_allocations

    result = deepcopy(collection) if isinstance(collection, dict) else {}
    stage = 'allocation_context_readback'
    try:
        if result.get('status') == 'failed':
            if not result.get('snapshot_id') or result.get('stage') not in {
                    'candidate_allocations', 'native_registration', 'allocation_context_readback', 'lifecycle_commit', 'l15_route_effect',
                    'candidate_artifact_load', 'candidate_inference', 'candidate_allocation',
                    'candidate_allocation_seal', 'candidate_lifecycle_prepare', 'candidate_dependency'}:
                return result
            # Retry from the immutable parent, never rerun the formal allocator
            # or replace a missing pre-outcome seal with reconstructed inputs.
            result = {key: value for key, value in result.items()
                      if key not in {'stage', 'reason', 'error_type', 'owner_failures', 'candidate_allocations', 'native_execution', 'l15_route_effect', 'l15_route_collection'}}
            result['status'] = 'allocation_context_frozen'
        parent = read_snapshot(query, result['snapshot_id'])
        if parent['manifest']['snapshot_kind'] != 'allocation_context':
            raise ValueError('paired_nav_allocation_context_required')
        parent_status = parent['payload']['content'].get('status')
        if result.get('status') == 'not_applicable_no_formal_ml_ensemble' or parent_status == 'not_applicable_no_formal_ml_ensemble':
            if parent_status != 'not_applicable_no_formal_ml_ensemble':
                raise ValueError('paired_nav_evidence_only_status_mismatch')
            return {**result, 'status': parent_status}
        # Rebuild derived summaries from immutable registrations on EVERY call,
        # including a completed retry with only a route lane. Otherwise the old
        # route registration is appended again when EV remains awaiting.
        for key in ('native_execution', 'l15_route_effect', 'l15_route_collection'):
            result.pop(key, None)
        failures = {}
        try:
            candidates = collect_candidate_allocations(snapshot_id=result['snapshot_id'], query=query, writer=writer)
            failures.update(candidates.get('owner_failures', {}))
            pending = candidates['status'] in {'awaiting_frozen_l4_candidate', 'historical_not_prospective', 'awaiting_paired_l3_l4_release'}
            if pending and candidates.get('plans'):
                raise ValueError('paired_nav_unexpected_pending_plans')
            if not pending and not failures and (
                    candidates['status'] != 'allocation_pairs_frozen' or not candidates.get('plans')):
                raise ValueError('paired_nav_candidate_collection_incomplete')
        except Exception as exc:
            failures['candidate_collection'] = shadow_failure('candidate_allocations', exc)
            candidates = {'status': 'candidate_allocations_failed', 'plans': []}
        result['candidate_allocations'] = candidates

        def register(group):
            native, registered, errors = _register_owner_groups(group,
                signal_date=parent['manifest']['signal_date'], query=query, writer=writer)
            failures.update(errors)
            if native['registrations']:
                previous = result.get('native_execution', {}).get('registrations', [])
                result['native_execution'] = {**native, 'registrations': previous + native['registrations']}
            return registered

        if candidates['plans']:
            result['candidate_allocations'] = register(candidates)
        # Route uses the same immutable root, not EV/L3 execution success.
        # Failed owners remain critical; no failure is converted to abstention.
        try:
            from services.paired_nav_route_candidate import collect_route_allocations
            route = collect_route_allocations(snapshot_id=result['snapshot_id'], query=query, writer=writer)
            result['l15_route_effect'], result['l15_route_collection'] = route['effect'], route
            if route['plans']:
                route = register(route)
                result['l15_route_collection'] = route
                prior = result['candidate_allocations']
                result['candidate_allocations'] = {**prior, 'status': 'allocation_pairs_frozen',
                    'upstream_collection_status': prior['status'],
                    'plans': prior.get('plans', []) + route['plans'],
                    'lifecycle_transition_plan': prior.get('lifecycle_transition_plan', []) + route['lifecycle_transition_plan'],
                    'lifecycle_transitions': prior.get('lifecycle_transitions', []) + route['lifecycle_transitions']}
        except Exception as exc:
            failures['l15_route'] = shadow_failure('l15_route_effect', exc)
        if failures:
            if result.get('native_execution'):
                result['native_execution']['status'] = 'partial_native_execution_registration'
            return {**result, **next(iter(failures.values())), 'owner_failures': failures}
        status = 'native_execution_pairs_registered' if result.get('native_execution') else candidates['status']
        return {**result, 'status': status}
    except Exception as exc:
        return {**result, **shadow_failure(stage, exc)}


def pipeline_shadow_errors(collection):
    """Terminal truth: WAIT/explicit abstention can close, absent setup cannot."""
    if not isinstance(collection, dict):
        return ['paired_nav:collection_missing']
    from services.paper_strategy_mode import STATUS,valid_disabled_receipt
    if collection.get('status')==STATUS:
        return [] if valid_disabled_receipt(collection) else ['paired_nav:invalid_single_strategy_receipt']
    errors = []
    atomic_collection = collection.get('atomic_collection')
    if atomic_collection is not None and atomic_collection.get('status') not in {
            'native_execution_pairs_registered', 'no_structural_candidates', 'awaiting_paired_l3_l4_release'}:
        errors.append('paired_nav:atomic_collection:' + str(atomic_collection.get('reason') or atomic_collection.get('status')))
    atomic = collection.get('atomic_daily')
    if atomic is not None and (not isinstance(atomic, dict) or atomic.get('status') not in {
            'no_structural_candidates', 'native_execution_pairs_registered', 'awaiting_paired_l3_l4_release'}):
        reason = atomic.get('reason') if isinstance(atomic, dict) else 'invalid_summary'
        errors.append(f"paired_nav:atomic_daily:{reason or 'setup_not_completed'}")
    if collection.get('owner_failures'):
        return [*errors, *[f"paired_nav:{owner}:{failure['stage']}:{failure['reason']}"
            for owner, failure in collection['owner_failures'].items()]]
    if collection.get('status') == 'failed':
        return [*errors, f"paired_nav:{collection.get('stage', 'unknown')}:{collection.get('reason', 'failed')}"]
    if collection.get('status') == 'missed_execution_window':
        from services.paired_nav_execution_window import valid_missed_window_receipt
        return errors if valid_missed_window_receipt(collection) else [*errors, 'paired_nav:invalid_missed_execution_window']
    if not collection.get('snapshot_id') or collection.get('status') not in {
            'native_execution_pairs_registered', 'awaiting_frozen_l4_candidate', 'awaiting_paired_l3_l4_release',
            'historical_not_prospective', 'not_applicable_no_formal_ml_ensemble'}:
        return [*errors, 'paired_nav:setup_not_completed']
    return errors
