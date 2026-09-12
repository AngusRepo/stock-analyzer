"""Verified chronological raw NAV input, shared by nightly and inference readers.

No p-values, estimated variance bound, dropped dates, or promotion decisions.
Only the complete audit returns evidence; a valid early page is not a receipt.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
from copy import deepcopy
from datetime import datetime, timezone
import math
import json
from typing import Any, Callable

from services.paired_nav_chain import verify_journal_chain, paired_return_interval
from services.paired_nav_journal import Query, digest


@dataclass(frozen=True, slots=True)
class NavObservation:
    session_date: str
    snapshot_id: str
    journal_checksum: str
    previous_journal_checksum: str | None
    candidate_daily_return: float | None
    baseline_daily_return: float | None
    net_return_delta: float | None
    lower: float | None
    upper: float | None
    unavailable_return_reason: str | None = None
    accounting_adjustment_checksum: str | None = None


@dataclass(frozen=True, slots=True)
class PairedNavSeries:
    pair_id: str
    identity: tuple[tuple[str, str], ...]
    observations: tuple[NavObservation, ...]
    comparison: tuple[tuple[str, str], ...] = ()

    @property
    def checksum(self) -> str:
        # Excludes retrieval date/pagination so an unchanged lifecycle prefix
        # retains its identity on nightly retries and later read-only exports.
        return digest(['paired-nav-verified-series-v1', self.identity,
                       [{k: v for k, v in asdict(o).items()
                         if k not in ('unavailable_return_reason', 'accounting_adjustment_checksum') or v is not None}
                        for o in self.observations]])

    def summary(self) -> dict[str, Any]:
        n = len(self.observations)
        exact = sum(o.net_return_delta is not None for o in self.observations)
        complete = exact == n
        unbounded = sum(o.lower is None or o.upper is None for o in self.observations)
        undefined = sum(o.unavailable_return_reason == 'undefined_return_zero_opening_nav'
                        for o in self.observations)
        return {'pair_id': self.pair_id, 'pair_identity': dict(self.identity),
            'comparison': dict(self.comparison) if self.comparison else None,
            'comparison_evidence_checksum': digest([self.checksum, self.comparison]),
            'evidence_checksum': self.checksum, 'accounted_sessions': n,
            **({'restated_nav_sessions': sum(o.accounting_adjustment_checksum is not None for o in self.observations)}
               if any(o.accounting_adjustment_checksum is not None for o in self.observations) else {}),
            'exact_nav_sessions': exact, 'unknown_nav_sessions': n - exact,
            'undefined_return_sessions': undefined,
            'unbounded_return_sessions': unbounded - undefined,
            'first_session': self.observations[0].session_date,
            'latest_session': self.observations[-1].session_date,
            'latest_journal_checksum': self.observations[-1].journal_checksum,
            'mean_daily_nav_delta': math.fsum(o.net_return_delta / n for o in self.observations)
                if complete else None,
            'mean_daily_nav_delta_enclosure': {
                'lower': math.fsum(o.lower / n for o in self.observations) if not unbounded else None,
                'upper': math.fsum(o.upper / n for o in self.observations) if not unbounded else None,
                'kind': 'pathwise_accounting_enclosure_not_confidence_interval' if not unbounded
                        else 'unavailable_due_zero_opening_nav_bound'},
            'sample_status': 'complete' if complete else 'undefined_return' if undefined == n - exact else 'valuation_incomplete',
            'inference_status': 'not_evaluated', 'promotion_allowed': False}


@dataclass(frozen=True)
class VerifiedNavEvidence:
    business_date: str
    coverage: dict[str, Any]
    pairs: tuple[PairedNavSeries, ...]
    population_json: str | None = None
    population_snapshot_ids: tuple[str, ...] = ()

    def summary(self) -> dict[str, Any]:
        return {'schema': 'paired-nav-verified-evidence-v1',
            'as_of_date': self.business_date,
            'chain_checksum': self.coverage['chain_checksum'],
            'endpoint': 'candidate_minus_declared_baseline_costed_daily_nav_return',
            'pairs': [p.summary() for p in self.pairs],
            'candidate_population': json.loads(self.population_json) if self.population_json is not None else None,
            'inference_status': 'not_evaluated', 'promotion_allowed': False}


def read_verified_nav_evidence(*, business_date: str, query: Query, page_size: int = 50,
        observe_prefix: Callable[[dict[str, Any]], None] | None = None,
        now: datetime | None = None, _population_snapshot_ids=None,
        _population_observed_at=None) -> VerifiedNavEvidence:
    """One shared journal scan for complete, chronological accounting evidence.

    Observers must stage in memory; persistence is permitted only after this
    function returns. Runtime accounting does not run statistical assessments.
    Identity/return records here are immutable, detached from observer inputs.
    """
    clock = now or datetime.now(timezone.utc)
    collected: dict[str, list[NavObservation]] = {}
    identities: dict[str, tuple[tuple[str, str], ...]] = {}
    comparisons: dict[str, tuple[tuple[str, str], ...]] = {}
    prefixes: dict[str, list[dict]] = {}

    def receive(prefix: dict[str, Any]) -> None:
        pair = prefix['pair_id']
        prefixes.setdefault(pair, []).append(deepcopy(prefix))
        rows = collected.setdefault(pair, [])
        identities.setdefault(pair, tuple(sorted(prefix['pair_identity'].items())))
        comparison = tuple(sorted((prefix.get('comparison') or {}).items()))
        comparisons.setdefault(pair, comparison)
        if (prefix['accounted_sessions'] != len(rows) + 1
                or comparisons[pair] != comparison
                or prefix['previous_journal_checksum'] != (rows[-1].journal_checksum if rows else None)
                or tuple(sorted(prefix['pair_identity'].items())) != identities[pair]):
            raise RuntimeError('paired_nav_verified_series_prefix_mismatch')
        enclosure = prefix['return_enclosure']
        rows.append(NavObservation(**{k: prefix[k] for k in (
            'session_date', 'snapshot_id', 'journal_checksum', 'previous_journal_checksum',
            'candidate_daily_return', 'baseline_daily_return', 'net_return_delta')},
            lower=enclosure['lower'], upper=enclosure['upper'],
            unavailable_return_reason=enclosure['kind'] if enclosure['lower'] is None else None))

    coverage = verify_journal_chain(business_date=business_date, query=query,
        page_size=page_size, observe_prefix=receive, now=clock)
    pairs = tuple(PairedNavSeries(key, identities[key], tuple(rows), comparisons[key]) for key, rows in collected.items())
    if (sum(len(p.observations) for p in pairs) != coverage['accounted_sessions']
            or sum(o.net_return_delta is not None for p in pairs for o in p.observations) != coverage['sessions']):
        raise RuntimeError('paired_nav_verified_series_coverage_mismatch')
    # Only the fully verified, actually observable journal may correct earlier
    # economic endpoints. Retain raw journals and dates; no old signal/fill is
    # recreated, and no projection is published from a partial prefix.
    pairs = tuple(_restate_cash_series(p, prefixes[p.pair_id]) for p in pairs)
    if any(o.accounting_adjustment_checksum for p in pairs for o in p.observations):
        coverage = {**coverage, 'raw_exact_sessions': coverage['sessions'],
            'sessions': sum(o.net_return_delta is not None for p in pairs for o in p.observations),
            'bounded_sessions': sum(o.lower is not None and o.upper is not None for p in pairs for o in p.observations)}
    from services.paired_nav_population import read_candidate_population
    census = []
    population = read_candidate_population(business_date=business_date, query=query,
        series=pairs, page_size=page_size, now=clock, _snapshot_ids=_population_snapshot_ids,
        _capture_snapshot_ids=census.extend, _observed_at=_population_observed_at)
    if observe_prefix is not None:
        for pair in pairs:
            exact = 0
            for old, observation in zip(prefixes[pair.pair_id], pair.observations):
                exact += observation.net_return_delta is not None
                observe_prefix({**deepcopy(old), 'exact_nav_sessions': exact,
                    'candidate_daily_return': observation.candidate_daily_return,
                    'baseline_daily_return': observation.baseline_daily_return,
                    'net_return_delta': observation.net_return_delta,
                    'return_enclosure': {'lower': observation.lower, 'upper': observation.upper,
                        'exact': observation.lower is not None and observation.lower == observation.upper,
                        'kind': observation.unavailable_return_reason or 'pathwise_accounting_enclosure_not_confidence_interval'},
                    **({'accounting_adjustment_checksum': observation.accounting_adjustment_checksum}
                       if observation.accounting_adjustment_checksum else {})})
    return VerifiedNavEvidence(business_date, coverage, pairs,
        json.dumps(population, sort_keys=True, separators=(',', ':'), allow_nan=False), tuple(census))


def _restate_cash_series(pair, prefixes):
    """As-of correction view of existing observations, never a new sample.

    Fixed cash rights belong in every endpoint from ex-date until their actual
    recognition. Newer observable correction receipts change this projection's
    checksum, not the original journal or the date a decision could be made.
    """
    corrections = [(arm, correction, prefix['journal_checksum'], prefix['cash_restatement']['available_at'])
        for prefix in prefixes for arm, values in prefix['cash_restatement']['corrections'].items()
        for correction in values]
    if not corrections:
        return pair
    rows = []
    def account(bounds):
        low, high = bounds
        return {'nav': low} if low == high else {'nav': None, 'valuation_complete': False,
            'nav_lower_bound': low, 'nav_upper_bound': high}
    for observation, prefix in zip(pair.observations, prefixes):
        raw = prefix['cash_restatement']
        previous_day, day = raw['previous_session_date'], observation.session_date
        opening = {arm: list(values) for arm, values in raw['opening_bounds'].items()}
        closing = {arm: list(values) for arm, values in raw['closing_bounds'].items()}
        applied = []
        for arm, correction, checksum, available in corrections:
            start, stop = correction['ex_date'], correction['recognized_date']
            old = previous_day is not None and start <= previous_day < stop
            new = start <= day < stop
            if old or new:
                amount = correction['cash_due']
                if old:
                    opening[arm] = [v + amount for v in opening[arm]]
                if new:
                    closing[arm] = [v + amount for v in closing[arm]]
                applied.append([arm, correction, checksum, available, old, new])
        if not applied:
            rows.append(observation)
            continue
        interval = paired_return_interval({a: account(v) for a, v in opening.items()},
            {a: account(v) for a, v in closing.items()})
        returns = {a: closing[a][0] / v[0] - 1 if v[0] > 0 and v[0] == v[1]
            and closing[a][0] == closing[a][1] else None for a, v in opening.items()}
        delta = returns['candidate'] - returns['baseline'] if all(v is not None for v in returns.values()) else None
        rows.append(replace(observation, candidate_daily_return=returns['candidate'], baseline_daily_return=returns['baseline'],
            net_return_delta=delta, lower=interval['lower'], upper=interval['upper'],
            unavailable_return_reason=interval['kind'] if interval['lower'] is None else None,
            accounting_adjustment_checksum=digest(['cash-endpoint-restatement-v1', observation.journal_checksum, applied])))
    return replace(pair, observations=tuple(rows))
