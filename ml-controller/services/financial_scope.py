"""Constrain financial validation to an explicit request without inventing dates."""
import re
import numpy as np
import pandas as pd


def scope_financial_history(frame, owners, sessions, *, symbols, start_date, lifecycle=None):
    """Omit an unresolved old value only if a later quarter is already available.

    The resolver's latest-quarter policy makes such a value unable to affect any
    output on/after start_date, regardless of its unknown arrival date.
    Raw bytes and the original native frame are retained by the caller.
    """
    if (not symbols or len(symbols) != len(set(symbols)) or
            any(not isinstance(s,str) or not re.fullmatch(r'\d{4,6}(?:[A-Z][A-Z0-9]?)?',s) or len(s)>6 for s in symbols)):
        raise ValueError('financial_request_symbols_invalid')
    if (not frame.index.is_unique or not frame.columns.is_unique or
            any(not re.fullmatch(r'\d{4}-Q[1-4]',str(q)) for q in frame.index)):
        raise ValueError('financial_request_native_identity_invalid')
    start = pd.Timestamp(start_date)
    calendar = pd.DatetimeIndex(sessions)
    if (pd.isna(start) or start.tz is not None or start != start.normalize() or
            calendar.empty or calendar.hasnans or calendar.tz is not None or
            not calendar.is_unique or not calendar.is_monotonic_increasing or
            not (calendar == calendar.normalize()).all()):
        raise ValueError('financial_request_calendar_or_start_invalid')
    if len(owners)!=2 or any(not o.index.is_unique or not o.columns.is_unique for o in owners):
        raise ValueError('financial_request_owner_identity_invalid')
    selected = frame.reindex(columns=symbols).copy()
    values = selected.to_numpy(dtype=float)
    if np.isinf(values).any():raise ValueError('financial_publication_nonfinite_value')
    inactive=[]
    if lifecycle is not None:
        if (lifecycle.get('status')!='verified_terminated_financial_applicability_for_exact_window' or
                lifecycle.get('start_date')!=str(start.date())):
            raise ValueError('financial_lifecycle_scope_mismatch')
        inactive=[r['symbol'] for r in lifecycle['symbols']]
        if len(set(inactive))!=len(inactive) or set(inactive)-set(symbols):
            raise ValueError('financial_lifecycle_symbols_invalid')
        selected.loc[:,inactive]=np.nan
        values=selected.to_numpy(dtype=float)
    dates=[]
    for owner in owners:
        aligned=owner.reindex(index=selected.index,columns=symbols)
        # Only null owner values qualify; malformed provided dates never do.
        for c in aligned.columns:
            if pd.api.types.is_numeric_dtype(aligned[c].dtype) and aligned[c].notna().any():
                raise ValueError('financial_request_owner_date_invalid')
        converted=aligned.apply(lambda c:pd.to_datetime(c,format='mixed',errors='coerce'))
        if any(isinstance(t,pd.DatetimeTZDtype) for t in converted.dtypes):
            raise ValueError('financial_request_owner_date_invalid')
        a=converted.to_numpy(dtype='datetime64[ns]')
        if (aligned.notna().to_numpy() & np.isnat(a)).any():
            raise ValueError('financial_request_owner_date_invalid')
        if (a[~np.isnat(a)] != a[~np.isnat(a)].astype('datetime64[D]')).any():
            raise ValueError('financial_request_owner_date_invalid')
        dates.append(a)
    missing=np.isnat(dates[0]) | np.isnat(dates[1])
    eligible=np.maximum(dates[0],dates[1])
    observed=~np.isnan(values)
    order=np.array([int(q[:4])*4+int(q[-1]) for q in selected.index])
    available=(observed & ~missing & (eligible>=calendar[0].to_datetime64()))
    # A source date before start is insufficient if its next observed session is later.
    positions=np.searchsorted(calendar.to_numpy(dtype='datetime64[ns]'),eligible)
    candidate=np.minimum(positions,len(calendar)-1)
    available &= (positions<len(calendar)) & (calendar.to_numpy(dtype='datetime64[ns]')[candidate]<=start.to_datetime64())
    omitted=[]
    for ci,symbol in enumerate(symbols):
        ready=np.flatnonzero(available[:,ci])
        if not len(ready):continue
        anchor=ready[np.argmax(order[ready])]
        old=np.flatnonzero(observed[:,ci] & missing[:,ci] & (order<order[anchor]))
        for ri in old:
            omitted.append({'symbol':symbol,'quarter':selected.index[ri],
                'superseded_by_quarter':selected.index[anchor],
                'replacement_available_session':str(calendar[positions[anchor,ci]].date()),
                'original_value_retained_in_native':float(values[ri,ci])})
            selected.iat[ri,ci]=np.nan
    return selected, {'policy':'explicit_roster_and_provably_superseded_unresolved_history_only',
        'start_date':str(start.date()),'requested_symbols':list(symbols),
        'raw_extra_symbols_preserved_not_requested':sorted(set(frame.columns)-set(symbols)),
        'raw_absent_requested_symbols_retained_null':sorted(set(symbols)-set(frame.columns)),
        'omitted_unresolved_cells':omitted,'remaining_unresolved_cells':int((selected.notna().to_numpy() & missing).sum()),
        'lifecycle_applicability':lifecycle,'inactive_symbols_retained_null':inactive,
        'values_or_dates_imputed':False,'original_publication_certified':False}
