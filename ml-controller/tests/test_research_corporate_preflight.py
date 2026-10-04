from types import SimpleNamespace
import pytest
from services.research_corporate_preflight import audit_corporate_coverage, require_corporate_coverage, CorporateCoverageError, is_corporate_data_error


def dataset(tape):
    return SimpleNamespace(trading_days=['2026-07-13','2026-07-14'], corporate_sources=tape,
                           get_universe_at=lambda day: {'1231','2330'})


def test_missing_session_blocks_before_any_search():
    with pytest.raises(CorporateCoverageError) as err:
        require_corporate_coverage(dataset({}), '2026-07-13','2026-07-14')
    assert err.value.report['issue_count'] == 2
    assert err.value.report['candidate_search_started'] is False


def test_coverage_checks_candidate_universe_not_current_holdings():
    tape = {d:{'covered_symbols':['2330'],'actions':[],'blockers':{}} for d in ['2026-07-13','2026-07-14']}
    report = audit_corporate_coverage(dataset(tape), '2026-07-13','2026-07-14')
    assert report['issues'][0]['missing_symbols'] == ['1231']
    for row in tape.values(): row['covered_symbols'].append('1231')
    assert require_corporate_coverage(dataset(tape), '2026-07-13','2026-07-14')['status'] == 'ready'


def test_data_failure_is_not_a_bad_strategy_fitness():
    assert is_corporate_data_error(ValueError('backtest_corporate_source_missing:2026-07-13'))
    assert not is_corporate_data_error(ValueError('candidate_constraint_invalid'))
