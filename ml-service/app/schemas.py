from __future__ import annotations

from pydantic import BaseModel, Field


class NightSessionData(BaseModel):
    change_pct: float = 0
    range_pct: float = 0
    date: str = ""


class PredictRequest(BaseModel):
    stock_id: int
    symbol: str
    prices: list[dict]
    indicators: list[dict] = []
    chips: list[dict] = []
    sentiment_scores: list[dict] = []
    horizon: int = 14
    real_accuracies: dict[str, float] = {}
    market: str = "TW"
    market_env: dict | None = None
    model_stats: dict[str, dict] = {}
    adaptive_params: dict = {}
    trading_config: dict = {}
    barrier_params: dict = {}
    lifecycle_weights: dict[str, float] = {}
    weak_features: list[str] = []
    use_optuna: bool = False
    night_session: NightSessionData | None = None
    context: str = "scheduled_daily"
    runtime_options: dict = Field(default_factory=dict)
