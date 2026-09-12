"""Reproducible accounting controls, not observed investment performance.

Run from ml-controller. No network, writes, training, orders or promotion.
The price-only comparator matches the audited d45d0eaf daily-snapshot inputs
(settled cash + marked positions + net settlement; no corporate receivable).
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from services.paired_nav_journal import replay_session, account_value


def compare() -> dict:
    rows = []
    fees = {'commission': .001425, 'minCommission': 20, 'tax': .003, 'dayTradeTax': .0015}
    for shares in (100, 1000, 2000):
        initial = {'cash': 99000., 'positions': {'2330': shares}, 'nav': 99000. + 100 * shares}
        action = {'action_id': 'synthetic-dividend', 'symbol': '2330', 'kind': 'cash',
            'ex_date': '2026-09-07', 'payable_date': '2026-09-09', 'cash_per_share': 2., 'stock_per_share': 0.}
        ex = replay_session(previous=initial, fills=[], marks={'2330': 98.}, corporate_actions=[action],
            session_date='2026-09-07', fees=fees)
        paid = replay_session(previous=ex, fills=[], marks={'2330': 98.}, corporate_actions=[action],
            session_date='2026-09-09', fees=fees)
        price_only = initial['cash'] + 98 * shares
        rows.append({'shares': shares, 'opening_cash': initial['cash'], 'opening_nav': initial['nav'],
            'price_only_ex_nav': price_only, 'corrected_ex_nav': ex['nav'],
            'difference_twd': ex['nav'] - price_only,
            'price_only_return_pct': 100 * (price_only / initial['nav'] - 1),
            'corrected_return_pct': 100 * ex['daily_return'],
            'ex_cash': ex['cash'], 'ex_receivable': ex['corporate_receivables'][0]['cash_due'],
            'payment_cash': paid['cash'], 'payment_nav': paid['nav']})
    missing = {'cash': 99000., 'positions': {'2330': 1000}, 'nav': 199000.}
    try:
        account_value(missing, {})
    except ValueError as exc:
        missing_result = {'legacy_partial_value': 99000., 'corrected_nav': None,
                          'decision': 'INVALID_HELD_MARK', 'reason': str(exc)}
    else:
        raise AssertionError('Missing mark was accepted')
    assert all(row['opening_nav'] == row['corrected_ex_nav'] == row['payment_nav'] for row in rows)
    return {'evidence_class': 'synthetic_accounting_controls',
        'baseline_source_commit': 'd45d0eaf86035223b0db7f8bb9a67b86de819c80',
        'real_strategy_performance': False, 'statistical_significance_claim': False,
        'tax_basis': 'gross_before_personal_tax', 'dividend_cases': rows,
        'missing_mark_case': missing_result, 'production_effect': False, 'promotion_allowed': False}


if __name__ == '__main__':
    print(json.dumps(compare(), ensure_ascii=False, indent=2, allow_nan=False))
