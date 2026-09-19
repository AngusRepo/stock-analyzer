"""Source availability metadata and causal joins shared by train and serving."""
from __future__ import annotations
import polars as pl

PIT_FIELDS = (
    "revenue_yoy", "revenue_mom", "revenue", "retail_pct", "eps", "roe", "pe", "pb",
    "dividend_yield", "revenue_growth_yoy", "margin_balance", "short_balance", "short_ratio",
    "sector", "sector_flow_core", "sector_rs_ratio", "sector_turnover_share_delta",
    "market_cap_proxy", "disposal_active", "limit_down_count", "locked_open_down",
)
# These inputs otherwise silently become neutral values; zero itself remains valid.
SOURCE_DEPENDENCIES = {
    "l1_brokerConcentration": ("broker_concentration",),
    "l1_brokerNetAmount5d": ("broker_estimated_amount", "broker_net_shares"),
    "l1_diTrend": ("plusDi14", "minusDi14"),
    "tech_adx_14": ("adx14",), "tech_sar": ("parabolicSar",),
    "l1_sectorFlowCore": ("sector_flow_core",), "l1_sectorRsRatio": ("sector_rs_ratio",),
    "l1_sectorTurnoverShareDelta": ("sector_turnover_share_delta",),
    "size_log_mktcap": ("market_cap_proxy",), "tech_disposal_active": ("disposal_active",),
    "tech_limit_down_count_10": ("limit_down_count",), "tech_locked_open_down_10": ("locked_open_down",),
    "l1_eps": ("eps",), "l1_roe": ("roe",), "l1_monthlyRevenueYoY": ("revenue_yoy",),
    "l1_monthlyRevenueMoM": ("revenue_mom",), "l1_revenueGrowthYoY": ("revenue_growth_yoy",),
    "val_ep": ("pe",), "val_bp": ("pb",), "val_dp": ("dividend_yield",), "val_sp": ("revenue",),
}


def require_unique_dates(df: pl.DataFrame, source: str) -> None:
    if df["date"].null_count() or df["date"].n_unique() != df.height:
        raise ValueError(f"feature_data_quality_invalid_date_keys:{source}")


def join_available_history(df: pl.DataFrame, history: dict) -> pl.DataFrame:
    """Keys must be available dates, never accounting periods or current snapshots.

    A non-trading-day release becomes usable at the first following observed
    session. Each field carries its last known observation independently.
    """
    records = [{"date": day, **{k: v for k, v in values.items() if k in PIT_FIELDS}}
               for day, values in history.items() if isinstance(values, dict)]
    if not records:
        return df
    hist = pl.DataFrame(records, infer_schema_length=None).with_columns(pl.col("date").cast(pl.Date)).sort("date")
    require_unique_dates(hist, "available_history")
    fields = [c for c in PIT_FIELDS if c in hist.columns]
    if not fields:
        return df
    hist = hist.with_columns([
        (pl.col(c).cast(pl.String) if c == "sector" else
         pl.when(pl.col(c).cast(pl.Float64, strict=False).is_finite())
         .then(pl.col(c).cast(pl.Float64, strict=False)).otherwise(None)).forward_fill().alias(c)
        for c in fields
    ])
    joined = df.sort("date").join_asof(hist.select(["date"] + fields), on="date", strategy="backward", suffix="_pit")
    overlap = [c for c in fields if c + "_pit" in joined.columns]
    if overlap:
        joined = joined.with_columns([pl.coalesce(c + "_pit", c).alias(c) for c in overlap]).drop([c + "_pit" for c in overlap])
    return joined


def feature_missing_masks(df: pl.DataFrame, env: dict, meta: dict, historical: bool) -> dict[str, pl.Series]:
    masks = {}
    for name, sources in SOURCE_DEPENDENCIES.items():
        observed = []
        for source in sources:
            if source in df.columns:
                observed.append(df[source].cast(pl.Float64, strict=False).is_finite().fill_null(False))
            else:
                raw = None if historical else meta.get("stock_vs_sector" if source == "sector_rs_ratio" else source, env.get(source))
                try:
                    import math
                    present = raw is not None and math.isfinite(float(raw))
                except (TypeError, ValueError):
                    present = False
                observed.append(pl.Series([present] * df.height))
        # Broker amount may be reconstructed from shares; DI requires both sides.
        valid = observed[0]
        for item in observed[1:]:
            valid = valid | item if name == "l1_brokerNetAmount5d" else valid & item
        masks[name] = ~valid
    return masks
