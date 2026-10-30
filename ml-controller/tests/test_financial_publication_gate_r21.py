import sys
from types import SimpleNamespace
import numpy as np
import pandas as pd
import pytest

from services.financial_publication_gate import require_consistent_financial_dates
from test_finlab_remote_backfill_tool_contract import _load_tool_module


def inputs(value=0.):
    frame = pd.DataFrame({'0050': [value]}, index=['2026-Q1'])
    disclosure = pd.DataFrame({'0050': pd.to_datetime(['2026-05-14'])}, index=frame.index)
    deadline = pd.DataFrame({'0050': pd.to_datetime(['2026-05-15'])}, index=frame.index)
    return frame, disclosure, deadline


def test_zero_and_missing_are_distinct():
    frame, disclosure, deadline = inputs()
    assert require_consistent_financial_dates(frame, (disclosure, deadline))['valued_cells'] == 1
    disclosure.iloc[0, 0] = pd.NaT
    with pytest.raises(ValueError, match='owner_missing'):
        require_consistent_financial_dates(frame, (disclosure, deadline))
    frame.iloc[0, 0] = np.nan
    assert require_consistent_financial_dates(frame, (disclosure, deadline))['valued_cells'] == 0


def test_all_null_value_column_needs_no_fabricated_owner():
    frame, disclosure, deadline = inputs(np.nan)
    disclosure = disclosure.rename(columns={'0050': '2330'})
    deadline = deadline.rename(columns={'0050': '2330'})
    assert require_consistent_financial_dates(frame, (disclosure, deadline))['valued_cells'] == 0


@pytest.mark.parametrize('fault', ['late', 'missing_symbol', 'missing_quarter', 'duplicate', 'numeric', 'timezone', 'native_date', 'infinite'])
def test_bad_owner_rejected(fault):
    frame, disclosure, deadline = inputs()
    if fault == 'late': disclosure.iloc[0, 0] = pd.Timestamp('2026-05-18')
    if fault == 'missing_symbol': disclosure = disclosure.rename(columns={'0050': '50'})
    if fault == 'missing_quarter': disclosure.index = ['2025-Q1']
    if fault == 'duplicate': disclosure = pd.concat([disclosure, disclosure])
    if fault == 'numeric': disclosure = pd.DataFrame({'0050': [20260514]}, index=frame.index)
    if fault == 'timezone': disclosure['0050'] = disclosure['0050'].dt.tz_localize('UTC')
    if fault == 'native_date': frame.index = pd.to_datetime(['2026-03-31'])
    if fault == 'infinite': frame.iloc[0, 0] = np.inf
    with pytest.raises(ValueError, match='financial_publication_'):
        require_consistent_financial_dates(frame, (disclosure, deadline))


def test_true_producer_missing_owner_before_alignment():
    tool = _load_tool_module()
    frame, disclosure, deadline = inputs()
    class Raw(pd.DataFrame):
        def deadline(self):
            pytest.fail('conflict must reject before alignment')
    disclosure.iloc[0, 0] = pd.NaT
    with pytest.raises(ValueError, match='owner_missing'):
        tool.normalize_finlab_wide_field(Raw(frame), api_key_name='fundamental_features:每股稅後淨利', date_owners=(disclosure, deadline), sessions=pd.to_datetime(['2026-05-15']))


@pytest.mark.parametrize('reuse', [False, True])
def test_materialize_rejects_before_output_or_d1(monkeypatch, tmp_path, reuse):
    tool = _load_tool_module()
    frame, disclosure, deadline = inputs()
    class Raw(pd.DataFrame):
        def deadline(self): pytest.fail('must reject first')
    disclosure.iloc[0, 0] = pd.NaT
    frames = {'price:收盤價': pd.DataFrame(index=pd.to_datetime(['2026-05-15'])), 'etl:financial_statements_disclosure_dates': disclosure,
        'etl:financial_statements_deadline': deadline, 'fundamental_features:每股稅後淨利': Raw(frame)}
    monkeypatch.setitem(sys.modules, 'finlab', SimpleNamespace(data=SimpleNamespace(get=lambda key: frames[key]), login=lambda: None))
    monkeypatch.setattr(tool, 'login_finlab_sdk', lambda fn: None)
    monkeypatch.setattr(tool, 'd1_counts', lambda *a: pytest.fail('no D1 read before financial preflight'))
    output = tmp_path / 'output'
    with pytest.raises(ValueError, match='financial_publication_'):
        tool.materialize_specs(years=3, run_dir=output, lanes=['fundamental_factor_diversity'],
            key_scope={'fundamental_factor_diversity': {'eps'}}, reuse_successful_artifacts=reuse)
    assert not output.exists()


def live_capture(monkeypatch, tmp_path, *, unresolved=False):
    """Live SDK training capture: delisted 2013 history, superseded old cell, new-listing deadline gap."""
    tool = _load_tool_module()
    q = ['2013-Q1', '2019-Q4', '2026-Q2']
    d = lambda *v: pd.to_datetime(list(v))
    frame = pd.DataFrame({'2330': [1., 2., 3.], '3068': [5., np.nan, np.nan], '7947': [np.nan, np.nan, 9.],
                          '5266': [np.nan, 4. if unresolved else np.nan, np.nan]}, index=q)
    disclosure = pd.DataFrame({'2330': d('2013-05-10', '2020-03-20', '2026-08-10'), '3068': d('2013-05-10', None, None),
                               '7947': d(None, None, '2026-10-08'), '5266': d(None, '2020-03-20', None)}, index=q)
    deadline = pd.DataFrame({'2330': d(None, '2020-03-31', '2026-08-14'), '3068': d(None, None, None),
                             '7947': d(None, None, None), '5266': d(None, None, None)}, index=q)
    sessions = d('2013-05-15', '2020-03-31', '2020-05-04', '2026-08-14', '2026-10-08', '2026-10-22')
    prices = pd.DataFrame({'2330': 1., '3068': [1.] + [np.nan] * 5, '7947': [np.nan] * 4 + [1., 1.],
                           '5266': 1., '0050': 1.}, index=sessions)
    frames = {'price:收盤價': prices, 'etl:financial_statements_disclosure_dates': disclosure,
              'etl:financial_statements_deadline': deadline, 'fundamental_features:每股稅後淨利': frame}
    monkeypatch.setitem(sys.modules, 'finlab', SimpleNamespace(data=SimpleNamespace(get=lambda key: frames[key]), login=lambda: None))
    monkeypatch.setattr(tool, 'login_finlab_sdk', lambda fn: None)
    monkeypatch.setattr(tool, 'd1_counts', lambda *a: {})
    out = tmp_path / 'out'
    run = lambda **extra: tool.materialize_specs(years=3, run_dir=out, lanes=['fundamental_factor_diversity'],
        key_scope={'fundamental_factor_diversity': {'eps'}}, source_start_date='2020-05-04',
        source_end_date='2026-10-22', **extra)
    return run, out


def test_live_training_capture_scopes_window_and_withholds_deadline_absent_cells(monkeypatch, tmp_path):
    import json
    run, out = live_capture(monkeypatch, tmp_path)
    run(training_capture_start_date='2020-05-04')
    saved = pd.read_parquet(out / 'raw/fundamental_factor_diversity/eps.parquet')
    assert list(saved.columns) == ['2330', '7947', '5266']  # 3068: no close in window
    assert saved['7947'].isna().all()  # no deadline owner: withheld, never admitted on a derived date
    assert saved['2330'].dropna().tolist()[-1] == 3. and saved.loc['2026-08-14', '2330'] == 3.
    proof, = list((out / 'raw/financial_availability').glob('*.json'))
    scope = json.loads(proof.read_text(encoding='utf8'))['request_scope']
    assert scope['deadline_owner_absent_cells_withheld'] == [{'symbol': '7947', 'quarter': '2026-Q2',
        'disclosure_date': '2026-10-08', 'original_value_retained_in_native': 9.0}]
    assert [c['quarter'] for c in scope['omitted_unresolved_cells']] == ['2013-Q1']
    assert scope['remaining_unresolved_cells'] == 0 and scope['values_or_dates_imputed'] is False
    assert scope['live_roster']['roster_source'] == 'live_price_universe_observed_close_in_window'


def test_live_capture_without_training_start_keeps_full_history_gate(monkeypatch, tmp_path):
    run, out = live_capture(monkeypatch, tmp_path)
    with pytest.raises(ValueError, match='financial_publication_owner_missing'):
        run()


def test_live_training_capture_still_rejects_unresolved_in_window_history(monkeypatch, tmp_path):
    run, out = live_capture(monkeypatch, tmp_path, unresolved=True)
    with pytest.raises(ValueError, match=r'financial_request_unresolved_cells:fundamental_features:每股稅後淨利:1:.*5266'):
        run(training_capture_start_date='2020-05-04')
    assert not (out / 'raw/fundamental_factor_diversity/eps.parquet').exists()
