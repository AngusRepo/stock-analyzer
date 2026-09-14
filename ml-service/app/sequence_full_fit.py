"""Calendar-aligned full-history inputs shared by sequence release refits.

Reuse the repaired OOF panel constructor. Training membership depends only on
prices observable at the training cutoff; missing future labels do not remove
variates from an iTransformer training panel.
"""
from __future__ import annotations
import math


def full_history_fit_rows(records, *, seq_len, pred_len, max_series, train_end=None):
    from .neuralforecast_sequence_runtime import _canonical_sequence_calendar, _build_fixed_oof_panel
    calendar = _canonical_sequence_calendar(records)
    if not calendar:
        raise ValueError('full_fit_sequence_calendar_empty')
    cutoff = train_end or calendar[-1]
    rows, panel, report = _build_fixed_oof_panel(records, calendar=calendar,
        train_end=cutoff, seq_len=seq_len, pred_len=pred_len, max_series=max_series,
        training_history_mode='full_pit_history')
    return rows, panel, report


def full_history_fold_rows(records, *, seq_len, pred_len, max_series, holdout_offset=0):
    from .neuralforecast_sequence_runtime import _canonical_sequence_calendar
    calendar = _canonical_sequence_calendar(records)
    end_index = len(calendar) - 1 - int(holdout_offset)
    signal_index = end_index - int(pred_len)
    if signal_index < seq_len + pred_len - 1:
        raise ValueError('full_fit_sequence_fold_history_insufficient')
    signal, entry, outcome = calendar[signal_index], calendar[signal_index+1], calendar[end_index]
    rows, panel, report = full_history_fit_rows(records, seq_len=seq_len, pred_len=pred_len,
        max_series=max_series, train_end=signal)
    final_closes = {row['unique_id']: row['y'] for row in rows}
    evaluation = []
    for record in panel:
        symbol = str(record['symbol'])
        dates = [str(value)[:10] for value in record['dates']]
        opens, closes = record.get('open') or [], record.get('close') or []
        if len(opens) != len(dates) or len(closes) != len(dates) or len(set(dates)) != len(dates):
            raise ValueError('full_fit_sequence_label_lineage_invalid')
        index = {day: i for i, day in enumerate(dates)}
        if entry not in index or outcome not in index:
            continue
        entry_open, outcome_close = float(opens[index[entry]]), float(closes[index[outcome]])
        if not all(math.isfinite(v) and v > 0 for v in (entry_open, outcome_close)):
            continue
        evaluation.append({'unique_id': symbol,
            'market': str(record.get('market_type') or record.get('market') or 'TW').upper(),
            'last_close': float(final_closes[symbol]), 'entry_open': entry_open,
            'actual_last': outcome_close, 'signal_date': signal, 'outcome_date': outcome,
            'history_len': report['calendar_rows'] + pred_len})
    return rows, evaluation, {**report, 'signal_date': signal, 'outcome_date': outcome,
        'holdout_offset': holdout_offset, 'evaluation_series': len(evaluation),
        'missing_label_series': len(panel) - len(evaluation),
        'split_owner': 'shared_canonical_session_calendar'}
