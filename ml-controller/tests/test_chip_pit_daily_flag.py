import sys
from types import SimpleNamespace
import pandas as pd
import pytest
from test_finlab_remote_backfill_tool_contract import _load_tool_module


def _run(tool, monkeypatch, tmp_path, **kwargs):
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
    return tool.materialize_specs(years=3, run_dir=tmp_path / 'daily', lanes=list(scope), key_scope=scope,
                                  source_start_date='2026-10-12', source_end_date='2026-10-12', daily_refresh=True,
                                  generated_at='2026-10-12T13:00:00+00:00', **kwargs)


def _outcome(result, root):
    _, _, reports, blockers = result
    files = sorted(str(p.relative_to(root)) for p in root.rglob('*') if p.is_file())
    return [(r['lane'], r['field'], r['status'], r['rows']) for r in reports], blockers, files


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


def test_on_writes_the_window_without_errors(monkeypatch, tmp_path):
    tool = _load_tool_module()
    monkeypatch.setenv("CHIP_PIT_DAILY_RECORD", "1")
    monkeypatch.setattr(tool, 'chip_pit_lane_fields',
                        lambda lane: ('pe', 'pb') if lane == 'fundamental_factor_diversity' else ())
    errors = []
    _run(tool, monkeypatch, tmp_path, chip_pit_window_errors=errors)
    assert errors == []
    window = pd.read_parquet(tmp_path / 'daily/raw/chip_pit_window/pe.parquet')
    assert [str(d.date()) for d in window.index] == ['2026-10-08', '2026-10-12']


def test_lane_field_failure_leaves_the_capture_as_off(monkeypatch, tmp_path):
    tool = _load_tool_module()
    monkeypatch.delenv("CHIP_PIT_DAILY_RECORD", raising=False)
    off = _outcome(_run(tool, monkeypatch, tmp_path / 'off'), tmp_path / 'off')
    monkeypatch.setenv("CHIP_PIT_DAILY_RECORD", "1")
    def broken(lane):
        raise ImportError('polars')
    monkeypatch.setattr(tool, 'chip_pit_lane_fields', broken)
    errors = []
    on = _outcome(_run(tool, monkeypatch, tmp_path / 'on', chip_pit_window_errors=errors), tmp_path / 'on')
    assert on == off
    assert errors == [{'lane': 'fundamental_factor_diversity', 'step': 'lane_fields', 'error': 'ImportError: polars'}]


def test_window_write_failure_keeps_the_lane_and_drops_partial_files(monkeypatch, tmp_path):
    tool = _load_tool_module()
    monkeypatch.delenv("CHIP_PIT_DAILY_RECORD", raising=False)
    off = _outcome(_run(tool, monkeypatch, tmp_path / 'off'), tmp_path / 'off')
    monkeypatch.setenv("CHIP_PIT_DAILY_RECORD", "1")
    monkeypatch.setattr(tool, 'chip_pit_lane_fields',
                        lambda lane: ('pe', 'pb') if lane == 'fundamental_factor_diversity' else ())
    def partial(frames, *, lane, run_dir, end_date):
        tool.write_parquet(run_dir / 'raw' / 'chip_pit_window' / 'pe.parquet', frames['pe'])
        raise OSError('disk full')
    monkeypatch.setattr(tool, 'write_chip_pit_window', partial)
    errors = []
    on = _outcome(_run(tool, monkeypatch, tmp_path / 'on', chip_pit_window_errors=errors), tmp_path / 'on')
    assert on == off
    assert errors == [{'lane': 'fundamental_factor_diversity', 'step': 'write_window', 'error': 'OSError: disk full'}]


def test_main_records_the_daily_receipt_only_when_enabled():
    import inspect
    tool = _load_tool_module()
    source = inspect.getsource(tool.main)
    assert "args.daily_refresh and args.gcs_bucket and chip_pit_daily_enabled():" in source
    assert 'manifest["chip_pit_daily"]["window_errors"] = chip_pit_window_errors' in source


def test_modal_deploy_turns_the_daily_record_on():
    from pathlib import Path
    modal_app = (Path(__file__).resolve().parents[2] / 'ml-service' / 'modal_app.py').read_text(encoding='utf-8')
    runtime_secret = modal_app.split('runtime_env_secret =', 1)[1].split('TRAINING_INPUT_CACHE_MOUNT', 1)[0]
    assert '"CHIP_PIT_DAILY_RECORD": os.environ.get("CHIP_PIT_DAILY_RECORD", "1").strip(),' in runtime_secret
