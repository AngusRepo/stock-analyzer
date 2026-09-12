"""NAV family comparison over the original candidate denominator.

Numerical review only until a durable pre-outcome review owner supplies/attests
the policy. Fixed-sample bootstrap p-values are approximate, so Holm does not
magically provide unconditional or time-uniform error guarantees.
"""
from collections import defaultdict
from dataclasses import asdict, dataclass
from decimal import Decimal
import json
import math

from services.paired_nav_effect_inference import NavEffectPolicy, _evaluate_pair
from services.paired_nav_evidence import read_verified_nav_evidence
from services.paired_nav_journal import Query, digest


@dataclass(frozen=True)
class NavReviewBudget:
    protocol_id: str
    family_alpha: float
    review_alphas: tuple[tuple[str, float], ...]

    def __post_init__(self):
        if not isinstance(self.protocol_id, str) or not self.protocol_id.strip():
            raise ValueError('nav_review_protocol_missing')
        if not _probability(self.family_alpha) or self.family_alpha >= .5:
            raise ValueError('nav_review_invalid_family_alpha')
        if type(self.review_alphas) is not tuple or not self.review_alphas:
            raise ValueError('nav_review_schedule_missing')
        ids = set()
        for item in self.review_alphas:
            if (type(item) is not tuple or len(item) != 2
                    or not isinstance(item[0], str) or not item[0].strip()
                    or item[0] in ids or not _probability(item[1])):
                raise ValueError('nav_review_invalid_schedule')
            ids.add(item[0])
        if sum((Decimal(str(a)) for _, a in self.review_alphas), Decimal(0)) > Decimal(str(self.family_alpha)):
            raise ValueError('nav_review_budget_exceeded')

    def allocation(self, review_id: str) -> float:
        allocations = dict(self.review_alphas)
        if not isinstance(review_id, str) or review_id not in allocations:
            raise ValueError('nav_review_unallocated_review')
        return allocations[review_id]


def _probability(value):
    return type(value) in (int, float) and math.isfinite(value) and 0 < value <= 1


def holm_adjust(p_values: dict[str, float | None]) -> dict[str, float | None]:
    """Unavailable tests remain in the multiplicity count, not labeled failures.

    None is only represented internally by1 for ordering/adjustment. External
    reports retain None, avoiding a manufactured observed p-value of1.
    """
    for value in p_values.values():
        if value is not None and (type(value) not in (int, float)
                or not math.isfinite(value) or not 0 <= value <= 1):
            raise ValueError('nav_review_invalid_p_value')
    ordered = sorted(p_values, key=lambda key: (1 if p_values[key] is None else p_values[key], key))
    adjusted, maximum = {}, 0.
    for index, key in enumerate(ordered):
        value = p_values[key]
        maximum = max(maximum, min(1., (len(ordered) - index) * (1 if value is None else value)))
        adjusted[key] = None if value is None else maximum
    return {key: adjusted[key] for key in sorted(adjusted)}


def review_nav_families(*, business_date: str, query: Query,
                        effect_policy: NavEffectPolicy, budget: NavReviewBudget,
                        review_id: str, page_size: int = 50, now=None) -> dict:
    """Single original source read; no filtering by gains or registry survival.

    The named allocation is calculated, NOT claimed as durably reserved/spent.
    Missing complete family selection blocks a family decision, not accounting.
    No formal consumer may use numerical support as serving authority.
    """
    budget.allocation(review_id)  # Reject unknown looks before any I/O.
    evidence = read_verified_nav_evidence(business_date=business_date, query=query, page_size=page_size, now=now)
    return _review_evidence(evidence, effect_policy=effect_policy, budget=budget, review_id=review_id)


def _review_evidence(evidence, *, effect_policy, budget, review_id, family_ids=None):
    """Internal: storage uses the verified immutable input AFTER reservation."""
    alpha = budget.allocation(review_id)
    population = json.loads(evidence.population_json)
    selected = {p['pair_id'] for p in population['pairs'] if family_ids is None or p['family_id'] in family_ids}
    effects = {pair.pair_id: _evaluate_pair(pair, effect_policy) for pair in evidence.pairs
        if family_ids is None or pair.pair_id in selected}
    groups = defaultdict(list)
    for pair in population['pairs']:
        groups[pair['family_id']].append(pair)
    legacy_unknown = any(population[key] for key in ('unresolved_legacy_allocation_snapshot_ids',
        'unresolved_legacy_execution_snapshot_ids', 'unresolved_journal_pair_ids'))
    families = []
    for family in population['families']:
        if family_ids is not None and family['family_id'] not in family_ids:
            continue
        owner = family['owner']
        missing = [item for item in population['unmaterialized_selections'] if item['owner'] == owner]
        unknown = [item for item in population['unresolved_selection_sources']
            if item['owner'] == owner or item['owner'] == 'expected_return'
            and owner in {'l4_alpha_ev', 'allocator_ev_fusion'}]
        hypotheses = defaultdict(list)
        for pair in groups[family['family_id']]:
            hypotheses[pair['hypothesis_checksum']].append(pair)
        items = []
        for key, aliases in sorted(hypotheses.items()):
            observed = [p for p in aliases if p['pair_id'] in effects]
            reason, effect = None, None
            if len(observed) > 1:
                reason = 'multiple_executions_for_same_hypothesis'
            elif not observed:
                reason = 'nav_evidence_missing'
            else:
                source = observed[0]
                effect = effects[source['pair_id']]
                if any(p['unaccounted_session_dates'] for p in aliases):
                    reason = 'registered_evidence_missing'
                elif source['lifecycle_status'] == 'comparison_closed':
                    reason = 'comparison_closed'
                elif effect['inference_status'] != 'evaluated_fixed_sample':
                    reason = effect['reason']
            items.append({'hypothesis_checksum': key, 'pair_ids': sorted(p['pair_id'] for p in aliases),
                'effect_pair_id': observed[0]['pair_id'] if len(observed) == 1 else None,
                'availability_reason': reason,
                'raw_positive_tail_p': effect['bootstrap_positive_tail_p'] if reason is None else None,
                'mean_daily_nav_delta': effect['mean_daily_nav_delta'] if effect else None})
        adjusted = holm_adjust({item['hypothesis_checksum']: item['raw_positive_tail_p'] for item in items})
        unresolved = bool(missing or unknown or legacy_unknown)
        minimum_p = len(items) / (effect_policy.resamples + 1)
        for item in items:
            p = adjusted[item['hypothesis_checksum']]
            item.update(holm_adjusted_p=p,
                numerical_support=not unresolved and minimum_p <= alpha and p is not None and p <= alpha
                    and item['mean_daily_nav_delta'] is not None and item['mean_daily_nav_delta'] > 0,
                promotion_allowed=False)
        families.append({**family, 'review_alpha': alpha,
            'minimum_resolvable_holm_p': minimum_p,
            'tail_resolution_sufficient': minimum_p <= alpha,
            'denominator_status': 'unresolved' if unresolved else 'materialized_hypotheses_complete',
            'unmaterialized_selections': missing, 'unresolved_selection_sources': unknown,
            'hypotheses': items, 'promotion_allowed': False})
    body = {'schema': 'paired-nav-family-review-v1', 'as_of_date': evidence.business_date,
        'chain_checksum': evidence.coverage['chain_checksum'], 'candidate_population': population,
        'effect_policy': asdict(effect_policy), 'budget_policy': asdict(budget),
        'review_id': review_id, 'review_alpha': alpha, 'families': families,
        'effects': [effects[key] for key in sorted(effects)],
        'budget_status': 'calculated_not_durably_reserved',
        'policy_provenance': 'caller_supplied_not_preoutcome_attested',
        'validity': 'conditional_on_valid_fixed_sample_p_values_and_preallocated_reviews',
        'universal_finite_sample_guarantee': False, 'promotion_allowed': False}
    return {**body, 'review_checksum': digest(body)}
