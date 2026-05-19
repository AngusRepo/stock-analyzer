from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from typing import Any, Iterable


FINLAB_EMERGING_WATCHLIST_SCHEMA_VERSION = "finlab-emerging-watchlist-manifest-v1"

SOURCE_CONTRACTS = [
    {
        "dataset_lane": "emerging_price_diversity",
        "source_dataset": "rotc_price",
        "usage": "liquidity_spread_context",
        "normalized_period_key": "trade_date",
        "raw_fields": [
            "成交股數",
            "成交金額",
            "開盤價",
            "收盤價",
            "最高價",
            "最低價",
            "日均價",
            "成交筆數",
            "最後揭示買價",
            "最後揭示賣價",
        ],
        "normalized_fields": [
            "volume",
            "turnover_value",
            "open",
            "close",
            "high",
            "low",
            "average_price",
            "trade_count",
            "best_bid",
            "best_ask",
            "spread_pct",
        ],
        "required_checks": [
            "rotc_market_lane",
            "liquidity_bounds",
            "no_pending_buy",
            "watchlist_only",
            "shadow_feature_only",
        ],
    },
    {
        "dataset_lane": "emerging_revenue_diversity",
        "source_dataset": "rotc_monthly_revenue",
        "usage": "revenue_momentum_context",
        "normalized_period_key": "revenue_month",
        "raw_fields": [
            "當月營收",
            "上月營收",
            "去年當月營收",
            "上月比較增減(%)",
            "去年同月增減(%)",
            "當月累計營收",
            "去年累計營收",
            "前期比較增減(%)",
            "備註",
        ],
        "normalized_fields": [
            "monthly_revenue",
            "previous_month_revenue",
            "last_year_same_month_revenue",
            "mom_pct",
            "yoy_pct",
            "ytd_revenue",
            "last_year_ytd_revenue",
            "ytd_yoy_pct",
            "note",
        ],
        "required_checks": [
            "publication_alignment",
            "restatement_check",
            "no_pending_buy",
            "watchlist_only",
            "shadow_feature_only",
        ],
    },
    {
        "dataset_lane": "emerging_chip_diversity",
        "source_dataset": "rotc_broker_transactions",
        "usage": "broker_concentration_context",
        "normalized_period_key": "trade_date",
        "raw_fields": ["rotc_broker_transactions"],
        "normalized_fields": [
            "top_branch_buy_ratio",
            "top_branch_sell_ratio",
            "top_branch_net_ratio",
            "broker_concentration_flag",
        ],
        "required_checks": [
            "branch_concentration_bounds",
            "emerging_symbol_coverage",
            "no_pending_buy",
            "watchlist_only",
            "shadow_feature_only",
        ],
    },
]


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_json(payload: Any) -> str:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def _as_text(value: Any) -> str:
    return str(value or "").strip()


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    text = str(value).strip().replace(",", "").replace("%", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _first_float(row: dict[str, Any] | None, keys: Iterable[str]) -> float | None:
    if not row:
        return None
    for key in keys:
        value = _as_float(row.get(key))
        if value is not None:
            return value
    return None


def _flatten_checks(family: dict[str, Any]) -> list[str]:
    checks: list[str] = []
    for key in ("all_checks", "row_level_checks", "metadata_only_checks", "quality_gates"):
        for value in family.get(key) or []:
            for item in str(value).split(","):
                text = item.strip()
                if text:
                    checks.append(text)
    return sorted(set(checks))


def _find_family(feature_lake_manifest: dict[str, Any], lane: str) -> dict[str, Any] | None:
    for family in feature_lake_manifest.get("sidecar_families") or []:
        if isinstance(family, dict) and family.get("dataset_lane") == lane:
            return family
    return None


def _source_contract(feature_lake_manifest: dict[str, Any], template: dict[str, Any]) -> dict[str, Any]:
    family = _find_family(feature_lake_manifest, str(template["dataset_lane"])) or {}
    checks = _flatten_checks(family)
    return {
        "source_dataset": template["source_dataset"],
        "dataset_lane": template["dataset_lane"],
        "source_family": family.get("asset_key"),
        "feature_namespace": family.get("feature_namespace"),
        "field_count": int(family.get("field_count") or 0),
        "usage": template["usage"],
        "normalized_period_key": template["normalized_period_key"],
        "join_keys": ["symbol", "date"],
        "raw_fields": list(template["raw_fields"]),
        "normalized_fields": list(template["normalized_fields"]),
        "required_checks": list(template["required_checks"]),
        "quality_checks": checks,
        "eligible_for_pending_buy": False,
        "eligible_for_execution": False,
        "eligible_for_production_ml_training": False,
        "watchlist_only": family.get("watchlist_only") is True,
    }


def build_finlab_emerging_watchlist_manifest(
    feature_lake_manifest: dict[str, Any],
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    source_contracts = [_source_contract(feature_lake_manifest, template) for template in SOURCE_CONTRACTS]
    manifest = {
        "schema_version": FINLAB_EMERGING_WATCHLIST_SCHEMA_VERSION,
        "generated_at": generated_at or _utc_now(),
        "source_feature_lake_checksum": feature_lake_manifest.get("checksum"),
        "policy": {
            "mode": "shadow_watchlist_only",
            "pending_buy_enabled": False,
            "execution_enabled": False,
            "production_ml_training_enabled": False,
            "production_screener_candidate_enabled": False,
            "allowed_outputs": ["watchlist", "manual_review", "context_only"],
            "blocked_outputs": ["pending_buy", "execution", "production_ml_training", "direct_alpha_gate"],
            "promotion_default": "no_direct_trading_or_ml_use",
        },
        "board_policy": {
            "finlab_raw_market": "rotc",
            "stockvision_market_segment": "EMERGING",
            "tradability": "watchlist_only_no_pending_buy",
            "security_master_dependency": "security_categories.market == rotc",
        },
        "source_contracts": source_contracts,
        "derived_context": [
            {
                "name": "liquidity_spread_context",
                "source_dataset": "rotc_price",
                "signals": ["turnover_value", "trade_count", "spread_pct"],
                "use": "pre-trade liquidity warning and manual review context",
            },
            {
                "name": "revenue_momentum_context",
                "source_dataset": "rotc_monthly_revenue",
                "signals": ["monthly_revenue", "mom_pct", "yoy_pct", "restatement_note"],
                "use": "fundamental watchlist context only",
            },
            {
                "name": "broker_concentration_context",
                "source_dataset": "rotc_broker_transactions",
                "signals": ["top_branch_buy_ratio", "top_branch_sell_ratio", "top_branch_net_ratio"],
                "use": "chip concentration warning, not a buy trigger",
            },
        ],
        "summary": {
            "source_count": len(source_contracts),
            "field_count_total": sum(int(source.get("field_count") or 0) for source in source_contracts),
            "watchlist_only_sources": sum(1 for source in source_contracts if source.get("watchlist_only") is True),
        },
    }
    manifest["checksum"] = _sha256_json({
        "schema_version": manifest["schema_version"],
        "source_feature_lake_checksum": manifest["source_feature_lake_checksum"],
        "policy": manifest["policy"],
        "board_policy": manifest["board_policy"],
        "source_contracts": manifest["source_contracts"],
        "derived_context": manifest["derived_context"],
    })
    return manifest


def validate_finlab_emerging_watchlist_manifest(manifest: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if manifest.get("schema_version") != FINLAB_EMERGING_WATCHLIST_SCHEMA_VERSION:
        errors.append("schema_version_invalid")
    if not manifest.get("checksum"):
        errors.append("checksum_missing")
    policy = manifest.get("policy") or {}
    for key in (
        "pending_buy_enabled",
        "execution_enabled",
        "production_ml_training_enabled",
        "production_screener_candidate_enabled",
    ):
        if policy.get(key) is not False:
            errors.append(key)
    if policy.get("mode") != "shadow_watchlist_only":
        errors.append("mode_not_shadow_watchlist_only")
    if manifest.get("board_policy", {}).get("finlab_raw_market") != "rotc":
        errors.append("finlab_raw_market_not_rotc")
    if manifest.get("board_policy", {}).get("stockvision_market_segment") != "EMERGING":
        errors.append("market_segment_not_emerging")

    source_contracts = manifest.get("source_contracts")
    if not isinstance(source_contracts, list) or not source_contracts:
        errors.append("source_contracts_missing")
        return sorted(set(errors))

    sources = {
        str(source.get("source_dataset")): source
        for source in source_contracts
        if isinstance(source, dict) and source.get("source_dataset")
    }
    for template in SOURCE_CONTRACTS:
        source_dataset = str(template["source_dataset"])
        source = sources.get(source_dataset)
        if source is None:
            errors.append(f"source_dataset_missing:{source_dataset}")
            continue
        if not source.get("source_family"):
            errors.append(f"source_family_missing:{source_dataset}")
        if source.get("watchlist_only") is not True:
            errors.append(f"watchlist_only_missing:{source_dataset}")
        for key in (
            "eligible_for_pending_buy",
            "eligible_for_execution",
            "eligible_for_production_ml_training",
        ):
            if source.get(key) is not False:
                errors.append(f"{key}_enabled:{source_dataset}")
        checks = set(source.get("quality_checks") or [])
        for check_name in template["required_checks"]:
            if check_name not in checks:
                errors.append(f"required_check_missing:{source_dataset}:{check_name}")
    return sorted(set(errors))


def summarize_emerging_watchlist_context(
    symbol: str,
    *,
    price_row: dict[str, Any] | None = None,
    revenue_row: dict[str, Any] | None = None,
    broker_row: dict[str, Any] | None = None,
) -> dict[str, Any]:
    close = _first_float(price_row, ("收盤價", "close", "last_price"))
    bid = _first_float(price_row, ("最後揭示買價", "best_bid", "bid"))
    ask = _first_float(price_row, ("最後揭示賣價", "best_ask", "ask"))
    spread_pct = None
    if close and bid is not None and ask is not None and ask >= bid:
        spread_pct = round(((ask - bid) / close) * 100, 2)

    return {
        "symbol": _as_text(symbol),
        "market_segment": "EMERGING",
        "allowed_decisions": ["watchlist", "manual_review", "context_only"],
        "blocked_decisions": ["pending_buy", "execution", "production_ml_training", "direct_alpha_gate"],
        "price": {
            "close": close,
            "best_bid": bid,
            "best_ask": ask,
            "spread_pct": spread_pct,
            "volume": _first_float(price_row, ("成交股數", "volume")),
            "turnover_value": _first_float(price_row, ("成交金額", "turnover_value")),
            "trade_count": _first_float(price_row, ("成交筆數", "trade_count")),
        },
        "revenue": {
            "monthly_revenue": _first_float(revenue_row, ("當月營收", "monthly_revenue")),
            "mom_pct": _first_float(revenue_row, ("上月比較增減(%)", "mom_pct")),
            "yoy_pct": _first_float(revenue_row, ("去年同月增減(%)", "yoy_pct")),
            "note": _as_text((revenue_row or {}).get("備註") or (revenue_row or {}).get("note")),
        },
        "broker_flow": {
            "top_branch_buy_ratio": _first_float(broker_row, ("top_branch_buy_ratio", "買超集中度")),
            "top_branch_sell_ratio": _first_float(broker_row, ("top_branch_sell_ratio", "賣超集中度")),
            "top_branch_net_ratio": _first_float(broker_row, ("top_branch_net_ratio", "淨買超集中度")),
        },
    }
