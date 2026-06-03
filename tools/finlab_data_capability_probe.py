#!/usr/bin/env python
"""Probe FinLab catalog files for tick / price-level volume capability evidence.

This is a local evidence probe. It does not claim hidden paid API absence; it
reports what the checked FinLab catalog/API-field sources expose.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


CAPABILITIES = {
    "daily_ohlcv": {
        "positive": ["price:", "開盤", "最高", "最低", "收盤", "成交股數", "Trading_Volume"],
        "negative": [],
    },
    "intraday_aggregate": {
        "positive": ["intraday_trading", "intraday_trading_stat", "當日沖銷"],
        "negative": ["逐筆", "tick", "分價", "逐價"],
    },
    "intraday_odd_lot": {
        "positive": ["intraday_odd_lot_trade", "盤中零股", "最後揭示買價", "最後揭示賣價"],
        "negative": ["逐筆", "tick", "分價", "逐價"],
    },
    "broker_transactions": {
        "positive": ["broker_transactions", "rotc_broker_transactions", "分點", "券商"],
        "negative": [],
    },
    "tick_trade_history": {
        "positive": ["逐筆", "tick", "tick_trade", "ticks", "成交明細"],
        "negative": [],
    },
    "price_level_volume": {
        "positive": ["逐價", "分價", "price_level", "price-level", "volume_profile", "成交價量分布"],
        "negative": [],
    },
    "l5_order_book": {
        "positive": ["order_book", "order book", "L5", "五檔", "best_bid", "best_ask"],
        "negative": [],
    },
}


def read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="ignore")


def read_api_fields(path: Path) -> list[str]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8", errors="ignore"))
    except json.JSONDecodeError:
        return []
    out: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"api_key", "field", "table", "name"} and isinstance(child, str):
                    out.append(child)
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(raw)
    return out


def evidence_hits(haystack: str, keywords: list[str], limit: int) -> list[str]:
    lower = haystack.lower()
    hits: list[str] = []
    for keyword in keywords:
        key = keyword.lower()
        idx = lower.find(key)
        if idx < 0:
            continue
        start = max(0, idx - 80)
        end = min(len(haystack), idx + len(keyword) + 120)
        snippet = " ".join(haystack[start:end].split())
        hits.append(snippet)
        if len(hits) >= limit:
            break
    return hits


def probe(repo: Path, limit: int) -> dict[str, Any]:
    catalog_path = repo / "FINLAB_DATA_CATALOG.md"
    api_fields_path = repo / "data" / "finlab_research" / "api_fields.json"
    catalog = read_text(catalog_path)
    api_fields = "\n".join(read_api_fields(api_fields_path))
    combined = "\n".join([catalog, api_fields])
    capabilities: dict[str, Any] = {}
    for name, rule in CAPABILITIES.items():
        hits = evidence_hits(combined, rule["positive"], limit)
        capabilities[name] = {
            "local_catalog_status": "found" if hits else "not_found",
            "evidence": hits,
            "note": (
                "aggregate_or_context_data_not_tick_level"
                if name in {"intraday_aggregate", "intraday_odd_lot", "broker_transactions"}
                else "direct_capability_evidence" if hits else "no_local_catalog_evidence"
            ),
        }

    tick_found = capabilities["tick_trade_history"]["local_catalog_status"] == "found"
    price_level_found = capabilities["price_level_volume"]["local_catalog_status"] == "found"
    conclusion = {
        "tick_trade_history": "available_in_checked_sources" if tick_found else "not_found_in_checked_sources",
        "price_level_volume": "available_in_checked_sources" if price_level_found else "not_found_in_checked_sources",
        "production_policy": (
            "Do not label daily OHLCV proxy as true POC/fair value unless tick/price-level volume source is proven."
        ),
        "caveat": "This local probe does not prove hidden paid API absence; use live FinLab support/API confirmation for absolute proof.",
    }
    return {
        "version": "finlab_data_capability_probe_v1",
        "sources": {
            "catalog": str(catalog_path),
            "api_fields": str(api_fields_path),
            "catalog_exists": catalog_path.exists(),
            "api_fields_exists": api_fields_path.exists(),
        },
        "capabilities": capabilities,
        "conclusion": conclusion,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=".", help="Repository root")
    parser.add_argument("--limit", type=int, default=5, help="Evidence snippets per capability")
    args = parser.parse_args()
    report = probe(Path(args.repo).resolve(), max(1, args.limit))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
