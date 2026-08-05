"""Shared SQL contract for point-in-time five-session outcome labels."""
from __future__ import annotations

PRICE_HORIZON_PROJECTION_VERSION = "price_horizon_v3_canonical_reference_identity"
PRICE_HORIZON_SOURCE = "stock_prices:finlab_primary_canonical_mirror"
OOF_PRICE_HORIZON_SOURCE = "canonical_market_daily:finlab.price"


def expected_price_horizon_source(generation_mode: object) -> str:
    """Return the only legal price lineage for the requested evidence lane."""
    return (
        OOF_PRICE_HORIZON_SOURCE
        if str(generation_mode or "").strip().lower() == "purged_oof"
        else PRICE_HORIZON_SOURCE
    )

PRICE_HORIZONS_CTE = f"""
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
    WHERE projection_version = '{PRICE_HORIZON_PROJECTION_VERSION}'
)
""".strip()
