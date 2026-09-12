"""All frozen NAV contrasts, not only the survivors with an available return.

Owner groups are an inventory, NOT an alpha-allocation policy. Training dates,
registry state, daily retries and lifecycle transitions cannot erase members.
No statistical test, budget reservation, maturity transfer or promotion here.
"""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
import re

from services.paired_nav_journal import digest, read_snapshot, _timestamp
from services.paired_nav_comparison import resolve_allocation_comparison, resolve_comparison


def _manifest_rows(query, business_date, kind, page_size):
    cursor, count = '', 0
    while True:
        rows = query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 '
            'WHERE snapshot_kind=? AND prospective=1 AND signal_date<=? AND snapshot_id>? '
            'ORDER BY snapshot_id LIMIT ?', [kind, business_date, cursor, page_size])
        if not rows:
            break
        for row in rows:
            count += 1
            yield read_snapshot(query, row['snapshot_id'])
        cursor = rows[-1]['snapshot_id']
    actual = query('SELECT COUNT(*) AS n FROM paired_nav_frozen_manifests_v1 '
        'WHERE snapshot_kind=? AND prospective=1 AND signal_date<=?', [kind, business_date])
    if len(actual) != 1 or actual[0]['n'] != count:
        raise RuntimeError('paired_nav_population_concurrent_publication_retry')


def read_candidate_population(*, business_date, query, series, page_size=50, now=None,
        _snapshot_ids=None, _capture_snapshot_ids=None, _observed_at=None):
    """Read-only denominator consumed by the same verified nightly evidence.

Series remain separate per pair: no cross-version/date averaging. Legacy seals
without an allocation parent are disclosed, never guessed into an owner group.
Registered sessions after the as-of date OR not yet closed remain pending.
Use the immutable execution packet's close; do not invent another calendar.
"""
    date.fromisoformat(business_date)
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock.utcoffset() is None:
        raise ValueError('paired_nav_timezone_required')
    if _observed_at is not None and (_observed_at.tzinfo is None or _observed_at > clock):
        raise ValueError('paired_nav_population_observation_time_invalid')
    if type(page_size) is not int or not 1 <= page_size <= 100:
        raise ValueError('paired_nav_population_invalid_page_size')
    kinds = ('allocation_context', 'allocation_pair', 'execution_pair')
    pinned = None
    captured = []
    if _snapshot_ids is not None:
        if (not isinstance(_snapshot_ids, (list, tuple))
                or any(not isinstance(key, str) or not key for key in _snapshot_ids)
                or list(_snapshot_ids) != sorted(set(_snapshot_ids))):
            raise ValueError('paired_nav_population_census_invalid')
        pinned = {kind: [] for kind in kinds}
        for key in _snapshot_ids:
            saved = read_snapshot(query, key)
            manifest = saved['manifest']
            if (manifest['snapshot_kind'] not in pinned or manifest['prospective'] != 1
                    or manifest['signal_date'] > business_date):
                raise ValueError('paired_nav_population_census_scope_invalid')
            pinned[manifest['snapshot_kind']].append(saved)
    def manifests(kind):
        rows = pinned[kind] if pinned is not None else _manifest_rows(query, business_date, kind, page_size)
        for saved in rows:
            captured.append(saved['manifest']['snapshot_id'])
            yield saved
    plans, pairs, executions, legacy_plans, legacy_executions = set(), {}, {}, [], []
    session_closes = {}
    context_ids, expected, materialized, ev_selections = set(), set(), set(), {}
    unresolved_sources = []
    pending_dependencies = []
    series_by_pair = {p.pair_id: p for p in series}
    for saved in manifests('allocation_context'):
        m, context = saved['manifest'], saved['payload']['content']
        if _timestamp(m['frozen_at']) > clock:
            raise ValueError('paired_nav_population_snapshot_not_available')
        context_ids.add(m['snapshot_id'])
        if context.get('upstream_allocation_context_snapshot_id'):
            continue  # L3 derived parents copy the root's entire selection.
        from services.paired_nav_ev_selection import frozen_ev_selection
        ev = context.get('ev_candidate_selection')
        if ev is not None and ev.get('status') == 'failed':
            if ev.get('stage') != 'ev_candidate_selection':
                raise ValueError('paired_nav_population_ev_selection_invalid')
            unresolved_sources.append({'allocation_context_snapshot_id': m['snapshot_id'],
                'owner': 'expected_return', 'status': 'failed', 'stage': ev['stage'],
                'reason': ev.get('reason'), 'source_checksum': digest(ev)})
        elif ev is not None:
            ev = frozen_ev_selection(context)
            ev_selections[m['snapshot_id']] = digest(ev)
            expected.update((m['snapshot_id'], 'l4_alpha_ev', key) for key in ev['l4_checksums'])
            expected.update((m['snapshot_id'], 'allocator_ev_fusion', key) for key in ev['fusion_bases'])
        opb = context.get('opb_candidate_selection')
        if opb is not None and opb.get('status') == 'failed':
            if opb.get('stage') != 'opb_candidate_selection':
                raise ValueError('paired_nav_population_opb_selection_invalid')
            unresolved_sources.append({'allocation_context_snapshot_id': m['snapshot_id'],
                'owner': 'opb_arm_prior', 'status': 'failed', 'stage': opb['stage'],
                'reason': opb.get('reason'), 'source_checksum': digest(opb)})
        elif opb is not None:
            from services.paired_nav_opb_candidate import frozen_opb_selection, opb_dependency_wait
            selection = frozen_opb_selection(saved)
            expected.update((m['snapshot_id'], 'opb_arm_prior', row['checksum']) for row in selection['registry_rows'])
            for row in selection['registry_rows']:
                try:
                    wait = opb_dependency_wait(row, saved)
                except Exception:
                    continue  # Still an expected, UNMATERIALIZED candidate, never a valid wait.
                if wait is not None:
                    pending_dependencies.append(wait)
        atomic = context.get('atomic_recommendation_inputs')
        if atomic is not None:
            expected.update((m['snapshot_id'], 'atomic_strategy', key) for key in atomic['definitions'])
        from services.paired_nav_route_effect import frozen_route_source
        from services.paired_nav_route_candidate import route_identity
        route = frozen_route_source(saved)
        if route['status'] == 'pit_route_source_verified':
            expected.add((m['snapshot_id'], 'l15_route',
                route_identity(route['challenger_version'], route['slate_builder_version'])))
        selection = (context.get('recommendation_context') or {}).get('l3_candidate_selection')
        if selection is not None:
            if selection.get('status') == 'failed' and selection.get('stage') == 'l3_candidate_selection':
                unresolved_sources.append({'allocation_context_snapshot_id': m['snapshot_id'],
                    'owner': 'ensemble', 'status': 'failed', 'stage': selection['stage'],
                    'reason': selection.get('reason'), 'source_checksum': digest(selection)})
                continue  # Unknown denominator, not zero candidates; retain other verified owners.
            if (selection.get('schema_version') not in {'paired-nav-l3-candidate-selection-v1', 'paired-nav-l3-candidate-selection-v2'}
                    or selection.get('signal_date') != m['signal_date']):
                raise ValueError('paired_nav_population_l3_selection_invalid')
            for candidate in selection['candidates']:
                expected.add((m['snapshot_id'], 'ensemble', candidate['artifact']['payload_checksum']))
    for saved in manifests('allocation_pair'):
        m, plan = saved['manifest'], saved['payload']['content']
        if _timestamp(m['frozen_at']) > clock:
            raise ValueError('paired_nav_population_snapshot_not_available')
        if 'allocation_context_snapshot_id' not in plan:
            legacy_plans.append(m['snapshot_id'])
            continue
        parent = read_snapshot(query, plan['allocation_context_snapshot_id'])
        context = parent['payload']['content']
        root = context.get('upstream_allocation_context_snapshot_id') or parent['manifest']['snapshot_id']
        if root not in context_ids:
            raise ValueError('paired_nav_population_root_context_missing')
        comparison = resolve_allocation_comparison(query=query, allocation=saved, parent=parent)
        identity = {k: plan.get(k) for k in ('owner', 'candidate_checksum', 'baseline_checksum', 'configuration_checksum')}
        if (not isinstance(plan.get('pair_id'), str) or not plan['pair_id']
                or any(not isinstance(identity[k], str) or re.fullmatch('[0-9a-f]{64}', identity[k]) is None
                       for k in ('candidate_checksum', 'baseline_checksum', 'configuration_checksum'))):
            raise ValueError('paired_nav_population_identity_invalid')
        pair_id = plan['pair_id']
        hypothesis = digest(['paired-nav-hypothesis-v1', identity])
        family = digest(['paired-nav-owner-population-v1', plan['owner']])
        materialized.add((root, plan['owner'], plan['candidate_checksum']))
        selection = plan.get('ev_candidate_selection')
        if selection is not None:
            if selection.get('schema_version') != 'paired-nav-ev-selection-v1':
                raise ValueError('paired_nav_population_ev_selection_invalid')
            checksum = digest(selection)
            if ev_selections.setdefault(root, checksum) != checksum:
                raise ValueError('paired_nav_population_ev_selection_changed')
            expected.update((root, 'l4_alpha_ev', key) for key in selection['l4_checksums'])
            expected.update((root, 'allocator_ev_fusion', key) for key in selection['fusion_bases'])
        info = pairs.setdefault(pair_id, {'pair_id': pair_id, 'hypothesis_checksum': hypothesis,
            'family_id': family, **identity, 'comparison': comparison,
            'first_signal_date': m['signal_date'], 'latest_signal_date': m['signal_date'],
            'allocation_snapshot_ids': [], 'training_run_ids': set(), 'candidate_artifact_ids': set(),
            'metadata_missing_fields': set()})
        if info['hypothesis_checksum'] != hypothesis or info['comparison'] != comparison:
            raise ValueError('paired_nav_population_pair_identity_changed')
        info['first_signal_date'] = min(info['first_signal_date'], m['signal_date'])
        info['latest_signal_date'] = max(info['latest_signal_date'], m['signal_date'])
        info['allocation_snapshot_ids'].append(m['snapshot_id'])
        for field, source in (('training_run_ids', 'candidate_training_run_id'), ('candidate_artifact_ids', 'candidate_artifact_id')):
            value = plan.get(source)
            if not isinstance(value, str) or not value:
                # Legacy native plans can bind exact economic checksums but
                # lack display/training names. Keep the hypothesis and expose
                # the missing metadata; do not guess names or block accounting.
                info['metadata_missing_fields'].add(source)
            else:
                info[field].add(value)
        plans.add(m['snapshot_id'])
    for saved in manifests('execution_pair'):
        m, packet = saved['manifest'], saved['payload']['content']
        if _timestamp(m['frozen_at']) > clock:
            raise ValueError('paired_nav_population_snapshot_not_available')
        if not packet.get('allocation_snapshot_id'):
            legacy_executions.append(m['snapshot_id'])
            continue
        parent_id = packet['allocation_snapshot_id']
        if parent_id not in plans:
            raise ValueError('paired_nav_population_execution_parent_missing')
        comparison = resolve_comparison(query=query, execution=saved)
        pair_id, session = packet['pair_id'], packet['session_date']
        if (pair_id not in pairs or pairs[pair_id]['comparison'] != comparison
                or date.fromisoformat(session).isoformat() != session or session <= m['signal_date']):
            raise ValueError('paired_nav_population_execution_identity_mismatch')
        dates = executions.setdefault(pair_id, {})
        if session in dates:
            raise ValueError('paired_nav_population_duplicate_execution_session')
        opened, closed = _timestamp(packet['session_open_at']), _timestamp(packet['session_close_at'])
        taipei = timezone(timedelta(hours=8))
        if (not _timestamp(m['frozen_at']) < opened < closed
                or opened.astimezone(taipei).date().isoformat() != session
                or closed.astimezone(taipei).date().isoformat() != session):
            raise ValueError('paired_nav_population_execution_time_invalid')
        dates[session] = m['snapshot_id']
        session_closes[pair_id, session] = closed
    has_lifecycle = bool(query("SELECT name FROM sqlite_master WHERE type='table' AND name='paired_nav_lifecycle_closures_v1'", []))
    if has_lifecycle and pairs:
        from services.paired_nav_lifecycle import validate_schema, closure_for_pair
        validate_schema(query)
    for pair_id, info in pairs.items():
        evidence = series_by_pair.get(pair_id)
        rows = {o.session_date: o.snapshot_id for o in evidence.observations} if evidence else {}
        registered = executions.get(pair_id, {})
        if any(registered.get(day) != snapshot for day, snapshot in rows.items()):
            raise ValueError('paired_nav_population_journal_registration_mismatch')
        if any(session_closes[pair_id, day] > clock for day in rows):
            raise ValueError('paired_nav_population_journal_close_not_observable')
        unaccounted = sorted(day for day in registered if day <= business_date
            and session_closes[pair_id, day] <= clock and day not in rows)
        future = sorted(day for day in registered if day > business_date or session_closes[pair_id, day] > clock)
        open_sessions = any(day <= business_date for day in future)
        closure = closure_for_pair(pair_id, signal_date=business_date, query=query,
            observed_at=_observed_at or clock) if has_lifecycle else None
        if closure and (closure['successor_pair_id'] not in pairs
                or closure['successor_snapshot_id'] not in plans
                or not rows or max(rows) != closure['final_session_date']
                or rows[max(rows)] != closure['final_execution_snapshot_id']):
            raise ValueError('paired_nav_population_lifecycle_evidence_mismatch')
        info.update(execution_status='registered_evidence_missing' if unaccounted else
            'awaiting_session_close' if open_sessions else
            'observing' if rows else 'awaiting_session' if registered else 'not_registered',
            lifecycle_status='comparison_closed' if closure else 'open' if has_lifecycle else 'unknown',
            successor_pair_id=closure['successor_pair_id'] if closure else None,
            registered_session_dates=sorted(registered), unaccounted_session_dates=unaccounted,
            upcoming_session_dates=future, accounted_sessions=len(rows),
            exact_nav_sessions=sum(o.net_return_delta is not None for o in evidence.observations) if evidence else 0,
            evidence_checksum=evidence.checksum if evidence else None)
        for field in ('allocation_snapshot_ids', 'training_run_ids', 'candidate_artifact_ids', 'metadata_missing_fields'):
            info[field] = sorted(info[field])
    families = defaultdict(list)
    for info in pairs.values():
        families[info['family_id']].append(info)
    groups = [{'family_id': key, 'owner': members[0]['owner'],
        'hypothesis_count': len({p['hypothesis_checksum'] for p in members}),
        'hypothesis_checksums': sorted({p['hypothesis_checksum'] for p in members}),
        'pair_ids': sorted(p['pair_id'] for p in members)} for key, members in sorted(families.items())]
    waiting_keys = {(item['allocation_context_snapshot_id'], item['owner'], item['candidate_checksum'])
                    for item in pending_dependencies}
    if waiting_keys & materialized:
        raise ValueError('paired_nav_opb_pending_dependency_materialized')
    unresolved_selections = expected - materialized - waiting_keys
    body = {'schema': 'paired-nav-candidate-population-v1',
        'scope': 'all_frozen_owner_contrasts_across_training_cohorts',
        'hypothesis_count_scope': 'materialized_contrasts_not_unpublished_selections',
        'pair_count': len(pairs), 'hypothesis_count': sum(f['hypothesis_count'] for f in groups),
        'declared_selection_count': len(expected),
        'selection_materialization_complete': not (expected - materialized) and not unresolved_sources,
        'unresolved_selection_sources': sorted(unresolved_sources, key=lambda s: s['allocation_context_snapshot_id']),
        'unmaterialized_selections': [dict(allocation_context_snapshot_id=root, owner=owner, candidate_checksum=key)
            for root, owner, key in sorted(unresolved_selections)],
        **({'pending_dependencies': sorted(pending_dependencies,
            key=lambda item: (item['allocation_context_snapshot_id'], item['candidate_checksum']))} if pending_dependencies else {}),
        'families': groups, 'pairs': [pairs[key] for key in sorted(pairs)],
        'unresolved_legacy_allocation_snapshot_ids': sorted(legacy_plans),
        'unresolved_legacy_execution_snapshot_ids': sorted(legacy_executions),
        'unresolved_journal_pair_ids': sorted(p.pair_id for p in series if p.pair_id not in pairs),
        'statistical_budget_status': 'not_assigned', 'promotion_allowed': False}
    # A publisher may add a plan after the allocation scan finished, while the
    # execution scan advances. Do not attest to a silently truncated family.
    for kind, expected in (
            ('allocation_context', len(context_ids)),
            ('allocation_pair', len(plans) + len(legacy_plans)),
            ('execution_pair', sum(len(dates) for dates in executions.values()) + len(legacy_executions))):
        actual = ([{'n': len(pinned[kind])}] if pinned is not None else
            query('SELECT COUNT(*) AS n FROM paired_nav_frozen_manifests_v1 '
                'WHERE snapshot_kind=? AND prospective=1 AND signal_date<=?', [kind, business_date]))
        if len(actual) != 1 or actual[0]['n'] != expected:
            raise RuntimeError('paired_nav_population_concurrent_publication_retry')
    actual = query('SELECT COUNT(*) AS n FROM paired_nav_daily_journal_v1 WHERE session_date<=?', [business_date])
    if len(actual) != 1 or actual[0]['n'] != sum(len(p.observations) for p in series):
        raise RuntimeError('paired_nav_population_concurrent_journal_retry')
    if _capture_snapshot_ids is not None:
        _capture_snapshot_ids(tuple(sorted(captured)))
    return {**body, 'population_checksum': digest(body)}
