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
