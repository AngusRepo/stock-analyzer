import re
import sys
from pathlib import Path

import pytest
import requests
from google.api_core import exceptions as api_exceptions
from google.auth.exceptions import TransportError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from tools import finlab_capture_guard as guard

def gcs_write_timeout():
    """The 11/16 upload failure, fresh each time so no traceback carries over."""
    return requests.exceptions.ConnectionError(('Connection aborted.', TimeoutError('The write operation timed out')))


def _worker_classifier():
    """The Worker's transient and quota patterns (finlabSourceContract.ts), read from the source."""
    source = (ROOT / 'worker/src/lib/finlabSourceContract.ts').read_text(encoding='utf-8')
    match = re.search(r"const FINLAB_TRANSIENT_EXCEPTION = new RegExp\((.*?)\)\n", source, re.S)
    if match is None:
        pytest.skip('classifyFinLabTransientFailure is not on this branch yet (PR #207)')
    transient = ''.join(re.findall(r"'((?:[^'\\]|\\.)*)'", match.group(1))).replace('\\\\', '\\')
    quota = re.search(r"const FINLAB_QUOTA = /(.*)/i\n", source).group(1).replace('\\/', '/')
    return lambda summary, error: (bool(re.search(transient, f'{summary} {error}'))
                                   and not re.search(quota, f'{summary} {error}', re.I))


def _raised(exc, via):
    try:
        via(exc)
    except Exception as caught:
        return caught
    raise AssertionError('not raised')


def _raise(exc):
    raise exc


def _outer(exc):
    _raise(exc)


def _check_quota_then_raise(exc):
    # A frame whose name holds a quota marker must not turn a transport failure into a quota stop.
    _raise(exc)


@pytest.mark.parametrize('exc', [
    gcs_write_timeout(), requests.exceptions.ReadTimeout('Read timed out.'), requests.exceptions.ChunkedEncodingError(),
    TimeoutError('timed out'), ConnectionResetError(104, 'reset'), TransportError('dns'),
    api_exceptions.ServiceUnavailable('503'), api_exceptions.TooManyRequests('429'),
])
def test_transport_errors_are_transient(exc):
    assert guard.is_transient_transport_error(exc)


@pytest.mark.parametrize('exc', [
    ValueError('daily_composition_output_already_exists'), FileNotFoundError('broker.json'), KeyError('x'),
    api_exceptions.PreconditionFailed('412'), api_exceptions.Forbidden('403'),
    guard.FinLabCaptureDeadlineExceeded('finlab_capture_deadline_exceeded:lane:x:budget=60s'),
])
def test_data_and_policy_errors_are_not_transient(exc):
    assert not guard.is_transient_transport_error(exc)


def test_callback_error_keeps_the_classifier_head_and_adds_bounded_frames():
    head, detail = guard.callback_error(_raised(gcs_write_timeout(), _raise))
    assert head == "ConnectionError: ('Connection aborted.', TimeoutError('The write operation timed out'))"
    assert detail.startswith(head + ' | trace: ')
    assert 'test_finlab_capture_guard.py:' in detail and 'in _raise' in detail

    multi = guard.callback_error(ValueError('line one\n  line two ' + 'x' * 5000))
    assert multi[0].startswith('ValueError: line one line two x') and len(multi[0]) == len('ValueError: ') + 1000
    assert multi[1] == multi[0]  # never raised: no frames to add

    deep = guard.callback_error(_raised(gcs_write_timeout(), _outer), frames=2)[1]
    assert re.fullmatch(r'.* \| trace: test_finlab_capture_guard\.py:\d+ in _raise <- test_finlab_capture_guard\.py:\d+ in _outer',
                        deep)


def test_worker_classifier_reads_the_modal_report():
    classify = _worker_classifier()
    assert classify(*guard.callback_error(_raised(gcs_write_timeout(), _raise)))
    assert classify(*guard.callback_error(_raised(requests.exceptions.ReadTimeout('Read timed out.'), _raise)))
    # The quota-named frame is dropped, so the transport failure stays resendable.
    head, detail = guard.callback_error(_raised(gcs_write_timeout(), _check_quota_then_raise))
    assert '_check_quota_then_raise' not in detail and classify(head, detail)
    quota = RuntimeError('Usage exceed 5000 MB/day')
    assert not classify(*guard.callback_error(_raised(quota, _raise)))
    try:
        guard.install_deadline(0)
        deadline = _raised('lane:broker_flow_diversity', guard.check_deadline)
    finally:
        guard.clear_deadline()
    head, detail = guard.callback_error(deadline)
    assert head == 'FinLabCaptureDeadlineExceeded: finlab_capture_deadline_exceeded:lane:broker_flow_diversity:budget=0s'
    assert not classify(head, detail)


def test_callback_text_redacts_url_credentials():
    exc = requests.exceptions.ConnectionError(
        "HTTPSConnectionPool(host='x', port=443): Max retries exceeded with url: "
        "/data?api_token=SECRET1&name=broker&X-Goog-Signature=SECRET2 (Caused by timeout)")
    head, detail = guard.callback_error(exc)
    assert 'SECRET' not in head + detail and 'api_token=[REDACTED]&name=broker' in head
    assert head.startswith('ConnectionError: ')


def test_deadline_is_off_until_installed_and_cleared_after():
    guard.check_deadline('anything')
    assert guard.remaining_seconds() is None
    guard.install_deadline(3600)
    try:
        assert 3590 < guard.remaining_seconds() <= 3600
        guard.check_deadline('validate')
    finally:
        guard.clear_deadline()
    assert guard.remaining_seconds() is None


def _materialize_broker(monkeypatch, tmp_path, broker):
    from types import SimpleNamespace
    from test_finlab_remote_backfill_tool_contract import _load_tool_module
    tool = _load_tool_module()
    calls = []

    class Source:
        def get(self, key):
            calls.append(key)
            return broker() if callable(broker) else broker.copy()
    monkeypatch.setitem(sys.modules, 'finlab', SimpleNamespace(data=Source(), login=lambda *a, **kw: None))
    monkeypatch.setattr(tool, 'login_finlab_sdk', lambda login: None)
    monkeypatch.setattr(tool, 'd1_counts', lambda start: {})
    scope = {'broker_flow_diversity': set()}

    def run():
        return tool.materialize_specs(
            years=3, run_dir=tmp_path / 'finlab-v4-daily-20261116-1', lanes=list(scope), key_scope=scope,
            source_start_date='2026-10-12', source_end_date='2026-10-12', daily_refresh=True,
            generated_at='2026-10-12T13:00:00+00:00')
    return run, calls


def test_broker_fetch_failure_stops_the_capture_with_its_own_error(monkeypatch, tmp_path):
    """11/16: the failure was swallowed and surfaced later as FileNotFoundError on broker.json."""
    run, calls = _materialize_broker(monkeypatch, tmp_path, lambda: _raise(requests.exceptions.ReadTimeout(
        "HTTPSConnectionPool(host='storage.googleapis.com', port=443): Read timed out. (read timeout=300)")))
    with pytest.raises(requests.exceptions.ReadTimeout) as caught:
        run()
    assert calls == ['broker_transactions']
    assert not (tmp_path / 'finlab-v4-daily-20261116-1/raw/broker_flow_diversity/broker_daily.parquet').exists()
    assert guard.callback_error(caught.value)[0].startswith('ReadTimeout: HTTPSConnectionPool')


def test_empty_broker_frame_on_a_daily_refresh_fails_before_the_composition(monkeypatch, tmp_path):
    import pandas as pd
    run, _ = _materialize_broker(monkeypatch, tmp_path, pd.DataFrame())
    with pytest.raises(ValueError, match='finlab_broker_source_empty:broker_transactions'):
        run()


def test_broker_success_still_writes_the_capture(monkeypatch, tmp_path):
    import pandas as pd
    broker = pd.DataFrame({'date': pd.to_datetime(['2026-10-08', '2026-10-12']), 'symbol': ['3000', '3000'],
                           'broker': ['A', 'A'], 'buy': [100., 120.], 'sell': [20., 30.]})
    run, _ = _materialize_broker(monkeypatch, tmp_path, broker)
    _, _, reports, blockers = run()
    assert [(r['field'], r['status']) for r in reports] == [('broker_transactions', 'ok')] and blockers == []
    assert (tmp_path / 'finlab-v4-daily-20261116-1/raw/training_long_full_vintage/broker.json').exists()


def test_capture_deadline_stops_before_the_next_lane_fetch(monkeypatch, tmp_path):
    run, calls = _materialize_broker(monkeypatch, tmp_path, lambda: pytest.fail('fetched past the deadline'))
    guard.install_deadline(0)
    try:
        with pytest.raises(guard.FinLabCaptureDeadlineExceeded, match='lane:broker_flow_diversity'):
            run()
    finally:
        guard.clear_deadline()
    assert calls == []
