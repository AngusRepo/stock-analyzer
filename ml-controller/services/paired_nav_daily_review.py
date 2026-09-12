"""Code-owned daily NAV review orchestration, not a serving-pointer writer.

Candidate collection and accounting continue daily. Named numerical reviews use
predefined10/30-session checkpoints, not unlimited daily repeated significance
tests. Raw dates/returns are never rewritten or inherited across hypotheses.
"""
from collections import defaultdict
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import json
from pathlib import Path

from services.paired_nav_effect_inference import NavEffectPolicy
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_family_review import NavReviewBudget
from services.paired_nav_journal import digest, encode
from services.paired_nav_review_store import record_nav_family_reviews, validate_review_store


class NavDailyReviewIncomplete(RuntimeError):
    """Preserve verified accounting and exact review failures for retry telemetry."""

    def __init__(self, maturity):
        super().__init__('paired_nav_daily_review_incomplete')
        self.nav_maturity = maturity


_DEFAULT_POLICY = json.loads(Path(__file__).with_name('paired_nav_review_policy.json').read_text(encoding='utf-8'))


@dataclass(frozen=True)
class DailyNavReviewPolicy:
    revision: str = _DEFAULT_POLICY['revision']
    minimum_sessions: int = _DEFAULT_POLICY['minimum_sessions']
    final_sessions: int = _DEFAULT_POLICY['final_sessions']
    family_alpha: float = _DEFAULT_POLICY['family_alpha']
    block_length: int = _DEFAULT_POLICY['block_length']
    resamples: int = _DEFAULT_POLICY['resamples']
    family_scope: str = _DEFAULT_POLICY['family_scope']

    def __post_init__(self):
        if (type(self.minimum_sessions) is not int or type(self.final_sessions) is not int
                or self.final_sessions <= self.minimum_sessions):
            raise ValueError('nav_daily_invalid_checkpoints')
        NavEffectPolicy(self.revision, self.minimum_sessions, self.family_alpha / 2,
            self.block_length, self.resamples)

    @property
    def checksum(self):
        return digest(asdict(self))

    def parameters(self):
        # Nominal5% per introduced family, split equally between TWO fixed looks.
        # This is an engineering policy, not a universal-market guarantee or law.
        protocol = self.revision + ':' + self.checksum
        return (NavEffectPolicy(protocol, self.minimum_sessions, self.family_alpha / 2,
                    self.block_length, self.resamples),
                NavReviewBudget(protocol, self.family_alpha,
                    ((f'sessions_{self.minimum_sessions}', self.family_alpha / 2),
                     (f'sessions_{self.final_sessions}', self.family_alpha / 2))))


POLICY = DailyNavReviewPolicy()


def _introduced_families(evidence):
    """Partition original identities, never observed performance or new labels.

    Alias labels and later training-registry edits cannot create another review
    episode for an already-frozen economic hypothesis. Raw evidence is retained.
    """
    population = json.loads(evidence.population_json)
    introductions = {}
    for item in population['pairs']:
        key = item['hypothesis_checksum']
        introductions[key] = min(introductions.get(key, item['first_signal_date']), item['first_signal_date'])
    groups = defaultdict(list)
    for item in population['pairs']:
        first_date = introductions[item['hypothesis_checksum']]
        family_id = digest(['paired-nav-introduction-family-v1', item['owner'], first_date])
        item['inventory_family_id'] = item['family_id']
        item['family_id'] = family_id
        item['hypothesis_introduction_date'] = first_date
        groups[family_id].append(item)
    families = []
    for key, members in sorted(groups.items()):
        hypotheses = sorted({p['hypothesis_checksum'] for p in members})
        families.append({'family_id': key, 'owner': members[0]['owner'],
            'introduction_date': members[0]['hypothesis_introduction_date'],
            'hypothesis_count': len(hypotheses), 'hypothesis_checksums': hypotheses,
            'pair_ids': sorted(p['pair_id'] for p in members)})
    original_checksum = population.pop('population_checksum')
    population.update(families=families, source_population_checksum=original_checksum,
        scope='first_frozen_hypothesis_introduction_families',
        hypothesis_count=sum(f['hypothesis_count'] for f in families))
    population['population_checksum'] = digest(population)
    return replace(evidence, population_json=encode(population))


def run_daily_nav_reviews(*, business_date, query, writer, now=None):
    """The daily owner supplies policy; callers cannot pick alpha or protocol ID.

    Catch-up uses the ORIGINAL checkpoint date, not all extra available outcomes.
    Failures remain explicit; an unevaluable challenger never disables incumbent
    trading. Recording still grants no promotion authority.
    """
    validate_review_store(query)
    clock = now or datetime.now(timezone.utc)
    policy = POLICY
    effect, budget = policy.parameters()
    cache = {}
    def source(*, business_date, query, _population_snapshot_ids=None, _population_observed_at=None):
        key = (business_date, tuple(_population_snapshot_ids) if _population_snapshot_ids is not None else None,
            _population_observed_at)
        if key not in cache:
            cache[key] = _introduced_families(read_verified_nav_evidence(
                business_date=business_date, query=query, now=clock,
                _population_snapshot_ids=_population_snapshot_ids, _population_observed_at=_population_observed_at))
        return cache[key]
    latest = source(business_date=business_date, query=query)
    population = json.loads(latest.population_json)
    series = {p.pair_id: p for p in latest.pairs}
    due = defaultdict(set)
    waiting = []
    for family in population['families']:
        for checkpoint in (policy.minimum_sessions, policy.final_sessions):
            dates = [series[key].observations[checkpoint-1].session_date
                for key in family['pair_ids'] if key in series and len(series[key].observations) >= checkpoint]
            review_id = f'sessions_{checkpoint}'
            if dates:
                due[(review_id, min(dates))].add(family['family_id'])
            else:
                waiting.append({'family_id': family['family_id'], 'review_id': review_id,
                    'required_sessions': checkpoint, 'status': 'accumulating'})
    runs, failures = [], []
    unresolved = {key: len(population[key]) for key in (
        'unmaterialized_selections', 'unresolved_selection_sources',
        'unresolved_legacy_allocation_snapshot_ids', 'unresolved_legacy_execution_snapshot_ids',
        'unresolved_journal_pair_ids') if population[key]}
    if unresolved:
        failures.append({'reason': 'nav_daily_population_unresolved', 'counts': unresolved})
    missing_registered = [{'pair_id': p['pair_id'], 'session_dates': p['unaccounted_session_dates']}
        for p in population['pairs'] if p['unaccounted_session_dates']]
    if missing_registered:
        failures.append({'reason': 'nav_daily_registered_evidence_missing', 'pairs': missing_registered})
    for (review_id, cutoff), family_ids in sorted(due.items(), key=lambda item: (item[0][1], item[0][0])):
        try:
            result = record_nav_family_reviews(business_date=cutoff, query=query, writer=writer,
                effect_policy=effect, budget=budget, review_id=review_id, now=clock,
                _source_loader=source, _family_ids=family_ids)
            runs.append({'review_id': review_id, 'checkpoint_as_of_date': cutoff, 'result': result})
            failures.extend(result['failures'])
            for wait in result['waiting_families']:
                critical = [reason for reason in wait['reasons'] if reason in {
                    'family_denominator_unresolved', 'registered_evidence_missing', 'tail_resolution_insufficient'}]
                if critical:
                    failures.append({'family_id': wait['family_id'], 'review_id': review_id,
                        'checkpoint_as_of_date': cutoff, 'reason': 'nav_daily_review_source_incomplete',
                        'blockers': critical})
        except Exception as exc:
            failures.append({'review_id': review_id, 'checkpoint_as_of_date': cutoff,
                'family_ids': sorted(family_ids), 'error_type': type(exc).__name__,
                'reason': 'nav_daily_review_failed'})
    return {'schema': 'paired-nav-daily-reviews-v1', 'as_of_date': business_date,
        'policy': asdict(policy), 'policy_checksum': policy.checksum,
        'status': 'partial_daily_nav_reviews' if failures else 'daily_nav_reviews_current',
        'source_population_checksum': population['source_population_checksum'],
        'families': population['families'], 'runs': runs, 'waiting_checkpoints': waiting,
        **({'pending_dependencies': population['pending_dependencies']} if population.get('pending_dependencies') else {}),
        'failures': failures, 'promotion_allowed': False,
        'policy_provenance': 'code_owned_not_historically_predeclared'}
