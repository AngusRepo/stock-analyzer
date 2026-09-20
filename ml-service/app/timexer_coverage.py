"""Reject missing market panels before expensive TimeXer fitting."""
from collections import Counter

MIN_COVERAGE = 0.80

def validate_market_coverage(rows, expected_by_date, dates):
    expected = Counter()
    for day in dates:
        expected.update(expected_by_date.get(day, {}))
    actual = Counter(r['market'] for r in rows if r['date'] in dates)
    if not expected:
        raise ValueError('timexer_expected_market_panel_missing')
    report = {market: {'expected': count, 'observed': actual[market],
                       'coverage': actual[market] / count}
              for market, count in sorted(expected.items()) if count > 0}
    failed = {market: item for market, item in report.items() if item['coverage'] < MIN_COVERAGE}
    if failed:
        raise ValueError('timexer_source_market_coverage_incomplete:' + str(failed))
    return report
