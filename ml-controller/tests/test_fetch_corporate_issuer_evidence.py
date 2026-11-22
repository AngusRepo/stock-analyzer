"""Issuer-document fetch for the research compile: paced, budgeted, sealed once."""
from datetime import datetime, timezone
import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'scripts'))

import fetch_corporate_issuer_evidence as fetcher

FIRST = '''<form name="fm_show"><input type="hidden" name="step" value="2">
  <input type="hidden" name="co_id_1" value="{s}"><input type="hidden" name="noticeKind" value="11">
  <input type="hidden" name="scope" value="1"><input type="hidden" name="SDATE" value="20251122">
  <input type="hidden" name="EDATE" value="20261122"></form>'''
SECOND = '''<form name="fm_t59sb09"><input type="hidden" name="step" value="2"><input type="hidden" name="ST" value="1">
  <table><tr class="even"><td>{s}</td><td>fixture</td><td>114/09/09</td><td>stock dividend</td>
  <td><input type="button" value="詳細資料" onclick='document.fm_t59sb09.co_id.value="{s}";document.fm_t59sb09.DATE1.value="20250909";document.fm_t59sb09.SKEY.value="1";'></td>
  </tr></table></form>'''


def mops_transport(calls):
    def handle(request):
        body = request.content.decode()
        symbol = next(p.split('=')[1] for p in body.split('&') if p.startswith(('co_id_1=', 'co_id=')))
        calls.append((request.url.path, body))
        if request.url.path.endswith('ajax_t59sb09'):
            return httpx.Response(200, text=f'<p>公司代號</p><p>{symbol}</p><p>公告內容</p><p>本公司訂於114年9月30日為除權基準日</p>')
        return httpx.Response(200, text=(FIRST if 'step=1' in body else SECOND).format(s=symbol))
    return httpx.MockTransport(handle)


def fake_clock():
    return datetime(2026, 11, 22, 3, tzinfo=timezone.utc)


def reader(**kwargs):
    from services.mops_corporate_terms import fetch_mops_delivery_announcements
    return fetch_mops_delivery_announcements(**kwargs, clock=fake_clock)


def test_seals_each_symbol_once_with_history_start_and_resumes(tmp_path):
    calls, waits = [], []
    report = fetcher.fetch(tmp_path, ['1225', '1449'], history_start='2024-06-01', pace_seconds=3.,
                           max_requests=20, reader=reader, transport=mops_transport(calls), sleep=waits.append)
    assert report['status_counts'] == {'sealed': 2} and report['requests'] == 6 == len(calls)
    assert 'SDATE=20240601' in calls[1][1]  # explicit research query extension
    assert len(waits) == 5 and all(w > 0 for w in waits)  # paced between every request
    item = report['symbols']['1225']
    raw = (tmp_path / item['path']).read_bytes()
    assert item['sha256'] == hashlib.sha256(raw).hexdigest()
    evidence = json.loads(raw)
    assert evidence['query_start'] == '2024-06-01' and len(evidence['documents']) == 1
    again = fetcher.fetch(tmp_path, ['1225', '1449'], history_start='2024-06-01', pace_seconds=3.,
                          max_requests=20, reader=reader, transport=mops_transport(calls), sleep=waits.append)
    assert again['status_counts'] == {'already_sealed': 2} and again['requests'] == 0
    assert (tmp_path / item['path']).read_bytes() == raw


def test_budget_stops_the_run_without_sealing_a_partial_symbol(tmp_path):
    calls = []
    report = fetcher.fetch(tmp_path, ['1225', '1449'], history_start='2024-06-01', pace_seconds=3.,
                           max_requests=4, reader=reader, transport=mops_transport(calls), sleep=lambda _: None)
    assert report['symbols']['1225']['status'] == 'sealed'
    assert report['symbols']['1449'] == {'status': 'budget_exhausted'}
    assert not fetcher.evidence_path(tmp_path, '1449').exists() and report['requests'] == 4


def test_one_symbol_failure_is_reported_and_the_next_symbol_still_fetches(tmp_path):
    def flaky(*, symbol, client, history_start):
        if symbol == '1225':
            raise ValueError('mops_delivery_form_changed')
        return reader(symbol=symbol, client=client, history_start=history_start)
    report = fetcher.fetch(tmp_path, ['1225', '1449'], history_start='2024-06-01', pace_seconds=3.,
                           max_requests=20, reader=flaky, transport=mops_transport([]), sleep=lambda _: None)
    assert report['symbols']['1225']['status'] == 'error' and 'form_changed' in report['symbols']['1225']['error']
    assert report['symbols']['1449']['status'] == 'sealed'
    assert not fetcher.evidence_path(tmp_path, '1225').exists()


def test_cli_refuses_unmeasured_pace_and_invalid_symbols(tmp_path):
    symbols = tmp_path / 'symbols.json'
    symbols.write_text(json.dumps(['1225']))
    with pytest.raises(SystemExit, match='pace below 3 s'):
        fetcher.main([str(tmp_path), '--symbols', str(symbols), '--pace-seconds', '1'])
    symbols.write_text(json.dumps(['0050']))
    with pytest.raises(SystemExit, match='company symbols'):
        fetcher.main([str(tmp_path), '--symbols', str(symbols), '--dry-run'])
