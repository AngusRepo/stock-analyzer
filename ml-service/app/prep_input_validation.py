"""Fail before fitting when a sealed prep batch is incomplete or misaligned."""
from __future__ import annotations
import numpy as np
import polars as pl


def validate_tabular_batch(data, *, key: str) -> None:
    required = {"X", "y", "target_returns", "dates", "symbols", "markets", "label_known_dates", "missingness_rates"}
    missing = sorted(required - set(data.files))
    if missing:
        raise ValueError(f"prep_required_fields_missing:{key}:{','.join(missing)}")
    X = np.asarray(data["X"])
    if X.ndim != 2 or X.shape[1] == 0 or not np.isfinite(X).all():
        raise ValueError(f"prep_features_invalid:{key}")
    for name in required - {"X", "missingness_rates"}:
        values = np.asarray(data[name])
        if values.shape != (len(X),):
            raise ValueError(f"prep_row_alignment_invalid:{key}:{name}")
        if name in {"y", "target_returns"}:
            if not np.isfinite(values).all():
                raise ValueError(f"prep_target_nonfinite:{key}:{name}")
        elif np.any(np.char.strip(values.astype(str)) == ""):
            raise ValueError(f"prep_lineage_empty:{key}:{name}")
    rates = np.asarray(data["missingness_rates"], dtype=float)
    if rates.shape != (X.shape[1],) or not np.isfinite(rates).all() or np.any((rates < 0) | (rates > 1)):
        raise ValueError(f"prep_missingness_invalid:{key}")
    dates = np.asarray(data["dates"]).astype(str)
    known = np.asarray(data["label_known_dates"]).astype(str)
    try:
        if np.any(known.astype("datetime64[D]") <= dates.astype("datetime64[D]")):
            raise ValueError("label maturity must follow signal")
        if np.isnat(known.astype("datetime64[D]")).any() or np.isnat(dates.astype("datetime64[D]")).any():
            raise ValueError("date is NaT")
    except (ValueError, TypeError) as exc:
        raise ValueError(f"prep_label_dates_invalid:{key}") from exc


def validate_prep_keys(dates, symbols, markets) -> None:
    keys = pl.DataFrame({"date": np.asarray(dates).astype(str), "symbol": np.asarray(symbols).astype(str),
                         "market": np.asarray(markets).astype(str)})
    if keys.is_duplicated().any():
        raise ValueError("prep_duplicate_market_symbol_date")


def validate_feature_names(names, width: int) -> None:
    if not isinstance(names, list) or len(names) != width or any(not isinstance(n, str) or not n.strip() for n in names) or len(set(names)) != width:
        raise ValueError("prep_feature_names_invalid")
