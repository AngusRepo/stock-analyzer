"""S1: the research snapshot seals what Paper's morning chain reads (momentum zone, P7 rows, formal verdict)."""
import json
from types import SimpleNamespace

import polars as pl
import pytest

from services import backtest_paper_risk as risk


def forecast(*, passed=None, art='art'):
    payload = {'ensemble_v2': {'artifact_id': art, 'cohort_id': 'c', 'artifact_checksum': 's',
                               'base_artifact_set_checksum': 'b', 'forecast_horizon_bars': 5}}
    if passed is not None:
        payload['core_family_vote'] = {'formal_model_contract_passed': passed}
    return json.dumps(payload)


def test_the_formal_contract_flag_comes_from_forecast_data_and_stays_null_when_never_recorded():
    from services.dataset_snapshot_exporter import with_formal_contract_flag
    signals = pl.DataFrame({'stock_id': [1, 2, 3, 4],
                            'forecast_data': [forecast(passed=True), forecast(passed=False), forecast(), 'not json']})
    assert with_formal_contract_flag(signals)['formal_model_contract_passed'].to_list() == [True, False, None, None]
    flagged = with_formal_contract_flag(signals.drop('forecast_data'))
    assert flagged['formal_model_contract_passed'].to_list() == [None] * 4


def test_verified_rows_carry_the_p7_columns_for_hot_and_cold_rows(monkeypatch):
    from services import backtest_state
    import services.retention_history as retention
    seen = {}
    hot = [{'id': 1, 'stock_id': 7, 'model_name': 'ensemble', 'prediction_date': '2026-10-01',
            'generated_at': '2026-10-01T13:00:00Z', 'direction_correct': 1, 'verified_at': '2026-10-09T13:00:00Z',
            'verification_label_known_date': '2026-10-08', 'verification_label_end_date': '2026-10-08',
            'verification_label_schema_version': risk.P7_LABEL_SCHEMA, 'forecast_horizon_bars': 5,
            'ensemble_artifact_id': 'art', 'ensemble_cohort_id': 'c', 'ensemble_artifact_checksum': 's',
            'ensemble_base_artifact_set_checksum': 'b'}]
    cold = [{'id': 2, 'stock_id': 8, 'model_name': 'ensemble', 'prediction_date': '2026-09-01',
             'generated_at': '2026-09-01T13:00:00Z', 'direction_correct': 0, 'verified_at': '2026-09-09T13:00:00Z',
             'verification_label_known_date': '2026-09-08', 'verification_label_end_date': '2026-09-08',
             'verification_label_schema_version': risk.P7_LABEL_SCHEMA, 'forecast_data': forecast()},
            {'id': 3, 'stock_id': 8, 'model_name': 'lightgbm', 'generated_at': '2026-09-02T13:00:00Z',
             'direction_correct': 1, 'forecast_data': forecast()}]
    monkeypatch.setattr(backtest_state.LEARNING_D1_CLIENT, 'query',
                        lambda sql, params: seen.update(sql=sql, params=params) or hot)
    monkeypatch.setattr(retention, 'archived_predictions', lambda *a, **k: cold)
    rows = backtest_state.load_verified_predictions('2026-08-01', '2026-10-30')
    assert "json_extract(forecast_data, '$.ensemble_v2.artifact_id') END AS ensemble_artifact_id" in seen['sql']
    assert "model_name = 'ensemble' AND json_valid(forecast_data)" in seen['sql']
    assert [r['stock_id'] for r in rows] == [8, 8, 7]
    assert all(risk.P7_REQUIRED_COLUMNS <= set(r) for r in rows)
    assert rows[0]['ensemble_artifact_id'] == 'art' and rows[0]['forecast_horizon_bars'] == 5
    assert rows[1]['ensemble_artifact_id'] is None            # not an ensemble row
    assert 'forecast_data' not in rows[0]


def test_the_snapshot_seals_the_momentum_zone_and_verified_rows_from_before_the_window(monkeypatch):
    from services import backtest_state, dataset_snapshot_exporter as e
    import services.backtest_corporate_export as corporate
    import services.retention_history as retention
    stocks = pl.DataFrame({'id': [1], 'symbol': ['2330'], 'market': ['TWSE']})
    frame = pl.DataFrame({'date': ['2026-08-18'], 'stock_id': [1]})
    signals = pl.DataFrame({'id': [1], 'stock_id': [1], 'generated_at': ['2026-08-18T13:00:00Z'],
                            'prediction_date': ['2026-08-18'], 'trade_signal': ['buy'], 'direction_accuracy': [.6],
                            'entry_price': [1.], 'stop_loss': [1.], 'target1': [1.], 'target2': [1.],
                            'forecast_data': [forecast(passed=True)]})
    monkeypatch.setattr(e, '_query_active_stocks', lambda *a: stocks)
    monkeypatch.setattr(e, '_query_prices', lambda *a: (frame, 1))
    monkeypatch.setattr(e, '_query_date_range', lambda sql, *a, **k: (signals if 'FROM predictions' in sql else frame, 1))
    for name in ('_query_sentiment_scores', '_query_margin_data', '_query_shareholding'):
        monkeypatch.setattr(e, name, lambda *a: (frame, 1))
    for name in ('_query_market_risk', '_query_monthly_revenue', '_query_canonical_fundamentals'):
        monkeypatch.setattr(e, name, lambda *a: frame)
    zone = [{'date': '2026-07-30', 'zone': 'RED', 'percentile_rank': .1, 'pool_definition': risk.MOMENTUM_POOL_DEFINITION,
             'created_at': '2026-07-30T09:00:00Z'}]
    asked = []
    def market(sql, params):
        asked.append((sql, params))
        return zone if 'screener_momentum_snapshots' in sql else []
    monkeypatch.setattr(e, 'MARKET_D1_CLIENT', SimpleNamespace(query=market))
    monkeypatch.setattr(e, 'client_for_domain', lambda domain: SimpleNamespace(query=lambda sql, params: []))
    monkeypatch.setattr(corporate, 'export_original_corporate_records', lambda days: pl.DataFrame())
    monkeypatch.setattr(retention, 'archived_predictions', lambda *a, **k: [])
    verified_range = []
    monkeypatch.setattr(backtest_state, 'load_verified_predictions', lambda *a: verified_range.append(a) or [])
    monkeypatch.setattr(backtest_state, 'load_regime_observations', lambda end, client=None: [])
    monkeypatch.setattr(e, '_write_compute_snapshot', lambda **kw: kw)
    req = e.DatasetSnapshotExportRequest(business_date='2026-08-19', start_date='2026-08-14', end_date='2026-08-19',
                                         include_signals=True)
    result = e.export_backtest_dataset_snapshot(req)
    sql, params = next((q, p) for q, p in asked if 'screener_momentum_snapshots' in q)
    assert 'date <= ?' in sql and params == ['2026-08-19'] and 'created_at' in sql and 'pool_definition' in sql
    assert result['components']['screener_momentum_snapshots'].to_dicts() == zone
    assert result['d1_query_counts']['screener_momentum_snapshots'] == 1
    assert verified_range == [('2026-06-15', '2026-08-19')]           # 60 days before the window
    assert result['components']['signals']['formal_model_contract_passed'].to_list() == [True]


def dataset(signal_rows, *, momentum=None, verified=None):
    frames = {'signals': pl.DataFrame(signal_rows),
              'market_breadth': pl.DataFrame({'date': ['2026-09-01'], 'advance_ratio': [.5]}),
              'us_market_signals': pl.DataFrame({'date': ['2026-09-01'], 'gspc_return': [.0]}),
              'market_regime_state': pl.DataFrame(schema={c: pl.Utf8 for c in (
                  'run_date', 'state_json', 'state_checksum', 'computed_at', 'recorded_at')}),
              'verified_predictions': pl.DataFrame(verified or {'generated_at': ['2026-08-01T13:00:00Z'],
                                                                'verified_at': ['2026-08-08T13:00:00Z'],
                                                                'direction_correct': [1]})}
    if momentum is not None:
        frames['screener_momentum_snapshots'] = pl.DataFrame(momentum)
    return SimpleNamespace(stocks=pl.DataFrame({'id': [1, 2, 3, 4], 'symbol': ['2330', '1101', '2317', '2454']}),
                           start_date='2026-09-01', end_date='2026-09-02', trading_days=['2026-09-01', '2026-09-02'],
                           market_risk=pl.DataFrame({'date': ['2026-09-01'], 'risk_level': ['green']}),
                           replay_frames=frames)


def signal_rows(flags, confs):
    return {'stock_id': list(range(1, len(flags) + 1)), 'prediction_date': ['2026-09-01'] * len(flags),
            'generated_at': ['2026-09-01T13:00:00Z'] * len(flags), 'direction_accuracy': confs,
            'formal_model_contract_passed': flags, 'forecast_data': [forecast()] * len(flags)}


def test_the_replay_keeps_only_candidates_whose_formal_contract_passed():
    from services.backtest_snapshot_state import frozen_mode_b
    cache, state, _ = frozen_mode_b(dataset(signal_rows([True, False, None, True], [.6, .6, .6, None])))
    assert cache.get('2330', '2026-09-01') == .6
    assert cache.get('1101', '2026-09-01') is None                   # contract failed: Paper drops it
    assert cache.get('2317', '2026-09-01') == .6                     # never recorded: older test, counted
    assert state.formal_contract == {'contract_failed_rows': 1, 'contract_passed_without_confidence_rows': 1,
                                     'unflagged_rows': 1, 'flag_component': True}


def test_a_snapshot_without_the_flag_runs_as_an_approximation():
    from services.backtest_snapshot_state import frozen_mode_b
    rows = signal_rows([True, True], [.6, .7])
    del rows['formal_model_contract_passed']
    cache, state, _ = frozen_mode_b(dataset(rows))
    assert cache.get('1101', '2026-09-01') == .7
    assert state.formal_contract['flag_component'] is False and state.formal_contract['unflagged_rows'] == 2


def test_sealed_momentum_and_p7_rows_reach_the_morning_state():
    from services.backtest_snapshot_state import frozen_mode_b
    from services.backtest_state import entry_open
    zone = {'date': ['2026-09-01'], 'zone': ['YELLOW'], 'percentile_rank': [.3],
            'pool_definition': [risk.MOMENTUM_POOL_DEFINITION], 'created_at': ['2026-09-01T09:00:00Z']}
    _, state, verified = frozen_mode_b(dataset(signal_rows([True], [.6]), momentum=zone))
    assert state._momentum == [{'date': '2026-09-01', 'zone': 'YELLOW', 'percentile_rank': .3,
                                'pool_definition': risk.MOMENTUM_POOL_DEFINITION, 'created_at': '2026-09-01T09:00:00Z'}]
    assert state.ensemble_identity_at(entry_open('2026-09-02')) == ('art', 'c', 's', 'b')
    _, bare, _ = frozen_mode_b(dataset(signal_rows([True], [.6])))
    assert bare._momentum is None


def test_the_snapshot_loader_carries_the_momentum_component(monkeypatch):
    import services.backtest_engine as engine
    import services.research_corporate_history as corporate
    from services.backtest_snapshot_state import MOMENTUM_COMPONENT
    zone = pl.DataFrame({'date': ['2026-08-18'], 'zone': ['RED'], 'percentile_rank': [.9],
                         'pool_definition': [risk.MOMENTUM_POOL_DEFINITION], 'created_at': ['2026-08-18T09:00:00Z']})
    frames = {'stocks': pl.DataFrame({'symbol': ['2330'], 'listed_date': [None], 'delisted_date': [None]}),
              'prices': pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18'], 'open': [1.], 'high': [1.],
                                      'low': [1.], 'close': [1.], 'volume': [1]}),
              'indicators': pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18']}),
              'chips': pl.DataFrame({'symbol': ['2330'], 'date': ['2026-08-18']}),
              'market_risk': pl.DataFrame({'date': ['2026-08-18']}),
              MOMENTUM_COMPONENT: zone}
    monkeypatch.setattr(engine, '_snapshot_component_uris', lambda manifest: {name: name for name in frames})
    monkeypatch.setattr(engine, '_read_snapshot_parquet', lambda uri, transform=None: frames[uri])
    monkeypatch.setattr(corporate, 'load_research_corporate_components', lambda *a, **k: {})
    data = engine.BacktestDataset.load_from_snapshot_manifest({'snapshot_id': 's'}, '2026-08-18', '2026-08-18')
    assert data.replay_frames[MOMENTUM_COMPONENT].to_dicts() == zone.to_dicts()
    assert MOMENTUM_COMPONENT in engine.SNAPSHOT_REPLAY_COMPONENTS
