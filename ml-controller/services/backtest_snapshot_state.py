"""Mode B inputs from the same sealed dataset as prices, never live D1."""
from dataclasses import fields
from datetime import datetime, timezone
import math

COMPONENTS = ('signals', 'verified_predictions', 'market_breadth', 'us_market_signals', 'market_regime_state')
# Optional: snapshots exported before it carry no momentum zone; the replay names P6 as not evaluated.
MOMENTUM_COMPONENT = 'screener_momentum_snapshots'


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
    # Paper keeps a candidate only when its formal model contract passed
    # (recommendation_service, formal_family_prediction_missing). Snapshots exported
    # before the flag, and rows that never recorded it, keep the replay's older test
    # (an ensemble row with a confidence) and are counted as approximated (Wei 10/30 §5-4).
    has_flag = 'formal_model_contract_passed' in signals.columns
    formal = {'contract_failed_rows': 0, 'contract_passed_without_confidence_rows': 0, 'unflagged_rows': 0,
              'flag_component': has_flag}
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
        flag = row.get('formal_model_contract_passed') if has_flag else None
        if flag is False:
            formal['contract_failed_rows'] += 1
            continue
        if flag is None:
            formal['unflagged_rows'] += 1
        conf = row['direction_accuracy']
        if conf is None:
            if flag is True:
                formal['contract_passed_without_confidence_rows'] += 1
            continue
        if not isinstance(conf, (int, float)) or not math.isfinite(conf) or not 0 <= conf <= 1:
            raise ValueError('backtest_mode_b_confidence_invalid')
        key = (symbol, day)
        observed = timestamp(row['generated_at'])
        if key in cache and observed == cache[key][0] and conf != cache[key][1]:
            raise ValueError('backtest_mode_b_prediction_revision_ambiguous')
        if key not in cache or observed >= cache[key][0]:
            cache[key] = (observed, conf)
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
