"""Source fetch for the corporate-history compile: env-only auth, sealed once, no network in tests."""
import json
import sys
from itertools import count
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

import fetch_corporate_history_sources as fetcher  # noqa: E402

SECRET = 'not-a-real-token-7f3a'
DAYS = ['2026-09-03', '2026-09-04', '2026-09-07']


def vendor(key):
    from test_finlab_corporate_actions import row
    if key == 'dividend_announcement':
        return pd.DataFrame([row(**{'除息交易日': '2026-09-07', '除權交易日': None, '現金股利發放日': '2026-10-08'})])
    if key == 'tw_etf_dividend_events':
        return pd.DataFrame({'symbol': ['0056'], 'date': ['2026-09-04'], '收益分配基準日': ['2026-09-08'],
                             '收益分配發放日': ['2026-09-20'], '收益分配金額(每1受益權單位)': [1.],
                             '收益分配標準': ['元以下全捨']})
    if key == 'etf_split:恢復買賣日期':
        return pd.DataFrame({'0050': ['2026-06-24']}, index=pd.DatetimeIndex(['2026-06-17'], name='date'))
    # FinLab wide catalogs: session index, one column per issuer, NaN where no event.
    return pd.DataFrame({'8109': ['1150505', None], '2330': [None, None]},
                        index=pd.DatetimeIndex(['2026-05-05', '2026-05-06'], name='date'))


def clock():
    ticks = count()
    return lambda: f'2026-10-03T00:00:{next(ticks):02d}+00:00'


@pytest.fixture
def out(tmp_path, monkeypatch):
    for name in fetcher.FINLAB_SESSION_ENV_NAMES:
        monkeypatch.setenv(name, SECRET)
    (tmp_path / 'days.json').write_text(json.dumps([*DAYS, '2026-10-05']))
    (tmp_path / 'universe.json').write_text(json.dumps(['0056', '2330', '1101', '020000']))
    return tmp_path


def run(out, **kwargs):
    calls = []
    args = dict(days_path=out / 'days.json', universe_path=out / 'universe.json',
                finlab_get=lambda key: calls.append(key) or vendor(key),
                login=lambda *a: print('logged in', *a), http_get=lambda url: b'["0050","0056"]', clock=clock())
    args.update(kwargs)
    return fetcher.fetch(out, **args), calls


def test_fetch_seals_every_source_and_the_spec_compiles(out, capsys):
    from compile_corporate_history import compile_history
    report, calls = run(out)
    assert calls == [key for _, key, _, _ in fetcher.FINLAB_SOURCES] and len(calls) == 7
    assert report['finlab_calls'] == 7 and report['twse_calls'] == 1 and report['auth_mode'] == 'session'
    spec = json.loads((out / 'spec.json').read_text(encoding='utf-8'))
    assert set(spec['sources']) == {d for d, _, _, _ in fetcher.FINLAB_SOURCES} | {'official.etf_registry'}
    assert all(len(e['sha256']) == 64 for e in spec['sources'].values())
    assert spec['captured_at'] >= max(e['fetched_at'] for e in spec['sources'].values())
    frame, days, scoped, unscoped = compile_history(spec, base=out)
    assert days == DAYS and scoped == ['1101', '2330', '0056'] and unscoped == ['020000']
    # The credential never reaches stdout, stderr or any written file.
    captured = capsys.readouterr()
    assert SECRET not in captured.out + captured.err
    assert all(SECRET.encode() not in p.read_bytes() for p in out.iterdir())


def test_wide_catalog_index_becomes_the_date_column():
    frame = fetcher.to_frame(vendor('capital_reduction_tse:恢復買賣日期'), 'wide')
    assert frame.columns == ['date', '8109', '2330'] and frame.height == 2
    assert frame['8109'].null_count() == 1


def test_compile_refuses_a_source_changed_after_the_fetch(out):
    from compile_corporate_history import compile_history
    run(out)
    spec = json.loads((out / 'spec.json').read_text(encoding='utf-8'))
    spec['sources']['official.etf_registry']['sha256'] = '0' * 64
    with pytest.raises(ValueError, match='source_changed_since_fetch:official.etf_registry'):
        compile_history(spec, base=out)


def test_missing_auth_stops_before_any_call(out, monkeypatch):
    for name in fetcher.FINLAB_SESSION_ENV_NAMES:
        monkeypatch.delenv(name)
    monkeypatch.setenv('FINLAB_REFRESH_TOKEN', SECRET)
    with pytest.raises(SystemExit) as stop:
        run(out, finlab_get=lambda key: pytest.fail('network'), login=lambda *a: pytest.fail('login'))
    assert 'FINLAB_SESSION_ID' in str(stop.value) and SECRET not in str(stop.value)
    assert not (out / 'spec.json').exists()


def test_a_failed_call_leaves_no_sealed_file(out):
    def flaky(key):
        if key == 'tw_etf_dividend_events':
            raise RuntimeError('vendor down')
        return vendor(key)
    with pytest.raises(RuntimeError):
        run(out, finlab_get=flaky)
    assert sorted(p.name for p in out.iterdir()) == ['days.json', 'universe.json']
    run(out)  # rerun into the same directory works


def test_sealed_sources_are_never_overwritten(out):
    run(out)
    with pytest.raises(SystemExit, match='refusing to overwrite'):
        run(out)


def test_dry_run_lists_calls_without_network(out, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, 'finlab', None)  # importing the SDK would fail
    monkeypatch.setitem(sys.modules, 'httpx', None)
    assert fetcher.main([str(out), '--dry-run']) == 0
    plan = json.loads(capsys.readouterr().out)
    assert len(plan['finlab_calls']) == 7 and len(plan['twse_calls']) == 1
    assert plan['days']['present'] and plan['universe']['present'] and plan['already_present'] == []
    assert SECRET not in json.dumps(plan)
    assert sorted(p.name for p in out.iterdir()) == ['days.json', 'universe.json']
