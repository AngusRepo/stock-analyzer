"""Read original NAV evidence and reverify the persisted, code-owned review.

No caller-supplied PASS, spending, retraining, journal rewriting or pointer I/O.
Numerical support is conditional approximate evidence, not guaranteed profit.
"""
from dataclasses import asdict
from datetime import date, datetime, timedelta, timezone
import json

from services import paired_nav_daily_review as daily
from services import paired_nav_review_store as store
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_family_review import _review_evidence
from services.paired_nav_journal import digest, encode, read_snapshot, _timestamp


class NavCandidateDecisionReadScope:
    """One request's original verification work; never a cross-request cache."""
    def __init__(self, *, query, business_date, now):
        self.query, self.business_date, self.now = query, business_date, now
        self.policy_checksum = daily.POLICY.checksum
        self.sources, self.reports = {}, {}

    def read(self, *, owner, candidate_checksum, candidate_artifact_id):
        return read_nav_candidate_decision(owner=owner, candidate_checksum=candidate_checksum,
            candidate_artifact_id=candidate_artifact_id, business_date=self.business_date,
            query=self.query, now=self.now, _scope=self)


def read_nav_candidate_decision(*, owner, candidate_checksum, candidate_artifact_id,
                                business_date, query, now=None, _scope=None):
    """Latest declared contrast wins by source date, never by favorable results."""
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or date.fromisoformat(business_date) > clock.astimezone(timezone(timedelta(hours=8))).date():
        raise ValueError('nav_decision_invalid_time')
    policy = daily.POLICY
    if _scope is not None and (query is not _scope.query or business_date != _scope.business_date
            or clock != _scope.now or policy.checksum != _scope.policy_checksum):
        raise ValueError('nav_decision_read_scope_mismatch')
    effect_policy, budget = policy.parameters()
    base = {'schema_version': 'paired-nav-candidate-decision-v1', 'owner': owner,
        'candidate_artifact_id': candidate_artifact_id, 'candidate_checksum': candidate_checksum,
        'as_of_date': business_date, 'policy_checksum': policy.checksum,
        'protocol_id': budget.protocol_id, 'minimum_evaluable_dates': policy.minimum_sessions,
        'maximum_evaluable_dates': policy.final_sessions,
        'validity': 'approximate_fixed_checkpoint_family_adjusted_evidence',
        'historically_predeclared_policy': False, 'universal_profit_guarantee': False,
        'promotion_allowed': False}
    def finish(decision, reason, **fields):
        body = {**base, 'decision': decision, 'reason': reason, **fields}
        return {**body, 'decision_checksum': digest(body), 'decision_payload_json': encode(body)}
    store.validate_review_store(query)
    cache = _scope.sources if _scope is not None else {}
    def source(day, snapshot_ids=None, observed_at=None):
        key = (day, tuple(snapshot_ids) if snapshot_ids is not None else None, observed_at)
        if key not in cache:
            cache[key] = daily._introduced_families(read_verified_nav_evidence(business_date=day, query=query, now=clock,
                _population_snapshot_ids=snapshot_ids, _population_observed_at=observed_at))
        return cache[key]
    latest = source(business_date)
    population = json.loads(latest.population_json)
    pairs = [p for p in population['pairs'] if p['owner'] == owner and p['candidate_checksum'] == candidate_checksum]
    if not pairs:
        return finish('PENDING', 'nav_candidate_not_registered', evaluable_date_count=0)
    latest_signal = max(p['latest_signal_date'] for p in pairs)
    current = [p for p in pairs if p['latest_signal_date'] == latest_signal]
    if len({p['hypothesis_checksum'] for p in current}) != 1:
        return finish('HOLD', 'nav_current_contrast_ambiguous')
    if any(candidate_artifact_id not in p['candidate_artifact_ids'] for p in current):
        return finish('HOLD', 'nav_candidate_registry_identity_unverified')
    identity = current[0]
    latest_allocations = [read_snapshot(query, key) for key in identity['allocation_snapshot_ids']]
    latest_allocations = [saved for saved in latest_allocations if saved['manifest']['signal_date'] == latest_signal]
    if len(latest_allocations) != 1:
        return finish('HOLD', 'nav_current_allocation_ambiguous')
    allocation = latest_allocations[0]['manifest']
    base.update(hypothesis_checksum=identity['hypothesis_checksum'], family_id=identity['family_id'],
        allocation_snapshot_id=allocation['snapshot_id'], allocation_payload_checksum=allocation['payload_checksum'],
        baseline_checksum=identity['baseline_checksum'], configuration_checksum=identity['configuration_checksum'],
        comparison=identity['comparison'], latest_signal_date=latest_signal,
        current_population_checksum=population['population_checksum'],
        current_chain_checksum=latest.coverage['chain_checksum'])
    # Availability vetoes must not erase already verified maturity. This is the
    # exact count of the current contrast, not transferred from another version.
    count = max(p['exact_nav_sessions'] for p in current)
    base['evaluable_date_count'] = count
    if any(p['unaccounted_session_dates'] for p in current):
        return finish('HOLD', 'nav_registered_evidence_missing')
    if any(p['lifecycle_status'] == 'comparison_closed' for p in current):
        return finish('HOLD', 'nav_comparison_closed')
    def relevant(item):
        return item['owner'] == owner or item['owner'] == 'expected_return' and owner in {'l4_alpha_ev', 'allocator_ev_fusion'}
    unresolved = (any(relevant(p) for p in population['unmaterialized_selections'])
        or any(relevant(p) for p in population['unresolved_selection_sources'])
        or any(population[key] for key in (
        'unresolved_legacy_allocation_snapshot_ids', 'unresolved_legacy_execution_snapshot_ids',
        'unresolved_journal_pair_ids')))
    if unresolved:
        return finish('HOLD', 'nav_current_population_incomplete')
    if count < policy.minimum_sessions:
        return finish('PENDING', 'nav_mature_sessions_below_checkpoint')
    checkpoint = policy.final_sessions if count >= policy.final_sessions else policy.minimum_sessions
    review_id = f'sessions_{checkpoint}'
    family_id = identity['family_id']
    review_key = store._key(budget.protocol_id, family_id, review_id)
    if store._header(query, review_key) is None:
        return finish('PENDING', 'nav_checkpoint_review_not_recorded', review_id=review_id)
    review = store.read_review_record(query=query, record_id=review_key)
    protocol = store.read_review_record(query=query, record_id=store._key(budget.protocol_id))
    reservation = store.read_review_record(query=query,
        record_id=store._key(budget.protocol_id, family_id, review_id, 'reservation'))
    for saved in (review, protocol, reservation):
        if saved['header']['as_of_date'] > business_date or _timestamp(saved['header']['created_at']) > clock:
            raise ValueError('nav_decision_future_review_record')
    if (digest(protocol['body']['effect_policy']) != digest(asdict(effect_policy))
            or digest(protocol['body']['budget_policy']) != digest(asdict(budget))):
        raise ValueError('nav_decision_protocol_mismatch')
    original = source(review['body']['as_of_date'], reservation['body'].get('population_snapshot_ids'),
        _timestamp(reservation['header']['created_at']))
    original_population = json.loads(original.population_json)
    original_families = [f for f in original_population['families'] if f['family_id'] == family_id]
    if len(original_families) != 1:
        raise ValueError('nav_decision_review_family_missing')
    expected_reservation = {'schema': 'paired-nav-review-reservation-v1', 'record_kind': 'reservation',
        'protocol_id': budget.protocol_id, 'family_id': family_id, 'review_id': review_id,
        'as_of_date': original.business_date, 'protocol_checksum': protocol['header']['payload_checksum'],
        'chain_checksum': original.coverage['chain_checksum'],
        'population_checksum': original_population['population_checksum'],
        **({'population_snapshot_ids': list(original.population_snapshot_ids)}
            if 'population_snapshot_ids' in reservation['body'] else {}),
        'family': original_families[0],
        'review_alpha': budget.allocation(review_id), 'promotion_allowed': False}
    if digest(expected_reservation) != reservation['header']['payload_checksum']:
        raise ValueError('nav_decision_reservation_source_mismatch')
    reports = _scope.reports if _scope is not None else {}
    report_key = (review_key, review['header']['payload_checksum'], reservation['header']['payload_checksum'],
        protocol['header']['payload_checksum'], original.coverage['chain_checksum'])
    if report_key not in reports:
        reports[report_key] = _review_evidence(original, effect_policy=effect_policy, budget=budget,
            review_id=review_id, family_ids={family_id})
    report = reports[report_key]
    family = report['families'][0]
    expected = store._family_body(report, family, protocol, reservation)
    if digest(expected) != review['header']['payload_checksum']:
        raise ValueError('nav_decision_review_source_mismatch')
    hypotheses = [h for h in family['hypotheses'] if h['hypothesis_checksum'] == identity['hypothesis_checksum']]
    if len(hypotheses) != 1:
        raise ValueError('nav_decision_hypothesis_missing')
    finding = hypotheses[0]
    base.update(review_id=review_id, checkpoint_as_of_date=review['body']['as_of_date'],
        review_record_id=review_key, review_record_checksum=review['header']['payload_checksum'],
        reservation_checksum=reservation['header']['payload_checksum'],
        effect_pair_id=finding['effect_pair_id'], mean_daily_nav_delta=finding['mean_daily_nav_delta'],
        holm_adjusted_p=finding['holm_adjusted_p'], review_alpha=family['review_alpha'],
        review_evidence_unit='original_costed_paired_daily_nav',
        maximum_window_exhausted=count >= policy.final_sessions)
    # A review is immutable evidence of what was known at that checkpoint, not
    # authority to ignore a subsequently verified accounting correction. Check
    # every member of its multiplicity family, not only the winning pair.
    current_series = {p.pair_id: p for p in latest.pairs}
    frontier = []
    for pair_id in sorted(family['pair_ids']):
        observed = current_series.get(pair_id)
        rows = observed.observations if observed else ()
        frontier.append({'pair_id': pair_id, 'accounted_sessions': len(rows),
            'last_session_date': rows[-1].session_date if rows else None,
            'last_journal_checksum': rows[-1].journal_checksum if rows else None})
    base['review_family_journal_frontier'] = frontier
    restated = []
    for pair in original.pairs:
        if pair.pair_id not in family['pair_ids']:
            continue
        current_pair = current_series.get(pair.pair_id)
        if current_pair is None:
            raise ValueError('nav_decision_review_series_missing')
        prefix = tuple(o for o in current_pair.observations if o.session_date <= original.business_date)
        if prefix != pair.observations:
            restated.append(pair.pair_id)
    if restated:
        return finish('HOLD', 'nav_checkpoint_accounting_restated',
            restated_pair_ids=sorted(restated), checkpoint_accounting_current=False,
            next_review_sessions=policy.final_sessions if checkpoint < policy.final_sessions else None,
            correction_policy='retain_original_review_and_budget_use_next_predeclared_checkpoint')
    return finish('PASS' if finding['numerical_support'] else 'HOLD',
        'nav_incremental_support' if finding['numerical_support'] else finding['availability_reason'] or 'nav_incremental_support_insufficient')
