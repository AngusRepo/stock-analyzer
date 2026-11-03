import json

import polars as pl
import pytest

from test_finlab_remote_backfill_tool_contract import _load_tool_module


def breadth(day):
    return {'stat': 'OK', 'date': day.replace('-', ''), 'tables': [
        {'fields': ['類型', '整體市場', '股票'],
         'data': [['上漲', '120', '100'], ['下跌', '100', '80']]}]}


def capture(root, days):
    path = root / 'raw/daily_price_full_vintage'
    path.mkdir(parents=True)
    (path / 'manifest.json').write_text(json.dumps({'capture_id': root.name, 'end_date': days[-1]}))
    pl.DataFrame({'date': days, **{str(n): [10.] * len(days) for n in range(100)}}).write_parquet(path / 'close.parquet')
    return path


def test_daily_capture_reuses_history_and_only_fetches_new_session(monkeypatch, tmp_path, capsys):
    from services import official_history_cache as cache
    tool = _load_tool_module()
    days = ['2026-10-08', '2026-10-12']
    store = {'breadth/TWSE-' + days[0] + '.json': json.dumps(breadth(days[0])).encode()}
    monkeypatch.setattr(cache, 'read_cached', store.get)
    monkeypatch.setattr(cache, 'write_cached', lambda key, raw: store.__setitem__(key, raw))
    fetches, sleeps = [], []
    def fetch(url, *, label):
        fetches.append(url)
        return breadth(days[1])
    monkeypatch.setattr(tool, 'official_json_get', fetch)
    monkeypatch.setattr(tool.time, 'sleep', sleeps.append)
    first = capture(tmp_path / 'first', days)
    tool.write_training_breadth_capture(run_dir=tmp_path / 'first', allow_historical_fetch=False)
    assert len(fetches) == 1 and 'date=20261012' in fetches[0]
    assert sleeps == [4]
    second = capture(tmp_path / 'second', days)
    tool.write_training_breadth_capture(run_dir=tmp_path / 'second', allow_historical_fetch=False)
    assert len(fetches) == 1 and sleeps == [4]
    for day in days:
        assert (first / 'official_breadth' / (day + '.json')).read_bytes() == (second / 'official_breadth' / (day + '.json')).read_bytes()
    receipt = json.loads((second / 'training_breadth.json').read_text())
    assert [row['date'] for row in receipt['sources']] == days
    assert 'progress=2/2 date=2026-10-12' in capsys.readouterr().err


def test_cached_wrong_date_still_rejected(monkeypatch, tmp_path):
    from services import official_history_cache as cache
    tool = _load_tool_module()
    capture(tmp_path / 'invalid', ['2026-10-12'])
    monkeypatch.setattr(cache, 'read_cached', lambda key: json.dumps(breadth('2026-10-08')).encode())
    monkeypatch.setattr(tool, 'official_json_get', lambda *a, **k: pytest.fail('must not silently refetch invalid evidence'))
    with pytest.raises(ValueError, match='training_breadth_date_or_status_invalid'):
        tool.write_training_breadth_capture(run_dir=tmp_path / 'invalid')
    assert not (tmp_path / 'invalid/raw/daily_price_full_vintage/training_breadth.json').exists()


def test_daily_missing_history_never_starts_a_multi_year_download(monkeypatch, tmp_path):
    from services import official_history_cache as cache
    tool = _load_tool_module()
    capture(tmp_path / 'daily', ['2026-10-08', '2026-10-12'])
    monkeypatch.setattr(cache, 'read_cached', lambda key: None)
    monkeypatch.setattr(tool, 'official_json_get', lambda *a, **k: pytest.fail('daily history bootstrap forbidden'))
    with pytest.raises(ValueError, match='daily_official_history_cache_missing:breadth/TWSE-2026-10-08.json'):
        tool.write_training_breadth_capture(run_dir=tmp_path / 'daily', allow_historical_fetch=False)


@pytest.mark.parametrize('missing_old', [False, True])
def test_calendar_rollover_only_fetches_recent_months(monkeypatch, tmp_path, missing_old):
    from services import official_history_cache as cache
    tool = _load_tool_module()
    days = ['2026-09-30', '2026-10-30', '2026-11-02']
    root = tmp_path / 'rollover'
    path = capture(root, days)
    import hashlib
    manifest = json.loads((path / 'manifest.json').read_text())
    manifest['checksums'] = {'close': hashlib.sha256((path / 'close.parquet').read_bytes()).hexdigest()}
    (path / 'manifest.json').write_text(json.dumps(manifest))
    def body(market, month):
        day = next(d for d in days if d.startswith(month))
        rows = [[day.replace('-', '/'), '1', '1', '1', '100']]
        return {'date': month.replace('-', '') + '01', 'stat': 'OK', 'data': rows,
                'tables': [{'fields': ['日期'], 'data': rows, 'totalCount': 1}]}
    store = {} if missing_old else {
        'calendar/' + market + '-2026-09.json': json.dumps(body(market, '2026-09')).encode()
        for market in ('TWSE', 'TPEX')}
    monkeypatch.setattr(cache, 'read_cached', store.get)
    monkeypatch.setattr(cache, 'write_cached', lambda key, raw: store.__setitem__(key, raw))
    fetches = []
    def fetch(url, *, label):
        market, month = label.removeprefix('training_calendar_').split('_')
        fetches.append((market, month))
        return body(market, month)
    monkeypatch.setattr(tool, 'official_json_get', fetch)
    monkeypatch.setattr(tool.time, 'sleep', lambda seconds: None)
    if missing_old:
        with pytest.raises(ValueError, match='daily_official_history_cache_missing:calendar/TWSE-2026-09.json'):
            tool.write_official_training_calendar(run_dir=root, allow_historical_fetch=False)
        assert fetches == []
    else:
        tool.write_official_training_calendar(run_dir=root, allow_historical_fetch=False)
        assert set(fetches) == {(market, month) for market in ('TWSE', 'TPEX') for month in ('2026-10', '2026-11')}
        assert 'calendar/TWSE-2026-10.json' in store
        assert 'calendar/TWSE-2026-11-2026-11-02.json' in store


def test_history_fetch_retries_a_throttled_reply_then_fails_closed(monkeypatch, tmp_path):
    """One non-JSON TWSE reply aborted a local 1577-day capture at day ~195."""
    tool = _load_tool_module()
    days = ['2021-02-19', '2021-02-22']
    replies, sleeps = [None, None, breadth(days[0]), breadth(days[1])], []
    monkeypatch.setattr(tool, 'official_json_get', lambda url, *, label: replies.pop(0))
    monkeypatch.setattr(tool.time, 'sleep', sleeps.append)
    capture(tmp_path / 'retry', days)
    tool.write_training_breadth_capture(run_dir=tmp_path / 'retry')
    assert sleeps == [30, 90, 4, 4] and not replies
    monkeypatch.setattr(tool, 'official_json_get', lambda url, *, label: None)
    sleeps.clear()
    capture(tmp_path / 'down', days)
    with pytest.raises(ValueError, match='official_history_fetch_failed:training_breadth_2021-02-19:attempts=3'):
        tool.write_training_breadth_capture(run_dir=tmp_path / 'down')
    assert sleeps == [30, 90]
