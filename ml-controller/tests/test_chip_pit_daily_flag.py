import sys
from types import SimpleNamespace
import pandas as pd
import pytest
from test_finlab_remote_backfill_tool_contract import _load_tool_module


def _run(tool, monkeypatch, tmp_path):
    wide = pd.DataFrame({str(s): [10., 11.] for s in range(3000, 3100)},
                        index=pd.to_datetime(['2026-10-08', '2026-10-12']))
    broker = pd.DataFrame({'date': pd.to_datetime(['2026-10-08', '2026-10-12']), 'symbol': ['3000', '3000'],
                           'broker': ['A', 'A'], 'buy': [100., 120.], 'sell': [20., 30.]})
    class Source:
        binding = {'test_only': 'synthetic'}
        def get(self, key):
            return broker.copy() if key == 'broker_transactions' else wide.copy()
    monkeypatch.setitem(sys.modules, 'finlab', SimpleNamespace(data=Source(), login=lambda *a, **kw: None))
    monkeypatch.setattr(tool, 'login_finlab_sdk', lambda login: None)
    monkeypatch.setattr(tool, 'd1_counts', lambda start: {})
    monkeypatch.setattr(tool.time, 'sleep', lambda s: None)
    scope = {'fundamental_factor_diversity': {'pe', 'pb'}, 'broker_flow_diversity': set()}
    tool.materialize_specs(years=3, run_dir=tmp_path / 'daily', lanes=list(scope), key_scope=scope,
                           source_start_date='2026-10-12', source_end_date='2026-10-12', daily_refresh=True)


@pytest.mark.parametrize("env", [None, "0", "true", ""])
def test_off_never_touches_chip_pit(monkeypatch, tmp_path, env):
    tool = _load_tool_module()
    if env is None:
        monkeypatch.delenv("CHIP_PIT_DAILY_RECORD", raising=False)
    else:
        monkeypatch.setenv("CHIP_PIT_DAILY_RECORD", env)
    monkeypatch.delitem(sys.modules, 'services.chip_pit', raising=False)
    calls = []
    monkeypatch.setattr(tool, 'chip_pit_lane_fields', lambda lane: calls.append(lane) or ())
    _run(tool, monkeypatch, tmp_path)
    assert calls == []
    assert 'services.chip_pit' not in sys.modules
    assert not (tmp_path / 'daily/raw/chip_pit_window').exists()


def test_on_consults_chip_pit(monkeypatch, tmp_path):
    tool = _load_tool_module()
    monkeypatch.setenv("CHIP_PIT_DAILY_RECORD", "1")
    calls = []
    monkeypatch.setattr(tool, 'chip_pit_lane_fields', lambda lane: calls.append(lane) or ())
    _run(tool, monkeypatch, tmp_path)
    assert calls


def test_main_records_the_daily_receipt_only_when_enabled():
    import inspect
    tool = _load_tool_module()
    assert "args.daily_refresh and args.gcs_bucket and chip_pit_daily_enabled():" in inspect.getsource(tool.main)
