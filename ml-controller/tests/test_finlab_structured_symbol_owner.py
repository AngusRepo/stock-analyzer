from pathlib import Path
import json
import pandas as pd
import pytest
from test_finlab_remote_backfill_tool_contract import _load_tool_module


@pytest.mark.parametrize('value,row,expected', [
    (None, {'date': '2026-10-08', 'title': '市場資料'}, ''),
    (None, {'url': 'https://example.test/2330/news'}, ''),
    (None, {'name': '2330 台積電'}, ''),
    (None, {'證券代號': '2330 台積電', 'date': '2026-10-08'}, '2330'),
    ('009801', {}, '009801'),
    ('00679B', {}, '00679B'),
    ('2887Z1', {}, '2887Z1'),
    ('72381U', {}, '72381U'),
    ('07637U', {}, '07637U'),
    ('1234567', {}, ''),
    ('2330 台積電', {}, '2330'),
    ('2026-10-08', {}, ''),
    ('2330/2317', {}, ''),
    (2330.0, {}, ''),
    (pd.NA, {}, ''),
    ('2330', {'symbol': '2317'}, ''),
])
def test_only_explicit_unambiguous_identity(value, row, expected):
    assert _load_tool_module()._clean_symbol(value, row) == expected


@pytest.mark.parametrize('row', [
    {'date': '2026-10-08', 'title': '2026年度處置公告'},
    {'date': '2026-10-08', 'symbol': '2330', 'code': '2317'},
])
def test_bad_restriction_owner_blocks_all_writes(monkeypatch, tmp_path, row):
    tool = _load_tool_module()
    path = tmp_path / 'table.parquet'
    pd.DataFrame([row]).to_parquet(path)
    manifest = {'run_id': 'owner-test', 'generated_at': '2026-10-08T00:00:00Z',
                'datasets': [{'lane': 'trading_restrictions', 'artifacts': [{'path': str(path)}]}]}
    calls = []
    monkeypatch.setattr(tool, 'market_d1_batch_execute', lambda *a, **k: calls.append('rows'))
    monkeypatch.setattr(tool, 'market_d1_exec', lambda *a, **k: calls.append('quality'))
    with pytest.raises(ValueError, match='finlab_restriction_symbol_missing_or_ambiguous'):
        tool.insert_finlab_trading_restrictions(manifest)
    assert calls == []


def test_valid_restriction_preserves_exact_leading_zero(monkeypatch, tmp_path):
    tool = _load_tool_module()
    path = tmp_path / 'table.parquet'
    pd.DataFrame([{'date': '2026-10-08', 'symbol': '009801', 'title': '處置公告'}]).to_parquet(path)
    manifest = {'run_id': 'owner-test', 'generated_at': '2026-10-08T00:00:00Z',
                'datasets': [{'lane': 'trading_restrictions', 'artifacts': [{'path': str(path)}]}]}
    calls = []
    monkeypatch.setattr(tool, 'market_d1_batch_execute', lambda batch, **k: calls.extend(batch))
    monkeypatch.setattr(tool, 'market_d1_exec', lambda *a, **k: None)
    assert tool.insert_finlab_trading_restrictions(manifest) == 1
    assert calls[0][1][0] == '009801'


def test_news_without_explicit_symbol_keeps_unknown_owner(monkeypatch, tmp_path):
    tool = _load_tool_module()
    path = tmp_path / 'news.parquet'
    pd.DataFrame([{'date': '2026-10-08', 'title': '2026市場消息',
                   'url': 'https://example.test/2330/news'}]).to_parquet(path)
    monkeypatch.setattr(tool, '_artifact_path', lambda *a: path)
    calls = []
    monkeypatch.setattr(tool, 'market_d1_batch_execute', lambda batch, **k: calls.extend(batch))
    assert tool.insert_finlab_cnyes_evidence({'run_id': 'owner-test', 'generated_at': '2026-10-08'}) == 1
    assert json.loads(calls[0][1][3]) == []
    assert calls[0][1][4] == .35
