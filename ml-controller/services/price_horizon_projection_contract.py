"""Shared SQL contract for point-in-time five-session outcome labels."""
from __future__ import annotations

PRICE_HORIZON_PROJECTION_VERSION = "price_horizon_v1"
PRICE_HORIZON_SOURCE = "stock_prices:finlab_primary_canonical_mirror"

PRICE_HORIZONS_CTE = """
price_horizons AS (
    SELECT
        stock_id,
        price_date,
        entry_date,
        entry_raw_open,
        entry_adjustment_factor,
        exit_date,
        exit_raw_close,
        exit_adjustment_factor,
        outcome_known_date,
        source
    FROM price_horizon_labels_v1
    WHERE projection_version = 'price_horizon_v1'
)
""".strip()
