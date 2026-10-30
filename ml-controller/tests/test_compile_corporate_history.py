"""Compiler driver for the research corporate-history artifact: sealed local sources only."""
import hashlib
import json
import sys
from pathlib import Path

import polars as pl
import pytest

from services.research_corporate_history import OWNER, load_history_artifact, load_history_tape

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

DAYS = ['2026-09-03', '2026-09-04', '2026-09-07']
CAPTURED = '2026-10-03T01:00:00+00:00'

def write(path, frame_or_obj):
    if isinstance(frame_or_obj, pl.DataFrame):
        frame_or_obj.write_parquet(path)
    else:
        path.write_text(json.dumps(frame_or_obj, ensure_ascii=False), encoding='utf-8')
    return path.name


def spec_fixture(tmp_path):
    from test_finlab_corporate_actions import row
    from services.research_corporate_history import COMPANY_EVENT_CATALOGS
    fetched = '2026-10-03T00:00:00+00:00'
    sources = {'finlab.dividend_announcement': write(tmp_path / 'div.parquet', pl.DataFrame([row(
        **{'除息交易日': '2026-09-07', '除權交易日': None, '現金股利發放日': '2026-10-08'})]))}
    for i, key in enumerate(COMPANY_EVENT_CATALOGS):
        sources['finlab.' + key] = write(tmp_path / f'cat{i}.parquet',
                                         pl.DataFrame({'date': ['2026-05-05'], '8109': ['1150505']}))
    sources['finlab.tw_etf_dividend_events'] = write(tmp_path / 'etf.parquet', pl.DataFrame({
        'symbol': ['0056'], 'date': ['2026-09-04'], '收益分配基準日': ['2026-09-08'],
        '收益分配發放日': ['2026-09-20'], '收益分配金額(每1受益權單位)': [1.], '收益分配標準': ['元以下全捨']}))
    sources['finlab.etf_split:恢復買賣日期'] = write(tmp_path / 'split.parquet',
                                               pl.DataFrame({'date': ['2026-06-17'], '0050': ['2026-06-24']}))
    sources['official.etf_registry'] = write(tmp_path / 'registry.json', ['0050', '0056'])
    spec = {'days': [*DAYS, '2026-10-05'], 'universe': ['0056', '2330', '1101', '020000'],
            'sources': {k: {'path': v, 'fetched_at': fetched} for k, v in sources.items()}}
    return spec


def test_driver_compiles_sealed_sources_and_reports_the_gap(tmp_path):
    from compile_corporate_history import compile_history, gap_report
    spec = spec_fixture(tmp_path)
    frame, days, scoped, unscoped = compile_history(spec, base=tmp_path, captured_at='2026-10-03T01:00:00+00:00')
    assert days == DAYS  # 10-05 is after the capture day: a named gap, never fabricated
    assert scoped == ['1101', '2330', '0056'] and unscoped == ['020000']
    tape = load_history_tape(frame)
    assert all(tape[d]['schema_version'] == OWNER for d in DAYS)
    assert sorted(a['symbol'] for a in tape['2026-09-07']['actions']) == ['0056', '2330']
    refs = json.loads(frame['record_json'][0])['source_refs']
    assert all(r['uri'].startswith('file://') and len(r['sha256']) == 64 for r in refs)
    out = tmp_path / 'history.parquet'
    frame.write_parquet(out)
    load_history_artifact(out, hashlib.sha256(out.read_bytes()).hexdigest())
    report = gap_report(frame, days=days, calendar=spec['days'], target_end='2026-11-06')
    assert report['sessions_short_of_target'] == ['2026-10-05'] and report['target_end_reached'] is False


def test_driver_refuses_missing_or_late_sources(tmp_path):
    from compile_corporate_history import compile_history
    spec = spec_fixture(tmp_path)
    spec['sources'].pop('finlab.par_value_change_otc:恢復買賣日期')
    with pytest.raises(ValueError, match='sources_missing:finlab.par_value_change_otc'):
        compile_history(spec, base=tmp_path, captured_at=CAPTURED)
    spec = spec_fixture(tmp_path)
    spec['sources']['finlab.dividend_announcement']['fetched_at'] = '2026-10-04T00:00:00+00:00'
    with pytest.raises(ValueError, match='source_ref_invalid'):
        compile_history(spec, base=tmp_path, captured_at=CAPTURED)
    spec = spec_fixture(tmp_path)
    spec['sources']['finlab.dividend_announcement']['fetched_at'] = '2026-10-03T00:00:00'
    with pytest.raises(ValueError, match='fetch_clock_timezone_missing'):
        compile_history(spec, base=tmp_path, captured_at=CAPTURED)


def test_sessions_after_the_oldest_source_fetch_are_a_gap_not_no_action(tmp_path):
    from compile_corporate_history import compile_history
    spec = spec_fixture(tmp_path)
    # One catalog fetched 08:30 TW on 09-04, before that session's 09:00 vendor cutoff.
    spec['sources']['finlab.capital_reduction_otc:恢復買賣日期']['fetched_at'] = '2026-09-04T00:30:00+00:00'
    _, days, _, _ = compile_history(spec, base=tmp_path, captured_at=CAPTURED)
    assert days == DAYS[:1]
