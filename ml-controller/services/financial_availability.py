"""Resolve deadline/disclosure semantics into causal financial availability."""
import hashlib
import numpy as np
import pandas as pd
import polars as pl
from services.financial_publication_gate import require_consistent_financial_dates


def align_financial_availability(frame, date_owners, sessions):
    # Validate identities and missing dates, but late disclosure is resolvable.
    proof = require_consistent_financial_dates(frame, date_owners, allow_late=True)
    calendar = pd.DatetimeIndex(sessions)
    if (calendar.empty or calendar.tz is not None or calendar.hasnans or
            not calendar.is_unique or not calendar.is_monotonic_increasing or
            not (calendar == calendar.normalize()).all()):
        raise ValueError('financial_availability_calendar_invalid')
    values = frame.to_numpy(dtype=float)
    observed = ~np.isnan(values.ravel())
    disclosure, deadline = [x.reindex(index=frame.index, columns=frame.columns).apply(
        lambda col: pd.to_datetime(col, errors='coerce')).to_numpy(dtype='datetime64[ns]').ravel()
        for x in date_owners]
    quarters = np.repeat(np.asarray(frame.index, dtype=str), len(frame.columns))
    symbols = np.tile(np.asarray(frame.columns, dtype=str), len(frame.index))
    events = pl.DataFrame({'quarter': quarters[observed], 'symbol': symbols[observed],
        'value': values.ravel()[observed], 'disclosure_date': disclosure[observed],
        'deadline_date': deadline[observed]}).with_columns(
            pl.max_horizontal('disclosure_date','deadline_date').alias('eligible_date'))
    cal = pl.DataFrame({'session': calendar.to_numpy()}).with_columns(pl.col('session').cast(pl.Datetime('ns')))
    events = events.sort('eligible_date').join_asof(cal, left_on='eligible_date', right_on='session', strategy='forward')
    # Do not extrapolate a trading calendar beyond its observed bounds.
    events = events.with_columns(pl.when(pl.col('eligible_date') < cal['session'][0])
        .then(pl.lit(None,dtype=pl.Datetime('ns'))).otherwise(pl.col('session')).alias('session'))
    pending = events.filter(pl.col('session').is_null()).height
    ready = events.filter(pl.col('session').is_not_null()).sort(['symbol','session','quarter'])
    ready = ready.with_columns((pl.col('quarter').str.slice(0,4).cast(pl.Int32)*4 +
        pl.col('quarter').str.slice(6,1).cast(pl.Int32)).alias('quarter_order'))
    ready = ready.with_columns(pl.col('quarter_order').cum_max().over('symbol').alias('latest_quarter'))
    stale = ready.filter(pl.col('quarter_order') < pl.col('latest_quarter')).height
    selected = ready.filter(pl.col('quarter_order') == pl.col('latest_quarter')).unique(
        ['symbol','session'],keep='last',maintain_order=True)
    if selected.is_empty():
        output = pd.DataFrame(index=pd.DatetimeIndex([],name='date'),columns=frame.columns,dtype=float)
    else:
        output = selected.select('session','symbol','value').pivot(on='symbol',index='session',values='value').sort('session').to_pandas().set_index('session')
        output = output.reindex(columns=frame.columns).ffill()
        output.index.name='date'
    proof.update({'status':'availability_resolved','policy':'not_before_deadline_or_vendor_disclosure_next_observed_session',
        'late_disclosure_cells':events.filter(pl.col('disclosure_date')>pl.col('deadline_date')).height,
        'calendar_unresolved_cells':pending,'older_quarter_late_arrivals_not_overwriting':stale,
        'output_rows':len(output),'original_publication_certified':False,
        'date_basis':'FinLab reported disclosure/upload-or-fallback; not independently original publication certified'})
    output.attrs['financial_availability_proof']=proof
    output.attrs['financial_availability_events']=events
    return output
