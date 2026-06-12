"""Active-9 dataset and model-pool policy.

The daily production path has one source of truth for lookback windows so
tree/tabular, graph, sequence, and foundation models do not silently drift back
to short legacy payloads.
"""

from __future__ import annotations

import os


ACTIVE_ALPHA_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
    "TimesFM",
)

RETIRED_ALPHA_MODELS = (
    "CatBoost",
    "FT-Transformer",
    "FTTransformer",
    "Chronos",
    "Chronos2ZeroShot",
    "Chronos2LoRA",
)


def _env_int(name: str, default: int, *, min_value: int, max_value: int) -> int:
    raw = os.environ.get(name)
    if raw is None or not str(raw).strip():
        return default
    value = int(str(raw).strip())
    return max(min_value, min(max_value, value))


def daily_price_lookback_years() -> int:
    """Tree/tabular rolling-feature source window."""

    return _env_int("STOCKVISION_DAILY_PRICE_LOOKBACK_YEARS", 5, min_value=3, max_value=6)


def daily_price_history_limit() -> int:
    """Per-symbol D1 payload cap for tabular and rolling features."""

    return _env_int("STOCKVISION_DAILY_PRICE_HISTORY_LIMIT", 1280, min_value=500, max_value=1600)


def daily_sequence_target_points() -> int:
    """Shared close-only history target for L3 sequence/foundation predictors."""

    return _env_int("STOCKVISION_DAILY_SEQUENCE_TARGET_POINTS", 1024, min_value=128, max_value=2048)


def gnn_return_history_lookback() -> int:
    """Correlation/allocator history target for graph/risk layers."""

    return _env_int("STOCKVISION_GNN_RETURN_HISTORY_LOOKBACK", 252, min_value=60, max_value=504)


def long_history_sequence_prefix() -> str:
    return (
        os.environ.get("STOCKVISION_SEQUENCE_LONG_GCS_PREFIX")
        or os.environ.get("FINLAB_LONG_SEQUENCE_OUTPUT_PREFIX")
        or "universal/sequence_long/latest"
    ).strip().rstrip("/")


def long_history_sequence_enabled() -> bool:
    raw = os.environ.get("STOCKVISION_LONG_HISTORY_SEQUENCE_ENABLED", "1")
    return str(raw).strip().lower() not in {"0", "false", "off", "disabled", "no"}

