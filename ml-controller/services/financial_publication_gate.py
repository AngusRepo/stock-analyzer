"""Reject unresolved financial availability; keep the existing deadline recipe."""
import re
import numpy as np
import pandas as pd


def require_consistent_financial_dates(frame, date_owners, *, allow_late=False):
    """Check native valued quarter/symbol cells before SDK deadline alignment.

    This is a consistency gate, not proof of original publication or vintage.
    Missing values need no fabricated publication date. Observed zero does.
    """
    if date_owners is None or len(date_owners) != 2:
        raise ValueError('financial_publication_owners_required')
    if (not frame.index.is_unique or not frame.columns.is_unique or
            any(not re.fullmatch(r'\d{4}-Q[1-4]', str(x)) for x in frame.index)):
        raise ValueError('financial_publication_native_quarter_required')
    values = frame.to_numpy(dtype=float)
    if np.isinf(values).any():
        raise ValueError('financial_publication_nonfinite_value')
    observed = ~np.isnan(values)
    dates = []
    for owner in date_owners:
        if not isinstance(owner, pd.DataFrame) or not owner.index.is_unique or not owner.columns.is_unique:
            raise ValueError('financial_publication_owner_identity_invalid')
        aligned = owner.reindex(index=frame.index, columns=frame.columns)
        # Numeric timestamps are ambiguous and must not silently become nanoseconds.
        for position, (column, dtype) in enumerate(aligned.dtypes.items()):
            if pd.api.types.is_numeric_dtype(dtype):
                if observed[:, position].any():
                    raise ValueError('financial_publication_owner_date_invalid')
                aligned[column] = pd.NaT
        converted = aligned.apply(lambda col: pd.to_datetime(col, errors='coerce'))
        if any(isinstance(dtype, pd.DatetimeTZDtype) for dtype in converted.dtypes):
            raise ValueError('financial_publication_owner_timezone_ambiguous')
        array = converted.to_numpy(dtype='datetime64[ns]')
        if (observed & np.isnat(array)).any():
            raise ValueError('financial_publication_owner_missing')
        dates.append(array)
    disclosure, deadline = dates
    if not allow_late and (observed & (disclosure > deadline)).any():
        raise ValueError('financial_publication_owner_conflict')
    return {'status': 'date_owners_consistent', 'valued_cells': int(observed.sum()),
            'original_publication_certified': False, 'original_value_vintage_certified': False}
