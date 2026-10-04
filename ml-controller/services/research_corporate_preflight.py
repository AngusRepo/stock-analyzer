"""Universe-wide source audit before search, independent of candidate holdings."""
from __future__ import annotations
import json
from services.research_corporate_history import OWNER, CorporateHistoryGap, account_history_snapshot


class CorporateCoverageError(ValueError):
    def __init__(self, report):
        self.report = report
        super().__init__('research_corporate_coverage_incomplete:' + json.dumps(report, sort_keys=True))


def is_corporate_data_error(exc):
    return isinstance(exc, (CorporateCoverageError, CorporateHistoryGap)) or str(exc).startswith((
        'backtest_corporate_', 'corporate_history_', 'backtest_research_cash_',
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


def require_corporate_coverage(dataset, start_date, end_date):
    report = audit_corporate_coverage(dataset, start_date, end_date)
    if report['status'] != 'ready':
        # Keep exception bounded; the explicit audit API retains the full inventory.
        raise CorporateCoverageError({**report,'issues':report['issues'][:10]})
    return report
