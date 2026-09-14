from datetime import date, timedelta
from app.sequence_full_fit import full_history_fit_rows, full_history_fold_rows


def records():
    days = [(date(2026,1,1)+timedelta(days=i)).isoformat() for i in range(45)
            if (date(2026,1,1)+timedelta(days=i)).weekday()<5]
    result = []
    for n in range(12):
        ds = days[:-2] if n == 11 else days
        if n == 10:
            ds = [d for d in ds if d != days[8]]
        result.append({'symbol':str(n), 'market_type':'LISTED', 'dates':ds,
            'close':[100.+days.index(d)+n for d in ds], 'open':[99.+days.index(d)+n for d in ds]})
    return days, result


def test_full_fit_retains_multiple_windows_and_aligns_peers_by_real_date():
    days, source = records()
    rows, panel, report = full_history_fit_rows(source,seq_len=4,pred_len=2,max_series=12)
    assert report['unique_training_windows'] > 10*report['selected_series']
    assert report['calendar_end'] == days[-1]
    by_id = {}
    for row in rows:
        by_id.setdefault(row['unique_id'],{})[row['ds']] = row['y']
    # A missing middle observation must not shift every later day to the left.
    assert by_id['10'][9]-by_id['0'][9] == 10
    assert by_id['10'][8] == by_id['10'][7]  # existing causal ffill policy


def test_validation_uses_one_calendar_and_missing_outcomes_do_not_select_training_members():
    days, source = records()
    rows, evaluation, report = full_history_fold_rows(source,seq_len=4,pred_len=2,max_series=12)
    assert report['selected_series'] == 12
    assert report['evaluation_series'] == 11
    assert {r['unique_id'] for r in rows} == {str(i) for i in range(12)}
    assert {r['signal_date'] for r in evaluation} == {days[-3]}
    assert {r['outcome_date'] for r in evaluation} == {days[-1]}
    assert max(r['ds'] for r in rows) == len(days)-3
    older = full_history_fold_rows(source,seq_len=4,pred_len=2,max_series=12,holdout_offset=2)[2]
    assert older['outcome_date'] == report['signal_date']
