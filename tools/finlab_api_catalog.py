from __future__ import annotations

import json
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


ROOT = Path.cwd()
OUT_DIR = ROOT / "data" / "finlab_research"
FIELDS_JSON = OUT_DIR / "api_fields.json"
CATALOG_MD = ROOT / "FINLAB_DATA_CATALOG.md"

sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_adapter import (  # noqa: E402
    build_finlab_parallel_diff_plan,
    classify_finlab_field,
    split_finlab_field,
)


def markdown_table(rows: list[list[str]]) -> list[str]:
    if not rows:
        return []
    header = rows[0]
    lines = [
        "| " + " | ".join(header) + " |",
        "| " + " | ".join(["---"] * len(header)) + " |",
    ]
    for row in rows[1:]:
        safe = [str(cell).replace("|", "/").replace("\n", " ") for cell in row]
        lines.append("| " + " | ".join(safe) + " |")
    return lines


def summarize_df(df: Any, sample_symbols: list[str] | None = None) -> dict[str, Any]:
    info: dict[str, Any] = {
        "type": type(df).__name__,
        "shape": list(getattr(df, "shape", [])),
        "columns": [str(c) for c in list(getattr(df, "columns", []))[:30]],
        "index_name": str(getattr(getattr(df, "index", None), "name", None)),
    }
    try:
        info["last_index"] = str(df.index[-1])
    except Exception:
        pass

    samples: dict[str, Any] = {}
    for symbol in sample_symbols or []:
        try:
            rows = None
            if "stock_id" in getattr(df, "columns", []):
                rows = df[df["stock_id"].astype(str) == symbol].head(5)
            elif "symbol" in getattr(df, "columns", []):
                rows = df[df["symbol"].astype(str) == symbol].head(5)
            elif symbol in getattr(df, "columns", []):
                rows = df[[symbol]].dropna().tail(3)

            if rows is not None:
                samples[symbol] = json.loads(
                    rows.astype(str).to_json(orient="records", force_ascii=False)
                )
        except Exception as exc:
            samples[symbol] = {
                "error": f"{type(exc).__name__}: {str(exc)[:160]}",
            }
    if samples:
        info["samples"] = samples
    return info


def first_key(
    rows: list[dict[str, Any]],
    predicate: Callable[[dict[str, Any]], bool],
) -> str | None:
    for row in rows:
        if predicate(row):
            return str(row["api_key"])
    return None


def namespace_is(name: str) -> Callable[[dict[str, Any]], bool]:
    return lambda row: row["namespace"] == name


def namespace_starts(prefix: str) -> Callable[[dict[str, Any]], bool]:
    return lambda row: str(row["namespace"]).startswith(prefix)


def namespace_field(name: str, field: str) -> Callable[[dict[str, Any]], bool]:
    return lambda row: row["namespace"] == name and row["field"] == field


def main() -> None:
    import finlab
    from finlab import data, login

    api_key = os.environ.get("FINLAB_API_KEY")
    if not api_key:
        raise SystemExit("FINLAB_API_KEY is required")
    login(api_key)

    market_map = data.search.__globals__.get("_MARKET_TO_FIRESTORE_DOC", {})
    markets = [market for market in market_map if market != "us_fund"]
    rows: list[dict[str, Any]] = []
    field_metas = []
    seen: set[tuple[str, str, str]] = set()

    for market in markets:
        for item in data.search(market=market):
            namespace, field = split_finlab_field(str(item))
            key = (market, namespace, field)
            if key in seen:
                continue
            seen.add(key)
            meta = classify_finlab_field(market=market, namespace=namespace, field=field)
            field_metas.append(meta)
            rows.append(meta.to_dict())

    all_fields = list(data.search(market="all"))
    diff_plan = build_finlab_parallel_diff_plan(field_metas)

    sample_keys = [
        "security_categories",
        "security_industry_themes",
        first_key(rows, namespace_field("price", "收盤價")),
        first_key(rows, namespace_field("etl", "adj_close")),
        first_key(rows, namespace_field("rotc_price", "收盤價")),
        first_key(rows, namespace_field("monthly_revenue", "當月營收")),
        first_key(rows, namespace_field("rotc_monthly_revenue", "當月營收")),
        first_key(rows, namespace_starts("fundamental_features")),
        first_key(rows, namespace_starts("financial_statement")),
        first_key(rows, namespace_starts("institutional_investors_trading_summary")),
        first_key(rows, namespace_starts("margin_transactions")),
        first_key(rows, namespace_is("broker_transactions")),
        first_key(rows, namespace_is("rotc_broker_transactions")),
        first_key(rows, namespace_field("world_index", "close")),
        first_key(rows, namespace_field("us_price", "close")),
        first_key(rows, namespace_field("us_key_metrics", "market_cap")),
    ]
    sample_keys = list(dict.fromkeys(key for key in sample_keys if key))

    samples: dict[str, Any] = {}
    for key in sample_keys:
        try:
            samples[key] = summarize_df(data.get(key), ["7820", "6682"])
        except Exception as exc:
            samples[key] = {
                "error": f"{type(exc).__name__}: {str(exc)[:240]}",
            }

    by_market = Counter(row["market"] for row in rows)
    by_group = Counter(row["group"] for row in rows)
    by_priority = Counter(row["adoption_priority"] for row in rows)
    by_mode = Counter(row["adoption_mode"] for row in rows)
    by_lane = Counter(row["dataset_lane"] for row in rows)
    ns_by_market: dict[str, Counter[str]] = defaultdict(Counter)
    for row in rows:
        ns_by_market[row["market"]][row["namespace"]] += 1

    parity_by_lane = Counter(field.dataset_lane for field in diff_plan.parity_fields)
    diversity_by_lane = Counter(field.dataset_lane for field in diff_plan.diversity_fields)
    research_by_lane = Counter(field.dataset_lane for field in diff_plan.research_fields)
    parallel_diff_plan = {
        "parity_field_count": len(diff_plan.parity_fields),
        "diversity_field_count": len(diff_plan.diversity_fields),
        "research_field_count": len(diff_plan.research_fields),
        "rejected_field_count": len(diff_plan.rejected_fields),
        "parity_by_lane": dict(parity_by_lane),
        "diversity_by_lane": dict(diversity_by_lane),
        "research_by_lane": dict(research_by_lane),
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "finlab_sdk_version": getattr(finlab, "__version__", "unknown"),
        "auth_note": "FINLAB_API_KEY env token login used for read-only catalog generation; production adapter must migrate to FinLab's newer auth flow before promotion.",
        "markets": market_map,
        "all_market_search_count": len(all_fields),
        "field_count": len(rows),
        "counts": {
            "by_market": dict(by_market),
            "by_group": dict(by_group),
            "by_priority": dict(by_priority),
            "by_mode": dict(by_mode),
            "by_dataset_lane": dict(by_lane),
        },
        "parallel_diff_plan": parallel_diff_plan,
        "fields": rows,
        "sample_datasets": samples,
    }
    FIELDS_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    lines = []
    lines.append("# FinLab API Data Catalog for StockVision")
    lines.append("")
    lines.append(f"Generated: {payload['generated_at']}")
    lines.append(f"FinLab SDK: {payload['finlab_sdk_version']}")
    lines.append("")
    lines.append("## Scope")
    lines.append("")
    lines.append("- Source: FinLab SDK `data.search(...)` and selected read-only `data.get(...)` probes.")
    lines.append("- Purpose: list API-returned fields and evaluate StockVision replacement plus data-diversity value.")
    lines.append("- Secret handling: `FINLAB_API_KEY` was injected into env and was not printed.")
    lines.append("- Trading safety: no order API was called.")
    lines.append("- Auth note: token env login is kept for read-only catalog generation; production promotion must migrate to FinLab's newer auth flow.")
    lines.append("")
    lines.append("## Counts")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps({
        "data_search_all_count": len(all_fields),
        "catalog_rows": len(rows),
        "by_market": dict(by_market),
        "by_group": dict(by_group),
        "by_priority": dict(by_priority),
        "by_mode": dict(by_mode),
        "by_dataset_lane": dict(by_lane),
        "parallel_diff_plan": parallel_diff_plan,
    }, ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## V4 Data Diversity Decision")
    lines.append("")
    lines.append("FinLab adoption is not only a TWSE/TPEX replacement. V4 must split catalog usage into two live lanes:")
    lines.append("")
    lines.extend([
        "- `parity lane`: fields that replace or verify current TWSE/TPEX / StockVision equivalents.",
        "- `diversity lane`: FinLab-native fields that add coverage, factor breadth, taxonomy depth, or market context even when StockVision has no current field.",
    ])
    lines.append("")
    lines.append("The current 106-feature contract remains the downstream stable interface. New FinLab fields land in a feature-lake sidecar first, with provenance, freshness, schema, and promotion-gate metadata.")
    lines.append("")
    lines.append("### Parity Lane")
    lines.append("")
    parity_table = [["dataset_lane", "fields"]]
    for lane, count in parity_by_lane.most_common():
        parity_table.append([lane, str(count)])
    lines.extend(markdown_table(parity_table))
    lines.append("")
    lines.append("### Diversity Lane")
    lines.append("")
    diversity_table = [["dataset_lane", "fields", "StockVision use"]]
    lane_use = {
        "taxonomy_expansion": "industry_theme/subindustry labels, supply-chain grouping, cleaner sector flow",
        "chip_diversity": "three-party flow, margin/lending, broker concentration, theme rotation",
        "emerging_chip_diversity": "emerging-stock broker flow proxy, watchlist-only chip context",
        "emerging_price_diversity": "emerging-stock price, liquidity, quote-spread, watchlist context",
        "emerging_revenue_diversity": "emerging-stock revenue momentum and IPO/transfer watchlist context",
        "fundamental_factor_diversity": "quality, value, growth, profitability, leverage, cash-flow factor expansion",
        "global_context": "US leading, world index, morning setup, regime context",
        "regime_context": "derivatives, macro, hedge pressure, low-frequency context",
    }
    for lane, count in diversity_by_lane.most_common():
        diversity_table.append([lane, str(count), lane_use.get(lane, "shadow feature candidate")])
    lines.extend(markdown_table(diversity_table))
    lines.append("")
    lines.append("## Taxonomy Contract")
    lines.append("")
    lines.append("```text")
    lines.append("industry: FinLab security_categories.category")
    lines.append("industry_theme: parent theme parsed from FinLab security_industry_themes")
    lines.append("subindustry: cleaned child tag or standalone theme from FinLab security_industry_themes")
    lines.append("concept: StockVision self-built concept JSON and semantic theme signals")
    lines.append("```")
    lines.append("")
    lines.append("Institutional/theme flow must aggregate each layer separately. Do not sum all tags into one score, because multi-tag stocks would be double-counted.")
    lines.append("")
    lines.append("## Selected Read-Only Dataset Probes")
    lines.append("")
    lines.append("```json")
    lines.append(json.dumps(samples, ensure_ascii=False, indent=2))
    lines.append("```")
    lines.append("")
    lines.append("## Namespace Summary")
    lines.append("")
    for market in sorted(ns_by_market):
        lines.append(f"### {market}")
        lines.append("")
        table = [["namespace", "fields"]]
        for namespace, count in ns_by_market[market].most_common():
            table.append([namespace, str(count)])
        lines.extend(markdown_table(table))
        lines.append("")
    lines.append("## Full Field Catalog")
    lines.append("")
    lines.append(f"Machine-readable full catalog: `{FIELDS_JSON.relative_to(ROOT).as_posix()}`")
    lines.append("")
    table = [[
        "market",
        "namespace",
        "field",
        "group",
        "priority",
        "mode",
        "dataset lane",
        "quality gate",
        "replace TWSE/TPEX",
        "StockVision use",
    ]]
    for row in rows:
        table.append([
            row["market"],
            row["namespace"],
            row["field"],
            row["group"],
            row["adoption_priority"],
            row["adoption_mode"],
            row["dataset_lane"],
            row["quality_gate"],
            "yes" if row["replaces_twse_tpex_primary"] else "no",
            row["stockvision_use"],
        ])
    lines.extend(markdown_table(table))
    CATALOG_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(json.dumps({
        "catalog_md": str(CATALOG_MD),
        "fields_json": str(FIELDS_JSON),
        "data_search_all_count": len(all_fields),
        "catalog_rows": len(rows),
        "by_market": dict(by_market),
        "by_priority": dict(by_priority),
        "by_mode": dict(by_mode),
        "parallel_diff_plan": parallel_diff_plan,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
