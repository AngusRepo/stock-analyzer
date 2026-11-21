"""Universe-wide source audit before search, independent of candidate holdings."""
from __future__ import annotations
from fractions import Fraction
import json
from services.research_corporate_history import OWNER, CorporateHistoryGap, account_history_snapshot

# Research data-quality gate (Wei 10/30), owned here and only here: a history
# search refuses to run when excluded symbols (blocked or uncovered by the tape)
# are MORE than this share of the window's holdable universe. Exactly 20% runs.
# Not a trading constant: it never reaches Paper, KV or a search parameter.
MAX_EXCLUDED_SYMBOL_SHARE = Fraction(1, 5)


class CorporateExclusionTooHigh(ValueError):
    def __init__(self, report):
        self.report = report
        super().__init__('corporate_history_exclusion_share_exceeded:{}/{} > {}'.format(
            report['excluded_count'], report['holdable_symbols'], report['excluded_share_limit']))


class CorporateCoverageError(ValueError):
    def __init__(self, report):
        self.report = report
        super().__init__('research_corporate_coverage_incomplete:' + json.dumps(report, sort_keys=True))


def is_corporate_data_error(exc):
    return isinstance(exc, (CorporateCoverageError, CorporateExclusionTooHigh, CorporateHistoryGap)) or str(exc).startswith((
        'backtest_corporate_', 'corporate_history_', 'backtest_research_cash_', 'backtest_subscription_',
    ))


def audit_corporate_coverage(dataset, start_date, end_date):
    issues = []
    outstanding = set()
    days = [d for d in dataset.trading_days if start_date <= d <= end_date]
    for day in days:
        universe = set(dataset.get_universe_at(day))
        snapshot = dataset.corporate_sources.get(day)
        if snapshot is None:
            issues.append({'date':day,'reason':'session_missing'})
            continue
        # All possible entitlements in the fixed input universe, not yesterday's holdings.
        outstanding.update(a['action_id'] for a in snapshot['actions']
                           if a['symbol'] in universe and start_date <= a['ex_date'] <= day)
        if snapshot.get('schema_version') == OWNER:
            try:
                account_history_snapshot(snapshot, universe, outstanding_action_ids=outstanding)
            except CorporateHistoryGap as exc:
                issues.append({'date':day,'reason':'issuer_terms_or_coverage_missing',
                               'blockers':exc.requirements['blockers']})
        else:
            missing = sorted(universe - set(snapshot['covered_symbols']))
            blockers = {s:r for s,r in snapshot.get('blockers',{}).items() if s in universe}
            if missing or blockers:
                issues.append({'date':day,'reason':'source_incomplete','missing_symbols':missing,'blockers':blockers})
    return {'status':'ready' if days and not issues else 'blocked',
            'start_date':start_date,'end_date':end_date,'sessions':len(days),
            'issue_count':len(issues),'issues':issues, 'scope':'full_input_universe',
            'candidate_search_started':False, 'production_eligible':False}


def exclude_history_blocked_symbols(dataset, start_date, end_date):
    """Drop issuers whose historical terms are unresolved, before any search.

    Research-history mode only. A symbol that may be held on a session (every
    symbol tradable on or before it in the window) is audited with the full
    window's possible entitlements, a superset of what any simulated account
    can hold. A blocked or uncovered symbol leaves the universe for the whole
    window, because a position opened earlier would reach the blocked session.
    The selection reads blockers up to end_date, so the report names that bias.
    A missing session is never excluded away; the coverage audit still fails.
    """
    days = [d for d in dataset.trading_days if start_date <= d <= end_date]
    excluded, holdable, outstanding = {}, set(), set()
    for day in days:
        holdable |= set(dataset.get_universe_at(day))
        snapshot = dataset.corporate_sources.get(day)
        if snapshot is None:
            continue
        if snapshot.get('schema_version') != OWNER:
            raise ValueError('corporate_history_mode_requires_history_tape:' + day)
        outstanding.update(a['action_id'] for a in snapshot['actions']
                           if a['symbol'] in holdable and start_date <= a['ex_date'] <= day)
        try:
            account_history_snapshot(snapshot, holdable - set(excluded), outstanding_action_ids=outstanding)
        except CorporateHistoryGap as exc:
            for symbol, reasons in exc.requirements['blockers'].items():
                excluded[symbol] = {'first_blocked_session': day, 'reasons': reasons}
    if holdable and holdable <= set(excluded):
        raise ValueError('corporate_history_universe_empty_after_exclusion')
    reasons = {}
    for item in excluded.values():
        for reason in item['reasons']:
            key = reason.split(':')[0]
            reasons[key] = reasons.get(key, 0) + 1
    share = Fraction(len(excluded), len(holdable)) if holdable else Fraction(0)
    report = {'policy': 'exclude_unresolved_history_issuers_for_whole_window',
              'start_date': start_date, 'end_date': end_date,
              'holdable_symbols': len(holdable), 'excluded_count': len(excluded),
              'excluded_share': round(float(share), 6),
              'excluded_share_limit': str(MAX_EXCLUDED_SYMBOL_SHARE),
              'excluded_share_rule': 'fail_when_greater_than_limit',
              'excluded_reason_counts': dict(sorted(reasons.items())),
              'excluded_first_blocked_session': {s: v['first_blocked_session'] for s, v in sorted(excluded.items())},
              'selection_reads_blockers_through_end_date': True}
    if share > MAX_EXCLUDED_SYMBOL_SHARE:  # exact rational comparison: 200/1000 runs, 201/1000 stops
        raise CorporateExclusionTooHigh({k: v for k, v in report.items() if k != 'excluded_first_blocked_session'})
    if excluded:
        dataset.exclude_symbols(set(excluded))
    return report


def require_corporate_coverage(dataset, start_date, end_date):
    report = audit_corporate_coverage(dataset, start_date, end_date)
    if report['status'] != 'ready':
        # Keep exception bounded; the explicit audit API retains the full inventory.
        raise CorporateCoverageError({**report,'issues':report['issues'][:10]})
    return report
