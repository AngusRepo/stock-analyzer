"""FinLab read-only data adapter for StockVision V4.

This module is intentionally read-only. It wraps FinLab SDK dataset discovery
and normalization contracts without importing the SDK at module import time, so
unit tests and non-FinLab environments can still load the controller.
"""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from typing import Any, Iterable, Literal

from services.market_segment_policy import normalize_segment


FinLabAdoptionPriority = Literal["P0", "P1", "P2", "Reject"]
FinLabAdoptionMode = Literal["replace", "augment", "benchmark", "reject"]


@dataclass(frozen=True)
class FinLabAdoptionPlan:
    parity_fields: tuple["FinLabFieldMetadata", ...]
    diversity_fields: tuple["FinLabFieldMetadata", ...]
    research_fields: tuple["FinLabFieldMetadata", ...]
    rejected_fields: tuple["FinLabFieldMetadata", ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "parity_fields": [field.to_dict() for field in self.parity_fields],
            "diversity_fields": [field.to_dict() for field in self.diversity_fields],
            "research_fields": [field.to_dict() for field in self.research_fields],
            "rejected_fields": [field.to_dict() for field in self.rejected_fields],
        }


@dataclass(frozen=True)
class FinLabFieldMetadata:
    market: str
    namespace: str
    field: str
    api_key: str
    group: str
    stockvision_use: str
    adoption_priority: FinLabAdoptionPriority
    adoption_mode: FinLabAdoptionMode
    dataset_lane: str
    quality_gate: str
    replaces_twse_tpex_primary: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class NormalizedSecurity:
    symbol: str
    name: str
    category: str
    finlab_market: str
    market_segment: str
    stock_id: str
    source: str = "finlab:security_categories"

    @property
    def eligible_for_pending_buy(self) -> bool:
        return self.market_segment in {"LISTED", "OTC"}

    @property
    def recommendation_lane(self) -> str:
        if self.market_segment == "EMERGING":
            return "emerging_watchlist"
        if self.market_segment in {"LISTED", "OTC"}:
            return "tradable"
        return "research_only"

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["eligible_for_pending_buy"] = self.eligible_for_pending_buy
        payload["recommendation_lane"] = self.recommendation_lane
        return payload


@dataclass(frozen=True)
class NormalizedStockTag:
    symbol: str
    stock_id: str
    name: str
    tag_type: Literal["industry", "industry_theme", "subindustry"]
    tag: str
    source: str
    confidence: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def split_finlab_field(api_key: str) -> tuple[str, str]:
    if ":" not in api_key:
        return api_key, ""
    namespace, field = api_key.split(":", 1)
    return namespace, field


def normalize_finlab_market(market: Any) -> str:
    """Normalize FinLab raw market values into StockVision market segments."""
    return normalize_segment(market)


def classify_finlab_field(
    *,
    market: str,
    namespace: str,
    field: str = "",
) -> FinLabFieldMetadata:
    """Classify a FinLab field for V4 adoption and source replacement planning."""
    raw_key = f"{namespace}:{field}" if field else namespace
    lower_key = raw_key.lower()
    group = "other"
    use = "research reference"
    priority: FinLabAdoptionPriority = "P2"
    mode: FinLabAdoptionMode = "benchmark"
    dataset_lane = "research"
    quality_gate = "manual_review"
    replaces_twse_tpex = False

    if namespace == "security_categories":
        group = "security master / taxonomy"
        use = "primary market lane and formal industry normalization"
        priority = "P0"
        mode = "replace"
        dataset_lane = "security_master"
        quality_gate = "row_count, market_enum, known_symbol_checks"
        replaces_twse_tpex = True
    elif namespace == "security_industry_themes":
        group = "security master / taxonomy"
        use = "subindustry, supply-chain, and industry-theme expansion"
        priority = "P0"
        mode = "augment"
        dataset_lane = "taxonomy_expansion"
        quality_gate = "alias_cleaning, duplicate_tag_rate, coverage_by_symbol"
    elif "broker_transactions" in lower_key or namespace.endswith("broker_transactions"):
        group = "broker / branch flow"
        use = "broker concentration, branch flow anomaly, emerging-stock chip proxy"
        if namespace.startswith("rotc"):
            priority = "P0"
            dataset_lane = "emerging_chip_diversity"
            quality_gate = "emerging_symbol_coverage, branch_concentration_bounds"
        else:
            priority = "P1"
            dataset_lane = "chip_diversity"
            quality_gate = "turnover, crowding, price_location_gate"
        mode = "augment"
        replaces_twse_tpex = False
    elif namespace.startswith("futures") or "option" in lower_key or "taifex" in lower_key:
        group = "derivatives / positioning"
        use = "market regime, hedge pressure, risk dashboard"
        priority = "P1"
        mode = "augment"
        dataset_lane = "regime_context"
        quality_gate = "market_level_only, no_direct_alpha_gate"
    elif namespace.startswith("rotc_price"):
        group = "price / OHLCV"
        use = "emerging-stock price, liquidity, quote-spread, and watchlist context"
        priority = "P0"
        mode = "augment"
        dataset_lane = "emerging_price_diversity"
        quality_gate = "rotc_market_lane, liquidity_bounds, no_pending_buy"
    elif namespace.startswith(("price", "etl")):
        group = "price / OHLCV"
        use = "daily price, adjusted price, liquidity, backtest base panel"
        priority = "P0"
        mode = "replace"
        dataset_lane = "daily_price"
        quality_gate = "20_30_day_parity, split_adjustment, missing_rate"
        replaces_twse_tpex = market == "tw"
    elif namespace.startswith("rotc_monthly_revenue"):
        group = "monthly revenue"
        use = "emerging-stock revenue momentum and watchlist context"
        priority = "P0"
        mode = "augment"
        dataset_lane = "emerging_revenue_diversity"
        quality_gate = "publication_alignment, restatement_check, no_pending_buy"
    elif "monthly_revenue" in namespace:
        group = "monthly revenue"
        use = "revenue momentum, revenue-price double momentum, announcement freshness checks"
        priority = "P0"
        mode = "replace"
        dataset_lane = "revenue"
        quality_gate = "announcement_date_alignment, restatement_check"
        replaces_twse_tpex = market == "tw"
    elif namespace.startswith(("financial_statement", "fundamental_features")):
        group = "fundamentals"
        use = "quality, value, growth, profitability, balance-sheet factors"
        priority = "P0"
        mode = "augment"
        dataset_lane = "fundamental_factor_diversity"
        quality_gate = "report_date_availability, no_lookahead, sector_normalization"
        replaces_twse_tpex = market == "tw"
    elif (
        "institutional" in namespace
        or namespace.startswith("margin")
        or namespace.startswith("security_lending")
    ):
        group = "chips / institutional flow"
        use = "foreign/trust/dealer flow, margin heat, lending pressure, theme rotation"
        priority = "P0"
        mode = "augment"
        dataset_lane = "chip_diversity"
        quality_gate = "price_location, liquidity, crowding, extreme_value_winsorization"
        replaces_twse_tpex = market == "tw"
    elif namespace.startswith("tw_") or "business_indicator" in namespace or "pmi" in namespace:
        group = "taiwan macro"
        use = "regime and macro context"
        priority = "P1"
        mode = "augment"
        dataset_lane = "regime_context"
        quality_gate = "freshness, low_frequency_alignment"
    elif namespace.startswith("world_index"):
        group = "world market"
        use = "morning setup, cross-market context, regime evidence"
        priority = "P0"
        mode = "augment"
        dataset_lane = "global_context"
        quality_gate = "coverage, delay, holiday_calendar_alignment"
    elif namespace.startswith("us_"):
        group = "us market"
        use = "US leading / morning setup replacement candidate, global risk context"
        priority = "P1"
        mode = "augment"
        dataset_lane = "global_context"
        quality_gate = "coverage, delay, license, survivorship_check"
    elif market in {"hk", "jp", "kr", "uk"}:
        group = "non-US global market"
        use = "future global context, not V4 production core"
        priority = "P2"
        mode = "benchmark"
        dataset_lane = "research"
        quality_gate = "research_only"

    return FinLabFieldMetadata(
        market=market,
        namespace=namespace,
        field=field,
        api_key=raw_key,
        group=group,
        stockvision_use=use,
        adoption_priority=priority,
        adoption_mode=mode,
        dataset_lane=dataset_lane,
        quality_gate=quality_gate,
        replaces_twse_tpex_primary=replaces_twse_tpex,
    )


def build_finlab_parallel_diff_plan(
    fields: Iterable[FinLabFieldMetadata],
    *,
    existing_stockvision_api_keys: Iterable[str] | None = None,
) -> FinLabAdoptionPlan:
    """Split FinLab fields into parity, diversity, research, and reject lanes.

    Parity is for one-to-one replacement verification against TWSE/TPEX or
    existing StockVision fields. Diversity is deliberately broader: it includes
    FinLab-native fields that should be ingested in shadow mode even when there
    is no current StockVision equivalent.
    """
    existing_keys = set(existing_stockvision_api_keys or [])
    parity: list[FinLabFieldMetadata] = []
    diversity: list[FinLabFieldMetadata] = []
    research: list[FinLabFieldMetadata] = []
    rejected: list[FinLabFieldMetadata] = []

    for field in fields:
        if field.adoption_priority == "Reject" or field.adoption_mode == "reject":
            rejected.append(field)
            continue
        if field.replaces_twse_tpex_primary or field.api_key in existing_keys:
            parity.append(field)
        if field.adoption_mode == "augment" and field.adoption_priority in {"P0", "P1"}:
            diversity.append(field)
        if field.adoption_priority == "P2" or field.adoption_mode == "benchmark":
            research.append(field)

    return FinLabAdoptionPlan(
        parity_fields=tuple(parity),
        diversity_fields=tuple(diversity),
        research_fields=tuple(research),
        rejected_fields=tuple(rejected),
    )


def _clean_taxonomy_tag(value: Any) -> str:
    return str(value or "").replace("\u25ba", "").strip()


def _emit_tag(
    tags: dict[tuple[str, str, str, str], NormalizedStockTag],
    *,
    row: dict[str, Any],
    tag_type: Literal["industry", "industry_theme", "subindustry"],
    tag: str,
    source: str,
    confidence: float,
) -> None:
    clean_tag = _clean_taxonomy_tag(tag)
    symbol = str(row.get("symbol") or row.get("stock_id") or "").strip()
    if not symbol or not clean_tag:
        return
    stock_id = str(row.get("stock_id") or symbol).strip()
    key = (symbol, tag_type, clean_tag, source)
    tags[key] = NormalizedStockTag(
        symbol=symbol,
        stock_id=stock_id,
        name=str(row.get("name") or "").strip(),
        tag_type=tag_type,
        tag=clean_tag,
        source=source,
        confidence=confidence,
    )


def normalize_security_taxonomy(
    *,
    security_categories: Iterable[dict[str, Any]],
    security_industry_themes: Iterable[dict[str, Any]],
) -> list[NormalizedStockTag]:
    """Build FinLab taxonomy tags for formal industry and subindustry layers."""
    tags: dict[tuple[str, str, str, str], NormalizedStockTag] = {}

    for row in security_categories:
        _emit_tag(
            tags,
            row=row,
            tag_type="industry",
            tag=str(row.get("category") or ""),
            source="finlab:security_categories",
            confidence=1.0,
        )

    for row in security_industry_themes:
        raw_tag = _clean_taxonomy_tag(row.get("category"))
        if not raw_tag:
            continue
        parts = [part.strip() for part in raw_tag.split(":") if part.strip()]
        if len(parts) >= 2:
            _emit_tag(
                tags,
                row=row,
                tag_type="industry_theme",
                tag=parts[0],
                source="finlab:security_industry_themes",
                confidence=0.85,
            )
            _emit_tag(
                tags,
                row=row,
                tag_type="subindustry",
                tag=parts[-1],
                source="finlab:security_industry_themes",
                confidence=0.85,
            )
        else:
            _emit_tag(
                tags,
                row=row,
                tag_type="subindustry",
                tag=raw_tag,
                source="finlab:security_industry_themes",
                confidence=0.8,
            )

    return sorted(tags.values(), key=lambda item: (item.symbol, item.tag_type, item.tag))


def normalize_security_categories(rows: Iterable[dict[str, Any]]) -> list[NormalizedSecurity]:
    """Normalize rows returned by data.get("security_categories")."""
    securities: list[NormalizedSecurity] = []
    for row in rows:
        symbol = str(row.get("symbol") or row.get("stock_id") or "").strip()
        if not symbol:
            continue
        finlab_market = str(row.get("market") or "").strip()
        securities.append(
            NormalizedSecurity(
                symbol=symbol,
                name=str(row.get("name") or "").strip(),
                category=str(row.get("category") or "").strip(),
                finlab_market=finlab_market,
                market_segment=normalize_finlab_market(finlab_market),
                stock_id=str(row.get("stock_id") or symbol).strip(),
            )
        )
    return securities


class FinLabReadOnlyAdapter:
    """Lazy FinLab SDK wrapper.

    The SDK import and login happen only when a method needs remote data. This
    keeps non-FinLab tests hermetic and makes the production dependency
    boundary explicit.
    """

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key or os.environ.get("FINLAB_API_KEY")
        self._logged_in = False
        self._data_module: Any | None = None

    def _sdk_data(self) -> Any:
        if self._data_module is not None:
            return self._data_module
        if not self.api_key:
            raise RuntimeError("finlab_api_key_missing")
        try:
            import finlab
            from finlab import data, login
        except ImportError as exc:
            raise RuntimeError("finlab_sdk_not_installed") from exc

        # FinLab SDK 2.0.7 still supports token login but warns that passing an
        # api_token is deprecated after 2026-08-01. V4 production work must
        # migrate this wrapper to FinLab's new auth flow before promotion.
        if not self._logged_in:
            login(self.api_key)
            self._logged_in = True
        self._data_module = data
        _ = finlab
        return data

    def search_fields(self, *, market: str = "all") -> list[FinLabFieldMetadata]:
        data = self._sdk_data()
        fields: list[FinLabFieldMetadata] = []
        for api_key in data.search(market=market):
            namespace, field = split_finlab_field(api_key)
            fields.append(classify_finlab_field(market=market, namespace=namespace, field=field))
        return fields

    def catalog_fields(self, markets: Iterable[str] | None = None) -> list[FinLabFieldMetadata]:
        """Return field metadata while preserving each field's source market."""
        data = self._sdk_data()
        selected_markets = list(markets or ["tw", "us", "hk", "jp", "kr", "uk"])
        fields: list[FinLabFieldMetadata] = []
        seen: set[tuple[str, str]] = set()
        for market in selected_markets:
            for api_key in data.search(market=market):
                key = (market, api_key)
                if key in seen:
                    continue
                seen.add(key)
                namespace, field = split_finlab_field(api_key)
                fields.append(classify_finlab_field(market=market, namespace=namespace, field=field))
        return fields

    def get_dataset(self, api_key: str) -> Any:
        data = self._sdk_data()
        return data.get(api_key)

    def get_security_master(self) -> list[NormalizedSecurity]:
        df = self.get_dataset("security_categories")
        rows = df.to_dict(orient="records")
        return normalize_security_categories(rows)

    def get_security_taxonomy(self) -> list[NormalizedStockTag]:
        categories = self.get_dataset("security_categories")
        industry_themes = self.get_dataset("security_industry_themes")
        return normalize_security_taxonomy(
            security_categories=categories.to_dict(orient="records"),
            security_industry_themes=industry_themes.to_dict(orient="records"),
        )
