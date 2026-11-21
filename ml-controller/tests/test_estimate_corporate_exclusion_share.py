"""Pre-export exclusion share per search window: the production gate decides, exit 4 stops the route."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

import estimate_corporate_exclusion_share as est  # noqa: E402
from test_compile_corporate_history import DAYS, spec_fixture  # noqa: E402


@pytest.fixture
def directory(tmp_path):
    from compile_corporate_history import compile_history
    frame, _, _, _ = compile_history(spec_fixture(tmp_path), base=tmp_path, captured_at='2026-10-03T01:00:00+00:00')
    out = tmp_path / 'run'
    (out / 'd1').mkdir(parents=True)
    frame.write_parquet(out / 'corporate_history.parquet')
    stocks = [{'symbol': s, 'market': 'TWSE', 'listed_date': None, 'delisted_date': None} for s in ('2330', '1101')]
    (out / 'd1' / 'stocks_raw.json').write_text(json.dumps([{'results': stocks, 'meta': {'changes': 0}}]))
    return out


def test_windows_are_calendar_days_back_from_the_end_and_use_the_real_gate(directory, capsys):
    assert est.main([str(directory), '--end', DAYS[-1], '--windows', '2,90']) == 0
    results = json.loads(capsys.readouterr().out)
    assert [r['window_days'] for r in results] == [2, 90]
    assert results[0]['start_date'] == '2026-09-07' and results[1]['start_date'] == DAYS[0]
    assert all(r['excluded_share_limit'] == '1/5' and r['holdable_symbols'] == 2 for r in results)


@pytest.mark.parametrize('excluded, code', [(199, 0), (200, 0), (201, 4)])
def test_a_window_above_one_fifth_exits_4(directory, monkeypatch, capsys, excluded, code):
    from fractions import Fraction
    from services import research_corporate_preflight as gate
    def fake(dataset, start, end):
        report = {'start_date': start, 'end_date': end, 'excluded_count': excluded, 'holdable_symbols': 1000,
                  'excluded_share': excluded / 1000, 'excluded_share_limit': '1/5', 'excluded_reason_counts': {}}
        if Fraction(excluded, 1000) > gate.MAX_EXCLUDED_SYMBOL_SHARE:
            raise gate.CorporateExclusionTooHigh(report)
        return report
    monkeypatch.setattr(gate, 'exclude_history_blocked_symbols', fake)
    assert est.main([str(directory), '--end', DAYS[-1], '--windows', '90,365']) == code
    captured = capsys.readouterr()
    statuses = [r['status'] for r in json.loads(captured.out)]
    assert statuses == (['STOPS', 'STOPS'] if code else ['runs', 'runs'])
    assert ('EXCLUSION_SHARE_ABOVE_LIMIT:90,365' in captured.err) == bool(code)
