"""S1: the research snapshot seals what Paper's morning chain reads (momentum zone, P7 rows, formal verdict)."""
import json
from types import SimpleNamespace

import polars as pl
import pytest

from services import backtest_paper_risk as risk


SUFFICIENT = 'sufficient_family_breadth'


def forecast(*, passed=None, art='art', status=SUFFICIENT, families=3, key='core_family_vote', extra=None):
    payload = {'ensemble_v2': {'artifact_id': art, 'cohort_id': 'c', 'artifact_checksum': 's',
                               'base_artifact_set_checksum': 'b', 'forecast_horizon_bars': 5}}
    if passed is not None:
        evidence = {'formal_model_contract_passed': passed}
        if status is not None:
            evidence['evidence_status'] = status
        if families is not None:
            evidence['active_family_count'] = families
        payload[key] = evidence
    payload.update(extra or {})
    return json.dumps(payload)


def evidence_of(rows):
    from services.backtest_snapshot_state import FORMAL_EVIDENCE_COLUMNS, with_formal_evidence
    frame = with_formal_evidence(pl.DataFrame({'forecast_data': rows}))
    return [tuple(r[c] for c in FORMAL_EVIDENCE_COLUMNS) for r in frame.iter_rows(named=True)]


def test_promotion_evidence_comes_from_forecast_data_and_stays_null_when_never_recorded():
    assert evidence_of([forecast(passed=True), forecast(passed=False, status='insufficient_family_breadth', families=1),
                        forecast(), 'not json', None]) == [
        (True, SUFFICIENT, 3.), (False, 'insufficient_family_breadth', 1.), (None, None, None),
        (None, None, None), (None, None, None)]
    from services.backtest_snapshot_state import with_formal_evidence
    bare = with_formal_evidence(pl.DataFrame({'stock_id': [1, 2]}))
    assert bare['formal_model_contract_passed'].to_list() == [None] * 2
    assert bare['formal_active_family_count'].to_list() == [None] * 2


def test_paper_s_evidence_dict_wins_whole_and_an_empty_one_falls_through():
    # Paper: coreFamilyEvidence or core_family_evidence -> the stored core_family_evidence, then core_family_vote.
    vote = {'core_family_vote': {'formal_model_contract_passed': True, 'evidence_status': SUFFICIENT,
                                 'active_family_count': 4}}
    assert evidence_of([forecast(passed=False, key='core_family_evidence', status=None, families=None, extra=vote)]) == [
        (False, None, None)]                                          # never mixed field by field
    assert evidence_of([forecast(extra={'core_family_evidence': {}, **vote})]) == [(True, SUFFICIENT, 4.)]
    assert evidence_of([forecast(extra={'core_family_evidence': None, **vote})]) == [(True, SUFFICIENT, 4.)]


@pytest.mark.parametrize('evidence, verdict', [
    ((True, SUFFICIENT, 2.), 'pass'),
    ((True, SUFFICIENT, 1.), 'evidence_insufficient'),
    ((True, SUFFICIENT, 1.999), 'evidence_insufficient'),
    ((True, 'insufficient_family_breadth', 4.), 'evidence_insufficient'),
    ((True, SUFFICIENT, None), 'evidence_insufficient'),               # Paper: `or 0` < 2
    ((True, None, 3.), 'evidence_insufficient'),
    ((True, SUFFICIENT, float('nan')), 'evidence_insufficient'),
    ((True, None, None), 'evidence_unrecorded'),
    ((False, SUFFICIENT, 4.), 'contract_failed'),
    ((None, None, None), 'unflagged'),
])
def test_the_promotion_verdict_follows_paper_s_three_conditions(evidence, verdict):
    from services.backtest_snapshot_state import promotion_verdict
    assert promotion_verdict(*evidence) == verdict


def test_the_promotion_constants_are_paper_s_own():
    from pathlib import Path
    from services import backtest_snapshot_state as state
    source = (Path(__file__).resolve().parents[1] / 'services' / 'recommendation_service.py').read_text(encoding='utf-8')
    body = source[source.index('def _can_promote_ranking_candidate'):]
    body = body[:body.index('\ndef ')]
    assert 'family.get("formal_model_contract_passed") is not True' in body
    assert f'family.get("evidence_status") != "{state.PAPER_SUFFICIENT_EVIDENCE_STATUS}"' in body
    assert f'(_finite_float_or_none(family.get("active_family_count")) or 0) < {state.PAPER_MIN_ACTIVE_FAMILIES}' in body
    assert 'components.get("coreFamilyEvidence") or row.get("core_family_evidence")' in body
    # The replay reads what write_predictions_to_d1 persists: the evidence dict as core_family_vote.
    assert '"core_family_vote": data.get("core_family_vote")' in source
    assert 'pred["core_family_vote"] = evidence' in source


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
    sealed = result['components']['signals']
    assert sealed.select('formal_model_contract_passed', 'formal_evidence_status',
                         'formal_active_family_count').rows() == [(True, SUFFICIENT, 3.)]


def dataset(signal_rows, *, momentum=None, verified=None, days=('2026-09-01', '2026-09-02')):
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
                           start_date=days[0], end_date=days[-1], trading_days=list(days),
                           market_risk=pl.DataFrame({'date': ['2026-09-01'], 'risk_level': ['green']}),
                           replay_frames=frames)


def signal_rows(flags, confs, statuses=None, families=None, dates=None, stocks=None, generated=None):
    n = len(flags)
    dates = dates or ['2026-09-01'] * n
    return {'stock_id': stocks or list(range(1, n + 1)), 'prediction_date': dates,
            'generated_at': generated or [d + 'T13:00:00Z' for d in dates], 'direction_accuracy': confs,
            'formal_model_contract_passed': flags,
            'formal_evidence_status': statuses or [SUFFICIENT if f is not None else None for f in flags],
            'formal_active_family_count': families or [3. if f is not None else None for f in flags],
            'forecast_data': [forecast()] * n}


def test_the_replay_keeps_only_candidates_whose_formal_contract_passed():
    from services.backtest_snapshot_state import frozen_mode_b
    cache, state, _ = frozen_mode_b(dataset(signal_rows([True, False, None, True], [.6, .6, .6, None])))
    assert cache.get('2330', '2026-09-01') == .6
    assert cache.get('1101', '2026-09-01') is None                   # contract failed: Paper drops it
    assert cache.get('2317', '2026-09-01') is None                   # not evaluated by Paper that day: `{}`
    assert state.formal_contract == {'contract_failed_rows': 1, 'evidence_insufficient_rows': 0,
                                     'evidence_missing_rows': 1, 'contract_passed_without_confidence_rows': 1,
                                     'unflagged_rows': 0, 'evidence_unrecorded_rows': 0, 'flag_component': True,
                                     'evidence_source': 'sealed_columns'}


def test_only_a_day_from_before_the_evidence_runs_unflagged_rows():
    from services.backtest_snapshot_state import frozen_mode_b
    days = ('2026-08-31', '2026-09-01', '2026-09-02')
    rows = signal_rows([None, None, True, None], [.6, .7, .8, .9], dates=['2026-08-31', '2026-08-31', '2026-09-01',
                                                                          '2026-09-01'], stocks=[1, 2, 3, 4])
    cache, state, _ = frozen_mode_b(dataset(rows, days=days))
    assert [cache.get(s, d) for s, d in (('2330', '2026-08-31'), ('1101', '2026-08-31'), ('2317', '2026-09-01'),
                                         ('2454', '2026-09-01'))] == [.6, .7, .8, None]
    assert state.formal_contract['unflagged_rows'] == 2 and state.formal_contract['evidence_missing_rows'] == 1
    # Evidence first recorded after the entry open does not make the day's earlier rows missing.
    late = signal_rows([None, True], [.6, .7], stocks=[1, 2], generated=['2026-09-01T13:00:00Z', '2026-09-02T02:00:00Z'])
    cache, state, _ = frozen_mode_b(dataset(late))
    assert cache.get('2330', '2026-09-01') == .6 and state.formal_contract['unflagged_rows'] == 1


def test_the_newest_revision_decides_even_when_it_is_blocked():
    from services.backtest_snapshot_state import frozen_mode_b
    rows = signal_rows([True, True, True], [.6, .6, .6], families=[3., 1., 3.], stocks=[1, 1, 2],
                       generated=['2026-09-01T10:00:00Z', '2026-09-01T13:00:00Z', '2026-09-01T13:00:00Z'])
    cache, state, _ = frozen_mode_b(dataset(rows))
    assert cache.get('2330', '2026-09-01') is None and cache.get('1101', '2026-09-01') == .6
    same = signal_rows([True, True, True], [.6, .6, .6], families=[1., 3., 3.], stocks=[1, 1, 2])
    cache, _, _ = frozen_mode_b(dataset(same))
    assert cache.get('2330', '2026-09-01') is None                   # a blocked revision at the same instant wins
    reversed_ = signal_rows([True, True, True], [.6, .6, .6], families=[3., 1., 3.], stocks=[1, 1, 2])
    cache, _, _ = frozen_mode_b(dataset(reversed_))
    assert cache.get('2330', '2026-09-01') is None
    no_conf = signal_rows([True, True, True], [.6, None, .6], stocks=[1, 1, 2],
                          generated=['2026-09-01T10:00:00Z', '2026-09-01T13:00:00Z', '2026-09-01T13:00:00Z'])
    cache, _, _ = frozen_mode_b(dataset(no_conf))
    assert cache.get('2330', '2026-09-01') is None                   # the newest revision has no confidence


def test_a_day_whose_every_candidate_is_blocked_is_not_a_prediction_day():
    from services.backtest_snapshot_state import frozen_mode_b
    days = ('2026-08-31', '2026-09-01', '2026-09-02')
    rows = signal_rows([True, False], [.6, .7], dates=['2026-08-31', '2026-09-01'], stocks=[1, 2])
    cache, _, _ = frozen_mode_b(dataset(rows, days=days))
    assert cache._dates == {'2026-08-31'}
    with pytest.raises(ValueError, match='frozen_predictions_empty'):
        frozen_mode_b(dataset(signal_rows([False], [.6])))


def test_the_replay_drops_candidates_paper_s_l4_promotion_would_not_qualify():
    from services.backtest_snapshot_state import frozen_mode_b
    rows = signal_rows([True] * 4, [.6] * 4, statuses=[SUFFICIENT, 'insufficient_family_breadth', SUFFICIENT, None],
                       families=[2., 4., 1., None])
    cache, state, _ = frozen_mode_b(dataset(rows))
    assert [cache.get(s, '2026-09-01') for s in ('2330', '1101', '2317', '2454')] == [.6, None, None, .6]
    assert state.formal_contract['evidence_insufficient_rows'] == 2           # the status, then a single family
    assert state.formal_contract['evidence_unrecorded_rows'] == 1              # 2454: neither field, runs and is named


def test_an_old_snapshot_is_read_from_forecast_data_like_paper():
    from services.backtest_snapshot_state import frozen_mode_b
    rows = signal_rows([True, True, True], [.6, .7, .8])
    for column in ('formal_model_contract_passed', 'formal_evidence_status', 'formal_active_family_count'):
        del rows[column]
    rows['forecast_data'] = [forecast(passed=True, families=2), forecast(passed=True, families=1), forecast()]
    cache, state, _ = frozen_mode_b(dataset(rows))
    assert [cache.get(s, '2026-09-01') for s in ('2330', '1101', '2317')] == [.6, None, None]
    assert state.formal_contract['flag_component'] is False
    assert state.formal_contract['evidence_source'] == 'forecast_data'
    assert state.formal_contract['evidence_insufficient_rows'] == 1 and state.formal_contract['evidence_missing_rows'] == 1


def test_a_snapshot_sealing_only_the_contract_flag_is_reread_from_forecast_data():
    # The first S1 exporter sealed formal_model_contract_passed alone, beside forecast_data.
    from services.backtest_snapshot_state import frozen_mode_b
    rows = signal_rows([True, True], [.6, .7])
    del rows['formal_evidence_status'], rows['formal_active_family_count']
    rows['forecast_data'] = [forecast(passed=True, families=2), forecast(passed=True, families=1)]
    cache, state, _ = frozen_mode_b(dataset(rows))
    assert [cache.get(s, '2026-09-01') for s in ('2330', '1101')] == [.6, None]
    assert state.formal_contract['flag_component'] is False and state.formal_contract['evidence_insufficient_rows'] == 1


def test_a_non_string_forecast_column_reads_nothing_and_says_so():
    from services.backtest_snapshot_state import frozen_mode_b
    rows = signal_rows([True], [.6])
    for column in ('formal_model_contract_passed', 'formal_evidence_status', 'formal_active_family_count'):
        del rows[column]
    rows['forecast_data'] = [None]
    _, state, _ = frozen_mode_b(dataset(rows))
    assert state.formal_contract['evidence_source'] == 'none' and state.formal_contract['unflagged_rows'] == 1


def test_a_snapshot_without_the_flag_runs_as_an_approximation():
    from services.backtest_snapshot_state import frozen_mode_b
    rows = signal_rows([True, True], [.6, .7])
    for column in ('formal_model_contract_passed', 'formal_evidence_status', 'formal_active_family_count'):
        del rows[column]
    cache, state, _ = frozen_mode_b(dataset(rows))
    assert cache.get('1101', '2026-09-01') == .7
    assert state.formal_contract['flag_component'] is False and state.formal_contract['unflagged_rows'] == 2
    del rows['forecast_data']
    _, state, _ = frozen_mode_b(dataset(rows))
    assert state.formal_contract['evidence_source'] == 'none' and state.formal_contract['unflagged_rows'] == 2


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
