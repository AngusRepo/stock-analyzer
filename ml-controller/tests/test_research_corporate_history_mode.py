"""Research replay on reconstructed corporate history (Wei 10/30, option a)."""
from types import SimpleNamespace

import polars as pl
import pytest

from services import backtest_engine as engine
from services.research_corporate_history import (
    CorporateHistoryGap, RESEARCH_ACCOUNTING_DEFAULTS, make_history_record,
)
from services.research_corporate_preflight import (
    CorporateCoverageError, exclude_history_blocked_symbols, require_corporate_coverage,
)

DAYS = ['2026-09-03', '2026-09-04', '2026-09-07']
CAPTURED = '2026-10-03T01:00:00+00:00'
REFS = [{'dataset': 'finlab.dividend_announcement', 'uri': 'local://sealed.parquet',
         'sha256': 'b' * 64, 'fetched_at': '2026-10-03T00:00:00+00:00'}]


@pytest.fixture(autouse=True)
def tiny_universe_share_gate(request, monkeypatch):
    """These fixtures hold 2-3 symbols, so one exclusion is already a third or half.

    The share gate has its own test at a 1000-symbol scale; elsewhere it is lifted
    so each test exercises the exclusion mechanics it names.
    """
    if request.node.originalname not in ('test_more_than_a_fifth_excluded_stops_the_search',
                                         'test_the_share_gate_stops_the_research_loader',
                                         'test_the_share_gate_stops_weekly_before_replay'):
        from fractions import Fraction
        from services import research_corporate_preflight
        monkeypatch.setattr(research_corporate_preflight, 'MAX_EXCLUDED_SYMBOL_SHARE', Fraction(1))


def history(day, *, symbols=('1101', '2330'), actions=(), blockers=None):
    snap = {'session_date': day, 'covered_symbols': sorted(symbols), 'actions': list(actions),
            'blockers': blockers or {}, 'source_checksum': 'a' * 64, 'tax_basis': 'gross_before_personal_tax'}
    return make_history_record(snap, captured_at=CAPTURED, source_refs=REFS,
                               history_start=DAYS[0], history_end=DAYS[-1])['snapshot']


def dataset(tape, symbols=('1101', '2330'), days=DAYS, suspended=()):
    rows = [{'symbol': s, 'date': d, 'open': 100., 'high': 100., 'low': 100., 'close': 100., 'volume': 1e6}
            for s in symbols for d in days if (s, d) not in suspended]
    stocks = pl.DataFrame({'symbol': list(symbols), 'listed_date': [None] * len(symbols),
                           'delisted_date': [None] * len(symbols), 'market': ['TWSE'] * len(symbols)},
                          schema={'symbol': pl.String, 'listed_date': pl.String,
                                  'delisted_date': pl.String, 'market': pl.String})
    return engine.BacktestDataset(prices=pl.DataFrame(rows), indicators=pl.DataFrame(), chips=pl.DataFrame(),
        market_risk=pl.DataFrame(), stocks=stocks, trading_days=list(days), start_date=days[0], end_date=days[-1],
        corporate_sources=tape)


# ── exclusion: a blocked issuer leaves the whole window; nothing else does ──

def test_blocked_issuer_leaves_universe_for_whole_window_and_coverage_then_passes():
    tape = {d: history(d) for d in DAYS}
    tape[DAYS[2]] = history(DAYS[2], blockers={'2330': ['stock_delivery_issuer_history_unverified']},
        actions=[{'action_id': 'stock-ev', 'symbol': '2330', 'kind': 'stock', 'ex_date': DAYS[2],
                  'payable_date': None, 'cash_per_share': 0., 'stock_per_share': .1}])
    tape[DAYS[2]]['unverified_stock_action_ids'] = {'2330': ['stock-ev']}
    data = dataset(tape)
    with pytest.raises(CorporateCoverageError):
        require_corporate_coverage(data, DAYS[0], DAYS[-1])
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_first_blocked_session'] == {'2330': DAYS[2]}
    assert report['excluded_reason_counts'] == {'stock_delivery_issuer_history_unverified': 1}
    assert report['selection_reads_blockers_through_end_date'] is True
    # Excluded on the first session too: a position opened then would reach the blocked day.
    assert all(data.get_universe_at(d) == {'1101'} for d in DAYS)
    assert not data.get_price_history('2330', DAYS[0], 3).is_empty()
    assert require_corporate_coverage(data, DAYS[0], DAYS[-1])['status'] == 'ready'


def test_unheld_unrelated_old_stock_event_does_not_exclude_issuer():
    # The issuer's unverified stock event is outside every possible entitlement.
    old = {'action_id': 'old-stock', 'symbol': '2330', 'kind': 'stock', 'ex_date': '2026-08-01',
           'payable_date': None, 'cash_per_share': 0., 'stock_per_share': .1}
    tape = {d: history(d, actions=[old], blockers={'2330': ['stock_delivery_issuer_history_unverified']}) for d in DAYS}
    for snap in tape.values():
        snap['unverified_stock_action_ids'] = {'2330': ['old-stock']}
    data = dataset(tape)
    assert exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])['excluded_count'] == 0
    assert data.get_universe_at(DAYS[0]) == {'1101', '2330'}


def test_uncovered_issuer_is_excluded_and_named():
    tape = {d: history(d, symbols=('1101',)) for d in DAYS}
    data = dataset(tape)
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_reason_counts'] == {'event_index_coverage_missing': 1}
    assert data.get_universe_at(DAYS[1]) == {'1101'}


def test_missing_session_is_never_excluded_away():
    tape = {d: history(d) for d in DAYS if d != DAYS[1]}
    data = dataset(tape)
    assert exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])['excluded_count'] == 0
    with pytest.raises(CorporateCoverageError) as err:
        require_corporate_coverage(data, DAYS[0], DAYS[-1])
    assert err.value.report['issues'] == [{'date': DAYS[1], 'reason': 'session_missing'}]


@pytest.mark.parametrize('uncovered,runs', [(199, True), (200, True), (201, False)])
def test_more_than_a_fifth_excluded_stops_the_search(uncovered, runs):
    # Wei 10/30: excluded (blocked + uncovered) > 20% of the holdable universe fails closed; exactly 20% runs.
    from services.research_corporate_preflight import CorporateExclusionTooHigh, MAX_EXCLUDED_SYMBOL_SHARE
    symbols = [str(1000 + i) for i in range(1000)]
    tape = {d: history(d, symbols=symbols[uncovered:]) for d in DAYS}
    data = dataset(tape, symbols=symbols)
    if runs:
        report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
        assert report['excluded_count'] == uncovered and report['excluded_share'] == uncovered / 1000
        assert report['excluded_share_limit'] == '1/5' and report['excluded_share_rule'] == 'fail_when_greater_than_limit'
        assert len(data.get_universe_at(DAYS[0])) == 1000 - uncovered
        return
    with pytest.raises(CorporateExclusionTooHigh, match=r'201/1000 > 1/5') as err:
        exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    from fractions import Fraction
    assert err.value.report['excluded_share'] == 0.201 and MAX_EXCLUDED_SYMBOL_SHARE == Fraction(1, 5)
    assert len(data.get_universe_at(DAYS[0])) == 1000  # nothing excluded from a search that will not run
    from services.research_corporate_preflight import is_corporate_data_error
    assert is_corporate_data_error(err.value)


def test_every_symbol_blocked_fails_instead_of_an_empty_search():
    tape = {d: history(d, symbols=('9999',)) for d in DAYS}
    with pytest.raises(ValueError, match='universe_empty_after_exclusion'):
        exclude_history_blocked_symbols(dataset(tape), DAYS[0], DAYS[-1])


def test_paper_receipt_tape_is_refused_in_history_mode():
    tape = {d: {'session_date': d, 'covered_symbols': ['1101', '2330'], 'actions': [], 'blockers': {}} for d in DAYS}
    with pytest.raises(ValueError, match='mode_requires_history_tape'):
        exclude_history_blocked_symbols(dataset(tape), DAYS[0], DAYS[-1])


def test_holding_a_blocked_symbol_fails_closed_in_accounting():
    tape = {d: history(d, blockers={'2330': ['economic_terms_incomplete:cash:KeyError']}) for d in DAYS}
    data = dataset(tape)
    account = SimpleNamespace(positions={'2330': object()}, corporate_receivables={})
    with pytest.raises(CorporateHistoryGap) as err:
        engine._apply_daily_corporate(account, data, DAYS[0])
    assert err.value.requirements['symbols'] == ['2330']
    assert err.value.requirements['skip_candidate_allowed'] is False


def test_entitlement_after_its_session_is_rejected():
    future = {'action_id': 'cash-ev', 'symbol': '2330', 'kind': 'cash', 'ex_date': DAYS[1],
              'payable_date': '2026-10-01', 'cash_per_share': 1., 'stock_per_share': 0.}
    with pytest.raises(ValueError, match='future_entitlement'):
        history(DAYS[0], actions=[future])


# ── loader opt-in ──

def test_history_opt_in_reads_only_ga_research_snapshot(monkeypatch):
    seen = {}
    snapshot = {'snapshot_id': 'ga'}
    def resolve(**kwargs):
        seen['resolve'] = kwargs
        return SimpleNamespace(snapshot=snapshot, source='snapshot', to_dict=lambda: {'source': 'snapshot'})
    def load(cls, **kwargs):
        seen['load'] = kwargs
        return dataset({d: history(d) for d in DAYS})
    monkeypatch.setattr(engine, 'resolve_research_data_access', resolve)
    monkeypatch.setattr(engine.BacktestDataset, 'load_from_snapshot_manifest', classmethod(load))
    data, access = engine.BacktestDataset.load_for_research(
        lane='optuna.sltp', start_date=DAYS[0], end_date=DAYS[-1], corporate_history=True)
    assert seen['resolve']['kind'] == 'ga_research_dataset'
    assert seen['resolve']['mode'] == 'snapshot'
    assert seen['resolve']['required_components'] == ('signals', 'corporate_history_records')
    assert seen['load']['allow_corporate_history'] is True
    assert access['corporate_source'] == 'corporate_history_records'
    assert access['corporate_history_exclusion']['excluded_count'] == 0
    assert data.research_accounting == RESEARCH_ACCOUNTING_DEFAULTS
    assert access['research_accounting_assumption'] == RESEARCH_ACCOUNTING_DEFAULTS


def test_the_share_gate_stops_the_research_loader(monkeypatch):
    # One of two symbols uncovered = 50% > 20%: every search caller stops at load, before any trial.
    from services.research_corporate_preflight import CorporateExclusionTooHigh, is_corporate_data_error
    monkeypatch.setattr(engine, 'resolve_research_data_access', lambda **_: SimpleNamespace(
        snapshot={}, source='snapshot', to_dict=lambda: {}))
    monkeypatch.setattr(engine.BacktestDataset, 'load_from_snapshot_manifest', classmethod(
        lambda cls, **_: dataset({d: history(d, symbols=('1101',)) for d in DAYS})))
    with pytest.raises(CorporateExclusionTooHigh, match='1/2 > 1/5') as err:
        engine.BacktestDataset.load_for_research(lane='optuna.sltp', start_date=DAYS[0], end_date=DAYS[-1],
                                                 corporate_history=True)
    assert is_corporate_data_error(err.value)


def test_history_opt_in_refuses_d1_and_a_receipt_tape(monkeypatch):
    with pytest.raises(ValueError, match='requires_snapshot:d1_chunked'):
        engine.BacktestDataset.load_for_research(lane='x', start_date=DAYS[0], end_date=DAYS[-1],
                                                 mode='d1_chunked', corporate_history=True)
    monkeypatch.setattr(engine, 'resolve_research_data_access', lambda **_: SimpleNamespace(
        snapshot={}, source='snapshot', to_dict=lambda: {}))
    receipts = {d: {'session_date': d, 'covered_symbols': ['2330'], 'actions': [], 'blockers': {}} for d in DAYS}
    monkeypatch.setattr(engine.BacktestDataset, 'load_from_snapshot_manifest',
                        classmethod(lambda cls, **_: dataset(receipts)))
    with pytest.raises(ValueError, match='tape_not_loaded'):
        engine.BacktestDataset.load_for_research(lane='x', start_date=DAYS[0], end_date=DAYS[-1],
                                                 corporate_history=True)


def test_default_loader_path_is_unchanged(monkeypatch):
    seen = {}
    def resolve(**kwargs):
        seen.update(kwargs)
        raise RuntimeError('stop')
    monkeypatch.setattr(engine, 'resolve_research_data_access', resolve)
    with pytest.raises(RuntimeError, match='stop'):
        engine.BacktestDataset.load_for_research(lane='x', start_date=DAYS[0], end_date=DAYS[-1])
    assert seen['kind'] == 'backtest_dataset'
    assert seen['required_components'] == ('signals', 'corporate_source_records')


def test_issuer_blocked_while_suspended_is_still_excluded():
    # 2330 has no bar on the blocked session; a position bought earlier would still be held.
    tape = {d: history(d) for d in DAYS}
    tape[DAYS[2]] = history(DAYS[2], blockers={'2330': ['economic_terms_incomplete:cash:KeyError']})
    data = dataset(tape, suspended={('2330', DAYS[2])})
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_first_blocked_session'] == {'2330': DAYS[2]}
    assert data.get_universe_at(DAYS[0]) == {'1101'}


def test_revision_of_an_earlier_entitlement_excludes_its_issuer():
    # The entitlement (ex on the first session) is listed from the second session on,
    # and its terms vanish on the third: every past ex_date in the window counts.
    event = {'action_id': 'ev', 'symbol': '2330', 'kind': 'cash', 'ex_date': DAYS[0],
             'payable_date': '2026-10-01', 'cash_per_share': 1., 'stock_per_share': 0., 'cash_rounding': 'floor_twd'}
    tape = {DAYS[0]: history(DAYS[0]), DAYS[1]: history(DAYS[1], actions=[event])}
    tape[DAYS[2]] = history(DAYS[2], blockers={'2330': ['outstanding_event_revision_unresolved']})
    tape[DAYS[2]]['unresolved_outstanding_action_ids'] = {'2330': ['ev']}
    data = dataset(tape)
    report = exclude_history_blocked_symbols(data, DAYS[0], DAYS[-1])
    assert report['excluded_first_blocked_session'] == {'2330': DAYS[2]}


def test_ready_history_replays_with_the_research_accounting_assumption(monkeypatch, kv_position_risk):
    # Preflight cannot see an unrounded issuer cash term; the history dataset carries the
    # research accounting assumption so the replay books it instead of raising mid-search.
    days = [*DAYS, '2026-09-08']
    cash = {'action_id': 'cash-ev', 'symbol': '2330', 'kind': 'cash', 'ex_date': days[2],
            'payable_date': days[3], 'cash_per_share': 1.2345, 'stock_per_share': 0.}
    tape = {d: make_history_record({'session_date': d, 'covered_symbols': ['1101', '2330'],
        'actions': [cash] if d >= days[2] else [], 'blockers': {}, 'source_checksum': 'a' * 64,
        'tax_basis': 'gross_before_personal_tax'}, captured_at=CAPTURED, source_refs=REFS,
        history_start=days[0], history_end=days[-1])['snapshot'] for d in days}
    from test_backtest_corporate_accounting import account
    def buy(**kwargs):
        if kwargs['entry_date'] == days[1]:
            kwargs['account'].positions['2330'] = account().positions['2330']
        return []
    monkeypatch.setattr(engine, 'replay_screener_for_date', lambda **_: ['fixture'])
    monkeypatch.setattr(engine, 'simulate_entries_for_date', buy)
    params = {'positionRiskDistribution': kv_position_risk}
    data = dataset(tape, days=days)
    assert exclude_history_blocked_symbols(data, days[0], days[-1])['excluded_count'] == 0
    assert require_corporate_coverage(data, days[0], days[-1])['status'] == 'ready'
    with pytest.raises(ValueError, match='cash_rounding_missing'):
        engine.replay_period(data, days[0], days[-1], params, initial_capital=109000.)
    data.research_accounting = dict(RESEARCH_ACCOUNTING_DEFAULTS)
    booked, cash_moves = [], []
    real_apply = engine._apply_daily_corporate
    def apply(account, *args, **kwargs):
        before = account.cash
        real_apply(account, *args, **kwargs)
        booked.append(dict(getattr(account, 'corporate_receivables', {})))
        cash_moves.append(account.cash - before)
    monkeypatch.setattr(engine, '_apply_daily_corporate', apply)
    result = engine.replay_period(data, days[0], days[-1], params, initial_capital=109000.)
    assert booked[2]['cash-ev']['cash_due'] == pytest.approx(123.45)  # 100 shares x 1.2345, exact accrual
    assert 'cash-ev' not in booked[3]  # paid on the payable session, at the exact accrued amount
    assert cash_moves[3] == pytest.approx(123.45) and cash_moves[2] == 0
    assert [(a['action_id'], a['mode'], a['adjustment_twd']) for a in result.corporate_rounding_assumptions] == [
        ('cash-ev', 'exact_accrual', 0.0)]
    assert 'researchAccounting' not in params  # nothing can reach a KV push
    # A partial params choice keeps the dataset's other research default.
    seen = {}
    monkeypatch.setattr(engine, '_apply_daily_corporate', lambda account, dataset, day, **kw: seen.update(kw))
    engine.replay_period(data, days[0], days[-1], {**params, 'researchAccounting': {'cashRoundingMode': 'minus_one_twd'}},
                         initial_capital=109000.)
    assert seen == {'research_cash_mode': 'minus_one_twd', 'research_subscription_policy': 'do_not_subscribe_zero_value'}


# ── weekly canonical backtest reads the history snapshot (Wei 11/22) ──

WEEKLY_PARAMS = {'positionRiskDistribution': {'maxPerSector': 3, 'maxSingleNamePct': .18,
    'correlationThreshold': .65, 'correlationWindow': 60, 'minCorrelationOverlap': 20}}


def ga_manifest():
    return {'snapshot_id': 'ga_research_dataset:2026-09-07:corporate-history', 'kind': 'ga_research_dataset',
            'business_date': DAYS[-1], 'created_at': '2026-09-08T03:00:00Z', 'checksum': 'c' * 64,
            'schema_version': 'backtest-dataset-parquet-v2', 'producer_run_id': 'corporate-history',
            'primary_store': 'gcs', 'access_tier': 'compute', 'gcs_uri': 'gs://fixture', 'row_count': 0,
            'metadata_json': {'start_date': DAYS[0], 'end_date': DAYS[-1], 'components': {
                'signals': 'gs://fixture/signals', 'corporate_source_records': 'gs://fixture/receipts',
                'corporate_history_records': 'gs://fixture/history'}}}


def weekly_fixture(monkeypatch, tape, symbols=('1101', '2330')):
    from services import weekly_evidence_service as weekly
    seen = {'kinds': [], 'replays': []}
    snapshot = ga_manifest()
    def latest(**kwargs):
        seen['kinds'].append(kwargs['kind'])
        return snapshot if kwargs['kind'] == 'ga_research_dataset' else receipt_manifest(DAYS[-1])
    def load(**kwargs):
        seen['load'] = kwargs
        return dataset(tape, symbols=symbols)
    def replay(**kwargs):
        seen['replays'].append(kwargs)
        return 'metrics'
    monkeypatch.setattr(weekly, 'latest_dataset_snapshot', latest)
    monkeypatch.setattr(weekly.BacktestDataset, 'load_from_snapshot_manifest', load)
    monkeypatch.setattr(weekly, 'replay_period', replay)
    return weekly, snapshot, seen


def test_weekly_replays_the_history_snapshot_without_unresolved_issuers(monkeypatch):
    tape = {d: history(d) for d in DAYS}
    tape[DAYS[2]] = history(DAYS[2], blockers={'2330': ['stock_delivery_issuer_history_unverified']},
        actions=[{'action_id': 'stock-ev', 'symbol': '2330', 'kind': 'stock', 'ex_date': DAYS[2],
                  'payable_date': None, 'cash_per_share': 0., 'stock_per_share': .1}])
    tape[DAYS[2]]['unverified_stock_action_ids'] = {'2330': ['stock-ev']}
    weekly, snapshot, seen = weekly_fixture(monkeypatch, tape)
    assert weekly.preflight_weekly_backtest_source('2026-09-08')['corporate_source'] == 'corporate_history_records'
    metrics, provenance = weekly._replay(as_of_date='2026-09-08', params=WEEKLY_PARAMS,
                                         initial_capital=100, symbols=None, prefer_corporate_history=True)
    assert metrics == 'metrics' and seen['kinds'] == ['ga_research_dataset', 'backtest_dataset'] * 2
    assert seen['load']['allow_corporate_history'] is True
    replayed = seen['replays'][0]['dataset']
    assert all(replayed.get_universe_at(d) == {'1101'} for d in DAYS)
    assert replayed.research_accounting == RESEARCH_ACCOUNTING_DEFAULTS
    assert provenance['snapshot_id'] == snapshot['snapshot_id']
    assert provenance['corporate_source'] == 'corporate_history_records'
    assert provenance['research_accounting_assumption'] == RESEARCH_ACCOUNTING_DEFAULTS
    exclusion = provenance['corporate_history_exclusion']
    assert exclusion['excluded_count'] == 1 and exclusion['excluded_symbols'] == ['2330']
    assert 'excluded_first_blocked_session' not in exclusion
    assert provenance['history_freshness']['lag_sessions'] == 0  # receipt snapshot ends on the same day


def test_the_share_gate_stops_weekly_before_replay(monkeypatch):
    from services.research_corporate_preflight import CorporateExclusionTooHigh
    symbols = [str(1000 + i) for i in range(10)]
    tape = {d: history(d, symbols=symbols[3:]) for d in DAYS}  # 3/10 uncovered > 1/5
    weekly, _, seen = weekly_fixture(monkeypatch, tape, symbols=symbols)
    with pytest.raises(CorporateExclusionTooHigh, match=r'3/10 > 1/5'):
        weekly._replay(as_of_date='2026-09-08', params=WEEKLY_PARAMS, initial_capital=100, symbols=None,
                       prefer_corporate_history=True)
    assert seen['replays'] == []


def test_weekly_refuses_a_receipt_tape_under_the_history_component(monkeypatch):
    tape = {d: {'session_date': d, 'covered_symbols': ['1101', '2330'], 'actions': [], 'blockers': {}} for d in DAYS}
    weekly, _, seen = weekly_fixture(monkeypatch, tape)
    with pytest.raises(ValueError, match='corporate_history_tape_not_loaded'):
        weekly._replay(as_of_date='2026-09-08', params=WEEKLY_PARAMS, initial_capital=100, symbols=None,
                       prefer_corporate_history=True)
    assert seen['replays'] == []


def test_weekly_history_still_blocks_a_missing_session_after_exclusion(monkeypatch):
    tape = {d: history(d) for d in DAYS[:2]}  # last session absent from the tape
    weekly, _, seen = weekly_fixture(monkeypatch, tape)
    with pytest.raises(CorporateCoverageError, match='session_missing'):
        weekly._replay(as_of_date='2026-09-08', params=WEEKLY_PARAMS, initial_capital=100, symbols=None,
                       prefer_corporate_history=True)
    assert seen['replays'] == []


def test_historical_comparison_keeps_its_original_receipt_source(monkeypatch):
    from services import weekly_evidence_service as weekly
    kinds = []
    def latest(**kwargs):
        kinds.append(kwargs['kind'])
        # A history snapshot exists, but comparison must not ask for it.
        return ga_manifest() if kwargs['kind'] == 'ga_research_dataset' else None
    monkeypatch.setattr(weekly, 'latest_dataset_snapshot', latest)
    with pytest.raises(RuntimeError, match='weekly_evidence_snapshot_not_ready'):
        weekly._replay(as_of_date='2026-09-08', params=WEEKLY_PARAMS, initial_capital=100, symbols=None)
    assert kinds == ['backtest_dataset']


def test_ga_snapshot_with_empty_history_reference_is_not_read_as_receipts(monkeypatch):
    weekly, snapshot, seen = weekly_fixture(monkeypatch, {d: history(d) for d in DAYS})
    snapshot['metadata_json']['components']['corporate_history_records'] = ''
    with pytest.raises(RuntimeError, match='weekly_evidence_snapshot_history_component_missing'):
        weekly._replay(as_of_date='2026-09-08', params=WEEKLY_PARAMS, initial_capital=100, symbols=None,
                       prefer_corporate_history=True)
    assert 'load' not in seen


class Sessions:
    """market_trading_sessions in sqlite, so the real SQL bounds are what is tested."""
    def __init__(self, days):
        import sqlite3
        self.db, self.calls = sqlite3.connect(':memory:'), []
        self.db.row_factory = sqlite3.Row
        self.db.execute('CREATE TABLE market_trading_sessions (session_date TEXT PRIMARY KEY)')
        self.db.executemany('INSERT INTO market_trading_sessions VALUES (?)', [(d,) for d in days])
    def query(self, sql, params):
        self.calls.append((sql, params))
        return [dict(r) for r in self.db.execute(sql, params)]


def receipt_manifest(end):
    manifest = ga_manifest()
    manifest.update(snapshot_id='backtest_dataset:' + end, kind='backtest_dataset', business_date=end)
    manifest['metadata_json'] = {**manifest['metadata_json'], 'end_date': end}
    return manifest


@pytest.mark.parametrize('lagged, runs', [(5, True), (6, False)])
def test_weekly_history_fails_closed_once_it_trails_receipts_by_more_than_five_sessions(monkeypatch, lagged, runs):
    weekly, snapshot, seen = weekly_fixture(monkeypatch, {d: history(d) for d in DAYS})
    later = ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-14', '2026-09-15']
    reference_end = later[lagged - 1]
    def latest(**kwargs):
        seen['kinds'].append(kwargs['kind'])
        return snapshot if kwargs['kind'] == 'ga_research_dataset' else receipt_manifest(reference_end)
    monkeypatch.setattr(weekly, 'latest_dataset_snapshot', latest)
    sessions = Sessions(later)
    monkeypatch.setattr(weekly, 'MARKET', sessions)
    as_of = '2026-09-16'
    if runs:
        _, provenance = weekly._replay(as_of_date=as_of, params=WEEKLY_PARAMS, initial_capital=100,
                                       symbols=None, prefer_corporate_history=True)
        assert provenance['history_freshness'] == {
            'history_end': DAYS[-1], 'reference_snapshot_id': 'backtest_dataset:' + reference_end,
            'reference_end': reference_end, 'lag_sessions': 5, 'max_lag_sessions': 5}
        assert weekly.preflight_weekly_backtest_source(as_of)['history_freshness']['lag_sessions'] == 5
        return
    with pytest.raises(RuntimeError, match=r'history_stale:.*lag_sessions=6>5'):
        weekly._replay(as_of_date=as_of, params=WEEKLY_PARAMS, initial_capital=100, symbols=None,
                       prefer_corporate_history=True)
    assert 'load' not in seen and seen['replays'] == []
    blocked = weekly.preflight_weekly_backtest_source(as_of)
    assert blocked['status'] == 'blocked' and 'history_stale' in blocked['reason']
    assert sessions.calls[0][1] == [DAYS[-1], reference_end]


def test_weekly_history_without_a_reference_snapshot_fails_closed(monkeypatch):
    weekly, snapshot, seen = weekly_fixture(monkeypatch, {d: history(d) for d in DAYS})
    monkeypatch.setattr(weekly, 'latest_dataset_snapshot',
                        lambda **kw: snapshot if kw['kind'] == 'ga_research_dataset' else None)
    with pytest.raises(RuntimeError, match='history_reference_missing'):
        weekly._replay(as_of_date='2026-09-16', params=WEEKLY_PARAMS, initial_capital=100, symbols=None,
                       prefer_corporate_history=True)
    assert 'load' not in seen
    assert weekly.preflight_weekly_backtest_source('2026-09-16')['status'] == 'blocked'


def test_unobserved_sessions_cannot_make_stale_history_look_fresh(monkeypatch):
    weekly, snapshot, seen = weekly_fixture(monkeypatch, {d: history(d) for d in DAYS})
    monkeypatch.setattr(weekly, 'latest_dataset_snapshot', lambda **kw: snapshot
                        if kw['kind'] == 'ga_research_dataset' else receipt_manifest('2026-11-20'))
    monkeypatch.setattr(weekly, 'MARKET', Sessions(['2026-09-08']))  # table stops long before reference_end
    with pytest.raises(RuntimeError, match='history_sessions_unobserved:reference_end=2026-11-20:last_session=2026-09-08'):
        weekly._replay(as_of_date='2026-11-21', params=WEEKLY_PARAMS, initial_capital=100, symbols=None,
                       prefer_corporate_history=True)
    assert 'load' not in seen


def test_canonical_weekly_asks_for_history_and_comparison_does_not(monkeypatch):
    from services import weekly_evidence_service as weekly
    from services import trading_config_loader
    calls = []
    def replay(**kwargs):
        calls.append(kwargs.get('prefer_corporate_history', False))
        return SimpleNamespace(trades=[], equity_curve=[], initial_capital=100), {}
    monkeypatch.setattr(weekly, '_replay', replay)
    monkeypatch.setattr(weekly, 'taiwan_today', lambda: '2026-09-16')
    monkeypatch.setattr(weekly, '_with_formal_position_risk', lambda config: config)
    monkeypatch.setattr(weekly, 'persist_replay_backtest', lambda *a, **kw: {'persisted': True})
    monkeypatch.setattr(weekly, '_metric_summary', lambda metrics: {})
    contract = SimpleNamespace(to_dict=lambda: {})
    monkeypatch.setattr(trading_config_loader, 'load_merged_trading_config_with_contract',
                        lambda: SimpleNamespace(config=dict(WEEKLY_PARAMS), contract=contract))
    assert weekly.run_canonical_weekly_backtest('2026-09-16')['status'] == 'success'
    monkeypatch.setattr(weekly, '_run_monte_carlo', lambda *a, **kw: pytest.skip('reached MC'))
    with pytest.raises(pytest.skip.Exception):
        weekly.run_historical_weekly_comparison(
            as_of_date='2026-09-16', params=WEEKLY_PARAMS, config_version='v1',
            config_checksum=weekly._stable_checksum(WEEKLY_PARAMS), config_effective_at='2026-09-01')
    assert calls == [True, False]
