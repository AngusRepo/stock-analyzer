from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from services.external_evidence_contract import build_external_evidence_packet


SCHEMA_VERSION = "external-evidence-runtime-v1"

JsonFetcher = Callable[[str, dict[str, str] | None], Any]
TextFetcher = Callable[[str, dict[str, str] | None], str]


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def default_json_fetcher(url: str, headers: dict[str, str] | None = None) -> Any:
    request = Request(url, headers=headers or {"User-Agent": "StockVision/4.1"})
    with urlopen(request, timeout=20) as response:  # noqa: S310 - backend-only allowlisted market-data fetcher
        return json.loads(response.read().decode("utf-8"))


def default_text_fetcher(url: str, headers: dict[str, str] | None = None) -> str:
    request = Request(url, headers=headers or {"User-Agent": "StockVision/4.1"})
    with urlopen(request, timeout=20) as response:  # noqa: S310 - backend-only allowlisted evidence fetcher
        return response.read().decode("utf-8", errors="replace")


def fetch_finnhub_company_news(
    *,
    symbol: str,
    from_date: str,
    to_date: str,
    api_key: str,
    fetcher: JsonFetcher = default_json_fetcher,
) -> list[dict[str, Any]]:
    query = urlencode({"symbol": symbol, "from": from_date, "to": to_date, "token": api_key})
    url = f"https://finnhub.io/api/v1/company-news?{query}"
    payload = fetcher(url, {"User-Agent": "StockVision/4.1 FinnhubEvidence"})
    if not isinstance(payload, list):
        return []
    return payload


def fetch_gdelt_doc_events(
    *,
    query: str,
    start_datetime: str,
    end_datetime: str,
    max_records: int = 75,
    fetcher: JsonFetcher = default_json_fetcher,
) -> list[dict[str, Any]]:
    params = {
        "query": query,
        "mode": "artlist",
        "format": "json",
        "startdatetime": start_datetime,
        "enddatetime": end_datetime,
        "maxrecords": str(max_records),
        "sort": "hybridrel",
    }
    url = f"https://api.gdeltproject.org/api/v2/doc/doc?{urlencode(params)}"
    payload = fetcher(url, {"User-Agent": "StockVision/4.1 GDELTEvidence"})
    articles = payload.get("articles") if isinstance(payload, dict) else None
    return articles if isinstance(articles, list) else []


def fetch_rss_items(
    *,
    url: str,
    source_id: str,
    provider: str,
    domain_allowlist_match: bool = True,
    source_quality_score: float = 0.9,
    entity_linking_confidence: float = 0.75,
    fetcher: TextFetcher = default_text_fetcher,
) -> list[dict[str, Any]]:
    text = fetcher(url, {"User-Agent": "StockVision/4.1 OfficialEvidence"})
    root = ET.fromstring(text)
    items = root.findall(".//item")
    if not items:
        items = root.findall(".//{http://www.w3.org/2005/Atom}entry")
    rows: list[dict[str, Any]] = []
    for item in items:
        title = _xml_text(item, "title")
        link = _xml_text(item, "link")
        if not link:
            link_node = item.find("{http://www.w3.org/2005/Atom}link")
            link = link_node.attrib.get("href", "") if link_node is not None else ""
        published_at = _xml_text(item, "pubDate") or _xml_text(item, "published") or _xml_text(item, "updated")
        guid = _xml_text(item, "guid") or link
        rows.append({
            "source_id": source_id,
            "provider": provider,
            "title": title,
            "url": link,
            "published_at": published_at,
            "symbols": [],
            "themes": [],
            "language": "zh",
            "region": "tw",
            "source_quality_score": source_quality_score,
            "entity_linking_confidence": entity_linking_confidence,
            "spam_filter_status": "clean",
            "domain_allowlist_match": domain_allowlist_match,
            "raw": {"guid": guid, "feed_url": url},
        })
    return rows


def _xml_text(item: ET.Element, tag: str) -> str:
    node = item.find(tag)
    if node is None:
        node = item.find(f"{{http://www.w3.org/2005/Atom}}{tag}")
    return (node.text or "").strip() if node is not None else ""


def normalize_finnhub_news_item(
    raw: dict[str, Any],
    *,
    symbol: str,
    source_quality_score: float = 0.82,
    entity_linking_confidence: float = 0.9,
) -> dict[str, Any]:
    published = raw.get("datetime")
    if isinstance(published, (int, float)):
        published_at = datetime.fromtimestamp(published, tz=timezone.utc).isoformat()
    else:
        published_at = str(raw.get("published_at") or raw.get("date") or "")
    return {
        "source_id": "finnhub_news",
        "title": raw.get("headline") or raw.get("title") or "",
        "url": raw.get("url") or raw.get("source_url") or "",
        "published_at": published_at,
        "symbols": [symbol],
        "themes": raw.get("related") if isinstance(raw.get("related"), list) else [],
        "language": "en",
        "region": raw.get("category") or "global",
        "source_quality_score": source_quality_score,
        "entity_linking_confidence": entity_linking_confidence,
        "spam_filter_status": "clean",
        "raw": raw,
    }


def normalize_gdelt_article(
    raw: dict[str, Any],
    *,
    symbols: list[str] | None = None,
    themes: list[str] | None = None,
    source_quality_score: float = 0.55,
    entity_linking_confidence: float = 0.55,
) -> dict[str, Any]:
    return {
        "source_id": "gdelt_events",
        "title": raw.get("title") or "",
        "url": raw.get("url") or raw.get("source_url") or "",
        "published_at": raw.get("seendate") or raw.get("published_at") or "",
        "symbols": symbols or [],
        "themes": themes or raw.get("themes") or [],
        "language": raw.get("language"),
        "region": raw.get("sourcecountry") or raw.get("domain"),
        "tone": raw.get("tone"),
        "source_quality_score": source_quality_score,
        "entity_linking_confidence": entity_linking_confidence,
        "spam_filter_status": "clean",
        "raw": raw,
    }


def _source_weight(source_id: str) -> float:
    return {
        "official_rss": 1.2,
        "company_ir_rss": 1.1,
        "finnhub_news": 0.85,
        "gdelt_events": 0.35,
    }.get(source_id, 0.5)


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def build_theme_signals_from_external_packet(
    packet: dict[str, Any],
    *,
    generated_at: str | None = None,
) -> list[dict[str, Any]]:
    buckets: dict[tuple[str, str], dict[str, Any]] = {}
    for item in packet.get("items") or []:
        if not isinstance(item, dict):
            continue
        source_id = str(item.get("source_id") or "")
        features = item.get("features") if isinstance(item.get("features"), dict) else {}
        trace = item.get("trace") if isinstance(item.get("trace"), dict) else {}
        cleaning = item.get("cleaning") if isinstance(item.get("cleaning"), dict) else {}
        symbols = [str(symbol) for symbol in trace.get("symbols") or [] if str(symbol).strip()]
        concepts = [str(theme) for theme in features.get("themes") or [] if str(theme).strip()]
        if not concepts:
            concepts = symbols or [source_id]
        quality = _safe_float(cleaning.get("source_quality_score"), 0.0)
        confidence = _safe_float(cleaning.get("entity_linking_confidence"), 0.0)
        tone = _safe_float(features.get("tone"), 0.0)
        weighted_score = round(max(0.0, quality) * max(0.0, confidence) * _source_weight(source_id), 6)

        for concept in concepts:
            key = (source_id, concept)
            bucket = buckets.setdefault(
                key,
                {
                    "schema_version": SCHEMA_VERSION,
                    "date": str(item.get("published_at") or "")[:10],
                    "concept": concept,
                    "source": source_id,
                    "allowed_use": item.get("allowed_use"),
                    "decision_effect": item.get("decision_effect"),
                    "score": 0.0,
                    "evidence_count": 0,
                    "sentiment_sum": 0.0,
                    "symbols": set(),
                    "top_titles": [],
                    "generated_at": generated_at or utc_now(),
                },
            )
            bucket["score"] += weighted_score
            bucket["evidence_count"] += 1
            bucket["sentiment_sum"] += tone
            bucket["symbols"].update(symbols)
            if item.get("title") and len(bucket["top_titles"]) < 3:
                bucket["top_titles"].append(item.get("title"))

    signals: list[dict[str, Any]] = []
    for bucket in buckets.values():
        evidence_count = int(bucket["evidence_count"] or 1)
        signals.append(
            {
                **bucket,
                "score": round(float(bucket["score"]), 6),
                "sentiment_avg": round(float(bucket["sentiment_sum"]) / evidence_count, 6),
                "symbols": sorted(bucket["symbols"]),
            }
        )
    return sorted(signals, key=lambda item: (item["source"], -float(item["score"]), item["concept"]))


def merge_theme_signals(signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    source_breakdown: dict[str, defaultdict[str, float]] = defaultdict(lambda: defaultdict(float))
    for signal in signals:
        concept = str(signal.get("concept") or "").strip()
        if not concept:
            continue
        bucket = merged.setdefault(
            concept,
            {
                "schema_version": SCHEMA_VERSION,
                "concept": concept,
                "score": 0.0,
                "evidence_count": 0,
                "sentiment_sum": 0.0,
                "sources": set(),
                "symbols": set(),
                "top_titles": [],
            },
        )
        source = str(signal.get("source") or "unknown")
        score = _safe_float(signal.get("score"), 0.0)
        evidence_count = int(_safe_float(signal.get("evidence_count"), 0.0))
        bucket["score"] += score
        bucket["evidence_count"] += evidence_count
        bucket["sentiment_sum"] += _safe_float(signal.get("sentiment_avg"), 0.0) * max(1, evidence_count)
        bucket["sources"].add(source)
        bucket["symbols"].update(signal.get("symbols") or [])
        bucket["top_titles"].extend((signal.get("top_titles") or [])[:2])
        source_breakdown[concept][source] += score

    out: list[dict[str, Any]] = []
    for concept, bucket in merged.items():
        evidence_count = max(1, int(bucket["evidence_count"] or 0))
        out.append(
            {
                "schema_version": SCHEMA_VERSION,
                "concept": concept,
                "score": round(float(bucket["score"]), 6),
                "evidence_count": evidence_count,
                "sentiment_avg": round(float(bucket["sentiment_sum"]) / evidence_count, 6),
                "sources": sorted(bucket["sources"]),
                "source_breakdown": dict(sorted(source_breakdown[concept].items())),
                "symbols": sorted(bucket["symbols"]),
                "top_titles": bucket["top_titles"][:5],
            }
        )
    return sorted(out, key=lambda item: -float(item["score"]))


def theme_signal_d1_rows(signals: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for signal in signals:
        rows.append(
            {
                "date": signal.get("date") or str(signal.get("generated_at") or "")[:10],
                "concept": signal.get("concept"),
                "source": signal.get("source"),
                "score": signal.get("score"),
                "sentiment_avg": signal.get("sentiment_avg", 0),
                "evidence_count": signal.get("evidence_count", 1),
                "symbols_json": json.dumps(signal.get("symbols") or [], ensure_ascii=False, sort_keys=True),
                "top_titles": json.dumps(signal.get("top_titles") or [], ensure_ascii=False, sort_keys=True),
                "allowed_use": signal.get("allowed_use"),
                "decision_effect": signal.get("decision_effect"),
                "generated_at": signal.get("generated_at") or utc_now(),
            }
        )
    return rows


def external_evidence_item_d1_rows(packet: dict[str, Any]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    packet_checksum = packet.get("checksum") or packet.get("generated_at")
    for item in packet.get("items") or []:
        if not isinstance(item, dict):
            continue
        trace = item.get("trace") if isinstance(item.get("trace"), dict) else {}
        features = item.get("features") if isinstance(item.get("features"), dict) else {}
        cleaning = item.get("cleaning") if isinstance(item.get("cleaning"), dict) else {}
        rows.append(
            {
                "source_id": item.get("source_id"),
                "source_kind": item.get("source_kind"),
                "title": item.get("title"),
                "published_at": item.get("published_at"),
                "source_url": trace.get("source_url"),
                "symbols_json": json.dumps(trace.get("symbols") or [], ensure_ascii=False, sort_keys=True),
                "themes_json": json.dumps(features.get("themes") or [], ensure_ascii=False, sort_keys=True),
                "allowed_use": item.get("allowed_use"),
                "decision_effect": item.get("decision_effect"),
                "source_quality_score": cleaning.get("source_quality_score"),
                "entity_linking_confidence": cleaning.get("entity_linking_confidence"),
                "spam_filter_status": cleaning.get("spam_filter_status") or "clean",
                "accepted": 1,
                "packet_checksum": packet_checksum,
                "raw_json": json.dumps(item, ensure_ascii=False, sort_keys=True, default=str),
            }
        )
    for rejected in packet.get("rejected_items") or []:
        if not isinstance(rejected, dict):
            continue
        trace = rejected.get("trace") if isinstance(rejected.get("trace"), dict) else {}
        rows.append(
            {
                "source_id": rejected.get("source_id") or "unknown",
                "source_kind": "rejected",
                "title": rejected.get("title") or "",
                "published_at": packet.get("generated_at"),
                "source_url": trace.get("source_url") or "",
                "symbols_json": json.dumps(trace.get("symbols") or [], ensure_ascii=False, sort_keys=True),
                "themes_json": "[]",
                "allowed_use": "quarantine",
                "decision_effect": "none",
                "source_quality_score": 0,
                "entity_linking_confidence": 0,
                "spam_filter_status": "rejected",
                "accepted": 0,
                "packet_checksum": packet_checksum,
                "raw_json": json.dumps(rejected, ensure_ascii=False, sort_keys=True, default=str),
            }
        )
    return rows


def build_external_evidence_runtime_packet(
    *,
    finnhub_items: list[dict[str, Any]] | None = None,
    gdelt_items: list[dict[str, Any]] | None = None,
    official_items: list[dict[str, Any]] | None = None,
    company_ir_items: list[dict[str, Any]] | None = None,
    generated_at: str | None = None,
) -> dict[str, Any]:
    raw_items = []
    raw_items.extend(finnhub_items or [])
    raw_items.extend(gdelt_items or [])
    raw_items.extend(official_items or [])
    raw_items.extend(company_ir_items or [])
    packet = build_external_evidence_packet(raw_items, generated_at=generated_at or utc_now())
    signals = build_theme_signals_from_external_packet(packet, generated_at=generated_at)
    packet["runtime"] = {
        "schema_version": SCHEMA_VERSION,
        "theme_signals": signals,
        "merged_theme_signals": merge_theme_signals(signals),
    }
    return packet
