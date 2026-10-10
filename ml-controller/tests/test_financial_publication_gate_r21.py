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
