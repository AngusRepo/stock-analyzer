"""Mode B inputs from the same sealed dataset as prices, never live D1."""
from dataclasses import fields
from datetime import datetime, timezone
import math

COMPONENTS = ('signals', 'verified_predictions', 'market_breadth', 'us_market_signals', 'market_regime_state')
# Optional: snapshots exported before it carry no momentum zone; the replay names P6 as not evaluated.
MOMENTUM_COMPONENT = 'screener_momentum_snapshots'


# Paper's L4 promotion gate (recommendation_service._can_promote_ranking_candidate), program
# values pinned to that source by tests: the formal contract passed, the evidence status is
# sufficient family breadth, and at least two active families (Wei 10/30 A-m4: align).
PAPER_SUFFICIENT_EVIDENCE_STATUS = 'sufficient_family_breadth'
PAPER_MIN_ACTIVE_FAMILIES = 2
FORMAL_EVIDENCE_COLUMNS = ('formal_model_contract_passed', 'formal_evidence_status', 'formal_active_family_count')


def with_formal_evidence(signals):
    """Add Paper's per-candidate promotion evidence from forecast_data.

    Paper reads `coreFamilyEvidence or core_family_evidence` in memory; both are the
    dict apply_core_family_evidence builds, and write_predictions_to_d1 persists it
    as forecast_data `core_family_vote`. A `core_family_evidence` key, if a forecast
    ever carries one, is taken first, a whole dict at a time (an empty or null dict
    falls through, as Python's `or` does). Rows that never recorded it stay null.
    """
    import polars as pl
    dtypes = (pl.Boolean, pl.String, pl.Float64)
    if 'forecast_data' not in signals.columns or signals.schema['forecast_data'] != pl.String:
        return signals.with_columns(pl.lit(None, dtype=t).alias(c) for c, t in zip(FORMAL_EVIDENCE_COLUMNS, dtypes)
                                    if c not in signals.columns)
    data = pl.col('forecast_data')
    evidence = data.str.json_path_match('$.core_family_evidence')
    use_evidence = evidence.str.starts_with('{') & (evidence.str.strip_chars() != '{}')

    def field(name):
        return (pl.when(use_evidence).then(data.str.json_path_match('$.core_family_evidence.' + name))
                .otherwise(data.str.json_path_match('$.core_family_vote.' + name)))
    passed = field('formal_model_contract_passed')
    return signals.with_columns(
        pl.when(passed == 'true').then(pl.lit(True)).when(passed == 'false').then(pl.lit(False))
          .otherwise(pl.lit(None, dtype=pl.Boolean)).alias(FORMAL_EVIDENCE_COLUMNS[0]),
        field('evidence_status').alias(FORMAL_EVIDENCE_COLUMNS[1]),
        field('active_family_count').cast(pl.Float64, strict=False).alias(FORMAL_EVIDENCE_COLUMNS[2]))


PROMOTION_BLOCKED = ('contract_failed', 'evidence_insufficient', 'evidence_missing')


def promotion_verdict(passed, status, families, *, day_recorded: bool = False) -> str:
    """'pass', a PROMOTION_BLOCKED verdict, or an approximation ('unflagged' | 'evidence_unrecorded').

    Paper persists the evidence only for the predictions it evaluated as L3
    candidates; any other prediction reads `{}` there and is never promoted. So on
    a day where some prediction recorded it (`day_recorded`), a row without it is
    blocked ('evidence_missing'). Only a day from before the evidence existed runs
    the replay's older test ('unflagged'), as does a row that recorded the contract
    but neither evidence field ('evidence_unrecorded'). A partly recorded row fails
    like Paper's `or 0` reading.
    """
    if passed is False:
        return 'contract_failed'
    if passed is None:
        return 'evidence_missing' if day_recorded else 'unflagged'
    if status is None and families is None:
        return 'evidence_unrecorded'
    count = families if isinstance(families, (int, float)) and not isinstance(families, bool) and math.isfinite(families) else 0
    if status != PAPER_SUFFICIENT_EVIDENCE_STATUS or count < PAPER_MIN_ACTIVE_FAMILIES:
        return 'evidence_insufficient'
    return 'pass'


def timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed


def ensemble_identity_changes(signals) -> list[tuple]:
    """(generated_at, identity) each time the published ensemble identity changes, oldest first.

    P7 judges the ensemble Paper serves at the open; the replay takes the identity
    of the newest ensemble prediction generated before it. Read with JSON path
    matches so a long signal tape is not parsed row by row.
    """
    import polars as pl
    from services.backtest_paper_risk import P7_IDENTITY_FIELDS
    if 'forecast_data' not in signals.columns or signals.schema['forecast_data'] != pl.String:
        return []
    fields_ = [pl.col('forecast_data').str.json_path_match('$.ensemble_v2.' + name).alias(name)
               for name in P7_IDENTITY_FIELDS]
    frame = (signals.select('generated_at', *fields_).drop_nulls()
             .filter(pl.all_horizontal(pl.col(n).str.len_chars() > 0 for n in P7_IDENTITY_FIELDS)))
    changes: list[tuple] = []
    for row in sorted(frame.iter_rows(), key=lambda r: (timestamp(r[0]), r[1:])):
        identity = tuple(str(v) for v in row[1:])
        if not changes or changes[-1][1] != identity:
            changes.append((timestamp(row[0]), identity))
    return changes


def frozen_mode_b(dataset):
    from services.backtest_engine import MLPredictionsCache
    from services.backtest_state import (BacktestMarketState, MarketRiskRow, MarketBreadthRow, USMarketRow,
                                         RegimeHistory)
    frames = dataset.replay_frames
    missing = [name for name in COMPONENTS if name not in frames]
    if missing:
        raise ValueError('backtest_mode_b_frozen_components_missing:' + ','.join(missing))
    signals = frames['signals']
    if not {'stock_id', 'prediction_date', 'generated_at', 'direction_accuracy'} <= set(signals.columns):
        raise ValueError('backtest_mode_b_signal_schema_invalid')
    identities = dict(dataset.stocks.select('id', 'symbol').iter_rows())
    sessions = sorted(set(dataset.trading_days))
    next_session = dict(zip(sessions, sessions[1:]))
    cache = {}
    # Paper keeps a candidate only when its formal model contract passed and its family
    # evidence qualifies for L4 promotion (recommendation_service). A snapshot exported
    # before the sealed columns is read from its forecast_data the same way. Rows that
    # never recorded the verdict keep the replay's older test (an ensemble row with a
    # confidence) and are counted as approximated (Wei 10/30 §5-4, A-m4).
    has_flag = all(c in signals.columns for c in FORMAL_EVIDENCE_COLUMNS)
    if not has_flag:
        signals = with_formal_evidence(signals)
    import polars as pl
    readable = 'forecast_data' in signals.columns and signals.schema['forecast_data'] == pl.String
    formal = {'contract_failed_rows': 0, 'evidence_insufficient_rows': 0, 'evidence_missing_rows': 0,
              'contract_passed_without_confidence_rows': 0, 'unflagged_rows': 0, 'evidence_unrecorded_rows': 0,
              'flag_component': has_flag,
              'evidence_source': 'sealed_columns' if has_flag else ('forecast_data' if readable else 'none')}

    def entry_cutoff(day):
        entry_day = next_session.get(day)
        return datetime.fromisoformat(entry_day + 'T09:00:00+08:00') if entry_day else None
    # A day counts as recorded only from evidence visible before its entry open.
    recorded_days = {str(day) for day, generated in signals.filter(pl.col(FORMAL_EVIDENCE_COLUMNS[0]).is_not_null())
                     .select('prediction_date', 'generated_at').iter_rows()
                     if entry_cutoff(str(day)) is not None and timestamp(generated) < entry_cutoff(str(day))}
    for row in signals.sort(['generated_at', 'stock_id']).iter_rows(named=True):
        symbol = identities.get(row['stock_id'])
        day = str(row['prediction_date'])
        # Candidates formed on day D enter on the next actual trading session.
        # Match recommendation_service's generated_at < entry_date 01:00 UTC.
        # Midnight D+1 incorrectly rejected legitimate overnight predictions.
        entry_day = next_session.get(day)
        if not entry_day:
            continue
        cutoff = datetime.fromisoformat(entry_day + 'T09:00:00+08:00')
        if not symbol or timestamp(row['generated_at']) >= cutoff:
            continue
        verdict = promotion_verdict(*(row.get(c) for c in FORMAL_EVIDENCE_COLUMNS), day_recorded=day in recorded_days)
        key = (symbol, day)
        observed = timestamp(row['generated_at'])
        if verdict in PROMOTION_BLOCKED:
            formal[verdict + '_rows'] += 1
            # The newest revision decides: a blocked one replaces an earlier admitted one.
            if key not in cache or observed >= cache[key][0]:
                cache[key] = (observed, None)
            continue
        if verdict != 'pass':
            formal[verdict + '_rows'] += 1
        conf = row['direction_accuracy']
        if conf is None:
            if verdict == 'pass':
                formal['contract_passed_without_confidence_rows'] += 1
            continue
        if not isinstance(conf, (int, float)) or not math.isfinite(conf) or not 0 <= conf <= 1:
            raise ValueError('backtest_mode_b_confidence_invalid')
        if key in cache and observed == cache[key][0]:
            if cache[key][1] is None:
                continue                                  # a blocked revision at the same instant wins
            if conf != cache[key][1]:
                raise ValueError('backtest_mode_b_prediction_revision_ambiguous')
        if key not in cache or observed >= cache[key][0]:
            cache[key] = (observed, conf)
    cache = {key: value for key, value in cache.items() if value[1] is not None}
    if not cache:
        raise ValueError('backtest_mode_b_frozen_predictions_empty')
    state = BacktestMarketState.__new__(BacktestMarketState)
    state.start_date, state.end_date = dataset.start_date, dataset.end_date
    for attr, frame, row_type in (('_risk', dataset.market_risk, MarketRiskRow),
            ('_breadth', frames['market_breadth'], MarketBreadthRow),
            ('_us', frames['us_market_signals'], USMarketRow)):
        if 'date' not in frame.columns or frame.is_empty():
            raise ValueError('backtest_mode_b_market_state_missing:' + attr)
        rows = frame.to_dicts()
        if len({r['date'] for r in rows}) != len(rows):
            raise ValueError('backtest_mode_b_duplicate_market_date:' + attr)
        setattr(state, attr, {r['date']: row_type(**{f.name:r.get(f.name) for f in fields(row_type)}) for r in rows})
    # The HMM regime owner, frozen with the rest; the era starts at the first HMM row visible before an open.
    state._regime = RegimeHistory(frames['market_regime_state'].to_dicts())
    momentum = frames.get(MOMENTUM_COMPONENT)
    state._momentum = momentum.to_dicts() if momentum is not None else None
    state._ensemble_identities = ensemble_identity_changes(signals)
    state.formal_contract = formal
    verified = frames['verified_predictions']
    if not {'generated_at', 'verified_at', 'direction_correct'} <= set(verified.columns):
        raise ValueError('backtest_mode_b_verified_schema_invalid')
    return MLPredictionsCache({k:v[1] for k,v in cache.items()}), state, verified.to_dicts()
