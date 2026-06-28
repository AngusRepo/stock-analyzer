from __future__ import annotations

import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.external_evidence_runtime import (  # noqa: E402
    build_external_evidence_runtime_packet,
    external_evidence_item_d1_rows,
    fetch_gdelt_doc_events,
    normalize_gdelt_article,
    theme_signal_d1_rows,
)


ACCOUNT = os.environ["CF_ACCOUNT_ID"]
DB_ID = os.environ["CF_D1_DB_ID"]
CF_TOKEN = os.environ["CF_API_TOKEN"]
D1_ENDPOINT = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/d1/database/{DB_ID}/query"
TARGET_DATE = os.environ.get("TARGET_DATE", "").strip()
AS_OF_DATE = os.environ.get("AS_OF_DATE", "").strip()
GENERATED_AT = datetime.now(timezone.utc).isoformat()
SSL_CTX = ssl._create_unverified_context()
UA = "Mozilla/5.0 StockVision/4.1 ExternalEvidenceMaterializer"


def d1(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    req = urllib.request.Request(
        D1_ENDPOINT,
        data=json.dumps({"sql": sql, "params": params or []}).encode("utf-8"),
        headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"D1 HTTP {exc.code}: {detail[:1200]}") from exc
    if not body.get("success"):
        raise RuntimeError(json.dumps(body, ensure_ascii=False)[:1000])
    result = body.get("result") or []
    if not result:
        return []
    first = result[0]
    if not first.get("success", True):
        raise RuntimeError(json.dumps(first, ensure_ascii=False)[:1000])
    return first.get("results") or []


def resolve_run_dates() -> None:
    global TARGET_DATE, AS_OF_DATE
    if not TARGET_DATE:
        rows = d1(
            """
            SELECT MAX(date) AS date
            FROM daily_recommendations
            WHERE signal IS NOT NULL
              AND confidence IS NOT NULL
              AND score_components LIKE '%score_v2%'
            """
        )
        TARGET_DATE = str((rows[0] if rows else {}).get("date") or "").strip()
    if not TARGET_DATE:
        raise RuntimeError("TARGET_DATE not provided and no daily_recommendations date found")
    if not AS_OF_DATE:
        AS_OF_DATE = TARGET_DATE


def fetch_text(url: str, timeout: int = 20, limit: int = 1_500_000) -> tuple[str, str]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json,application/rss+xml,application/atom+xml,text/html,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
        raw = resp.read(limit)
        ctype = resp.headers.get("content-type") or ""
    return raw.decode("utf-8-sig", "replace"), ctype


def fetch_json(url: str) -> Any:
    return json.loads(fetch_text(url)[0])


def roc_to_iso(value: Any) -> str:
    s = str(value or "").strip()
    m = re.match(r"^(\d{3})[/-]?(\d{2})[/-]?(\d{2})", s)
    if not m:
        return AS_OF_DATE
    return f"{int(m.group(1)) + 1911:04d}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"


def clean_symbol(value: Any) -> str:
    m = re.search(r"\b(\d{4})\b", str(value or ""))
    return m.group(1) if m else ""


def source_url_for(base: str, symbol: str) -> str:
    return f"{base}#stockNo={urllib.parse.quote(symbol)}" if symbol else base


def normalize_base_url(url: str) -> str:
    value = str(url or "").strip().strip("\u3000")
    if not value:
        return ""
    if not re.match(r"^https?://", value, re.I):
        value = "https://" + value
    parsed = urllib.parse.urlparse(value)
    if not parsed.netloc:
        return ""
    return urllib.parse.urlunparse((parsed.scheme or "https", parsed.netloc, parsed.path or "/", "", "", ""))


def host(url: str) -> str:
    return urllib.parse.urlparse(url).netloc.lower().lstrip("www.")


def same_domain(url: str, base: str) -> bool:
    h = host(url)
    b = host(base)
    return bool(h and b and (h == b or h.endswith("." + b) or b.endswith("." + h)))


def parse_feed_items(feed_url: str, text: str, base_url: str, symbol: str, name: str) -> list[dict[str, Any]]:
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    items = root.findall(".//item") or root.findall(".//{http://www.w3.org/2005/Atom}entry")
    out: list[dict[str, Any]] = []
    for item in items[:2]:
        def xtag(tag: str) -> str:
            node = item.find(tag) or item.find(f"{{http://www.w3.org/2005/Atom}}{tag}")
            return (node.text or "").strip() if node is not None else ""

        title = xtag("title")
        link = xtag("link")
        if not link:
            link_node = item.find("{http://www.w3.org/2005/Atom}link")
            link = link_node.attrib.get("href", "") if link_node is not None else ""
        link = urllib.parse.urljoin(feed_url, link or feed_url)
        if not title or not same_domain(link, base_url):
            continue
        published = xtag("pubDate") or xtag("published") or xtag("updated") or AS_OF_DATE
        out.append(
            {
                "source_id": "company_ir_rss",
                "provider": name,
                "title": f"{symbol} {name}: {title}"[:240],
                "url": link,
                "published_at": published,
                "symbols": [symbol],
                "themes": ["company_ir_update"],
                "language": "zh",
                "region": "tw",
                "source_quality_score": 0.88,
                "entity_linking_confidence": 0.82,
                "spam_filter_status": "clean",
                "domain_allowlist_match": True,
                "raw": {"feed_url": feed_url, "company_url": base_url},
            }
        )
    return out


def tags_query(symbols: list[str]) -> dict[str, list[str]]:
    if not symbols:
        return {}
    placeholders = ",".join(["?"] * len(symbols))
    rows = []
    rows.extend(
        d1(
            f"SELECT symbol, tag, tag_type, weight FROM finlab_taxonomy_tags WHERE symbol IN ({placeholders})",
            symbols,
        )
    )
    rows.extend(
        d1(
            f"SELECT symbol, tag, tag_type, weight FROM stock_tags WHERE symbol IN ({placeholders})",
            symbols,
        )
    )
    out: dict[str, list[str]] = defaultdict(list)
    seen: set[tuple[str, str]] = set()
    for row in rows:
        symbol = str(row.get("symbol") or "")
        tag = str(row.get("tag") or "").strip()
        key = (symbol, tag)
        if symbol and tag and key not in seen:
            seen.add(key)
            out[symbol].append(tag)
    return out


def finlab_taxonomy_tags_query(symbols: list[str]) -> dict[str, list[dict[str, Any]]]:
    if not symbols:
        return {}
    placeholders = ",".join(["?"] * len(symbols))
    rows = d1(
        f"""
        SELECT symbol, tag, tag_type, weight
          FROM finlab_taxonomy_tags
         WHERE symbol IN ({placeholders})
           AND tag_type IN ('industry', 'industry_theme', 'subindustry', 'concept')
        """,
        symbols,
    )
    out: dict[str, list[dict[str, Any]]] = defaultdict(list)
    seen: set[tuple[str, str, str]] = set()
    for row in rows:
        symbol = str(row.get("symbol") or "").strip()
        tag = str(row.get("tag") or "").strip()
        tag_type = str(row.get("tag_type") or "tag").strip()
        if not symbol or not tag:
            continue
        key = (symbol, tag, tag_type)
        if key in seen:
            continue
        seen.add(key)
        try:
            weight = float(row.get("weight") or 1)
        except (TypeError, ValueError):
            weight = 1.0
        out[symbol].append({"tag": tag, "tag_type": tag_type, "weight": weight})
    return out


def build_finlab_taxonomy_theme_rows(
    tags_by_symbol: dict[str, list[dict[str, Any]]],
    *,
    date: str,
    generated_at: str,
) -> list[dict[str, Any]]:
    buckets: dict[str, dict[str, Any]] = {}
    for symbol, tags in tags_by_symbol.items():
        for tag in tags:
            concept = str(tag.get("tag") or "").strip()
            if not concept:
                continue
            bucket = buckets.setdefault(
                concept,
                {"symbols": set(), "tag_types": set(), "score_sum": 0.0},
            )
            bucket["symbols"].add(symbol)
            bucket["tag_types"].add(str(tag.get("tag_type") or "tag"))
            try:
                bucket["score_sum"] += max(0.0, float(tag.get("weight") or 1))
            except (TypeError, ValueError):
                bucket["score_sum"] += 1.0

    rows: list[dict[str, Any]] = []
    for concept, bucket in buckets.items():
        symbols = sorted(bucket["symbols"])
        tag_types = sorted(bucket["tag_types"])
        if not symbols:
            continue
        rows.append(
            {
                "date": date,
                "concept": concept,
                "source": "finlab_taxonomy",
                "score": round(float(bucket["score_sum"]) / max(1, len(symbols)), 6),
                "sentiment_avg": 0,
                "evidence_count": len(symbols),
                "symbols_json": json.dumps(symbols, ensure_ascii=False, sort_keys=True),
                "top_titles": json.dumps(
                    [f"finlab_taxonomy:{','.join(tag_types) or 'tag'}:{len(symbols)} symbols"],
                    ensure_ascii=False,
                ),
                "allowed_use": "taxonomy_context",
                "decision_effect": "context_only",
                "generated_at": generated_at,
            }
        )
    return sorted(rows, key=lambda row: (-int(row["evidence_count"]), str(row["concept"])))


def build_official_items(tags_by_symbol: dict[str, list[str]]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    endpoints = [
        ("TWSE", "https://www.twse.com.tw/rwd/zh/announcement/punish?response=json", "twse_disposition"),
        ("TWSE", "https://www.twse.com.tw/rwd/zh/announcement/notice?response=json", "twse_attention"),
    ]
    for provider, url, theme in endpoints:
        try:
            payload = fetch_json(url)
            data = payload.get("data") if isinstance(payload, dict) else []
            if not isinstance(data, list):
                continue
            for row in data:
                if not isinstance(row, list):
                    continue
                symbol = ""
                for value in row:
                    symbol = clean_symbol(value)
                    if symbol:
                        break
                if not symbol:
                    continue
                name = str(row[3] if len(row) > 3 else "").strip()
                pub = roc_to_iso(row[1] if len(row) > 1 else AS_OF_DATE)
                detail = str(row[7] if len(row) > 7 else row[5] if len(row) > 5 else "").strip()
                period = str(row[6] if len(row) > 6 else "").strip()
                items.append(
                    {
                        "source_id": "official_rss",
                        "provider": provider,
                        "title": f"{provider} official {theme}: {symbol} {name} {detail} {period}"[:240],
                        "url": source_url_for(url, symbol),
                        "published_at": pub,
                        "symbols": [symbol],
                        "themes": [theme, *tags_by_symbol.get(symbol, [])[:3]],
                        "language": "zh",
                        "region": "tw",
                        "source_quality_score": 0.95,
                        "entity_linking_confidence": 0.96,
                        "spam_filter_status": "clean",
                        "domain_allowlist_match": True,
                        "raw": {"endpoint": url, "row": row},
                    }
                )
        except Exception as exc:
            print(f"official_fetch_failed {provider} {theme}: {exc}")
    return items


def gdelt_timestamp(day: str, *, end_of_day: bool = False) -> str:
    try:
        parsed = datetime.fromisoformat(day[:10])
    except ValueError:
        parsed = datetime.now(timezone.utc)
    if end_of_day:
        parsed = parsed.replace(hour=23, minute=59, second=59)
    else:
        parsed = parsed.replace(hour=0, minute=0, second=0)
    return parsed.strftime("%Y%m%d%H%M%S")


def gdelt_start_timestamp(day: str, lookback_days: int = 10) -> str:
    try:
        parsed = datetime.fromisoformat(day[:10])
    except ValueError:
        parsed = datetime.now(timezone.utc)
    parsed = (parsed - timedelta(days=lookback_days)).replace(hour=0, minute=0, second=0)
    return parsed.strftime("%Y%m%d%H%M%S")


def build_gdelt_items(
    recommendations: list[dict[str, Any]],
    tags_by_symbol: dict[str, list[str]],
    *,
    max_symbols: int = 6,
    max_total_items: int = 48,
) -> tuple[list[dict[str, Any]], str]:
    if os.environ.get("GDELT_FORMAL_SHADOW_ENABLED", "1").lower() in {"0", "false", "no"}:
        return [], "disabled"

    max_symbols = max(0, int(os.environ.get("GDELT_MAX_SYMBOLS", str(max_symbols))))
    max_total_items = max(1, int(os.environ.get("GDELT_MAX_TOTAL_ITEMS", str(max_total_items))))
    timeout_seconds = max(2, int(os.environ.get("GDELT_FETCH_TIMEOUT_SECONDS", "12")))
    if max_symbols <= 0:
        return [], "disabled_max_symbols_0"

    def bounded_fetcher(url: str, headers: dict[str, str] | None = None) -> Any:
        req = urllib.request.Request(url, headers=headers or {"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout_seconds, context=SSL_CTX) as resp:
            return json.loads(resp.read(1_000_000).decode("utf-8", "replace"))

    start = gdelt_start_timestamp(AS_OF_DATE)
    end = gdelt_timestamp(AS_OF_DATE, end_of_day=True)
    items: list[dict[str, Any]] = []
    seen_urls: set[str] = set()
    failures = 0

    def append_articles(
        *,
        query: str,
        symbols: list[str],
        themes: list[str],
        source_quality_score: float,
        entity_linking_confidence: float,
    ) -> None:
        nonlocal failures
        try:
            articles = fetch_gdelt_doc_events(
                query=query,
                start_datetime=start,
                end_datetime=end,
                max_records=3,
                fetcher=bounded_fetcher,
            )
        except Exception:
            failures += 1
            return
        for article in articles:
            url = str(article.get("url") or article.get("source_url") or "").strip()
            if not url or url in seen_urls:
                continue
            seen_urls.add(url)
            item = normalize_gdelt_article(
                {**article, "stockvision_query": query},
                symbols=symbols,
                themes=themes,
                source_quality_score=source_quality_score,
                entity_linking_confidence=entity_linking_confidence,
            )
            item["source_kind"] = "gdelt_doc_article"
            item["allowed_use"] = "formal_shadow"
            item["decision_effect"] = "risk_context_only"
            items.append(item)

    for row in recommendations[:max_symbols]:
        symbol = str(row.get("symbol") or "").strip()
        name = str(row.get("name") or "").strip()
        if not symbol or not name:
            continue
        query = f'"{name}"'
        themes = ["global_event_pressure", *tags_by_symbol.get(symbol, [])[:3]]
        append_articles(
            query=query,
            symbols=[symbol],
            themes=themes,
            source_quality_score=0.52,
            entity_linking_confidence=0.48,
        )
        if len(items) >= max_total_items:
            return items, "ok"

    if items:
        return items, "ok"

    fallback_queries = [
        '"Taiwan stock market" OR TAIEX',
        '"Taiwan semiconductor" OR TSMC OR "AI chip"',
        '"global market risk" OR "US dollar" OR VIX',
    ]
    for query in fallback_queries:
        append_articles(
            query=query,
            symbols=[],
            themes=["global_event_pressure", "market_risk_context"],
            source_quality_score=0.46,
            entity_linking_confidence=0.35,
        )
        if len(items) >= max_total_items:
            return items[:max_total_items], "ok"
    if items:
        return items[:max_total_items], "ok"
    return [], "fetch_failed" if failures else "no_rows"


def build_gdelt_context_status_item(status: str) -> dict[str, Any]:
    """Keep GDELT formal-shadow visible even when the live fetch has no rows."""
    return {
        "source_id": "gdelt_events",
        "source_kind": "global_event_graph_status",
        "title": f"GDELT formal shadow status: {status}",
        "url": "https://api.gdeltproject.org/api/v2/doc/doc",
        "published_at": AS_OF_DATE,
        "symbols": [],
        "themes": ["global_event_pressure"],
        "language": "multi",
        "region": "global",
        "tone": 0,
        "source_quality_score": 0.05,
        "entity_linking_confidence": 0.05,
        "spam_filter_status": "clean",
        "domain_allowlist_match": True,
        "raw": {
            "status": status,
            "formal_shadow": True,
            "decision_effect": "risk_context_only",
            "generated_at": GENERATED_AT,
        },
    }


def load_company_ir_allowlist(
    tags_by_symbol: dict[str, list[str]],
    target_symbols: set[str],
) -> tuple[list[dict[str, Any]], str]:
    """Load first-party IR feeds only from an explicit curated allowlist.

    The previous automatic company-site feed guessing produced stale 2021 rows.
    Keeping this allowlist-only prevents noisy first-party evidence from entering
    production theme features.
    """
    allowlist_path = os.environ.get("COMPANY_IR_ALLOWLIST_JSON")
    if not allowlist_path:
        return [], "disabled_pending_allowlist"
    path = Path(allowlist_path)
    if not path.exists():
        return [], "allowlist_file_missing"
    payload = json.loads(path.read_text(encoding="utf-8-sig"))
    entries = payload.get("feeds") if isinstance(payload, dict) else payload
    if not isinstance(entries, list):
        return [], "allowlist_invalid"

    items: list[dict[str, Any]] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        symbol = str(entry.get("symbol") or "").strip()
        feed_url = str(entry.get("feed_url") or "").strip()
        if not symbol or symbol not in target_symbols or not feed_url:
            continue
        base_url = normalize_base_url(str(entry.get("base_url") or feed_url))
        if not same_domain(feed_url, base_url):
            continue
        try:
            text, _ = fetch_text(feed_url, timeout=8, limit=500_000)
            rows = parse_feed_items(feed_url, text, base_url, symbol, str(entry.get("name") or symbol))
            for row in rows:
                row["themes"] = ["company_ir_update", *tags_by_symbol.get(symbol, [])[:3]]
            items.extend(rows)
        except Exception:
            continue
    return items, "ok" if items else "no_rows_from_allowlist"


def build_stock_features(
    theme_rows: list[dict[str, Any]],
    tags_by_symbol: dict[str, list[str]],
    target_symbols: set[str],
) -> list[dict[str, Any]]:
    tag_to_symbols: dict[str, set[str]] = defaultdict(set)
    for symbol, tags in tags_by_symbol.items():
        if symbol in target_symbols:
            for tag in tags:
                tag_to_symbols[tag].add(symbol)
    for row in theme_rows:
        concept = str(row.get("concept") or "")
        try:
            symbols = json.loads(row.get("symbols_json") or "[]")
        except Exception:
            symbols = []
        for symbol in symbols:
            if symbol in target_symbols:
                tag_to_symbols[concept].add(symbol)

    features: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in theme_rows:
        concept = str(row.get("concept") or "").strip()
        for symbol in tag_to_symbols.get(concept, set()):
            key = (str(row["date"]), symbol, concept)
            source = str(row.get("source") or "unknown")
            contribution = float(row.get("score") or 0)
            titles = json.loads(row.get("top_titles") or "[]")
            if key in features:
                existing = features[key]
                breakdown = json.loads(existing["source_breakdown_json"])
                breakdown[source] = round(float(breakdown.get(source, 0)) + contribution, 6)
                existing["score"] = round(float(existing["score"]) + contribution, 6)
                existing["evidence_count"] = int(existing["evidence_count"]) + int(row.get("evidence_count") or 1)
                existing["source_breakdown_json"] = json.dumps(breakdown, ensure_ascii=False, sort_keys=True)
                existing["top_titles"] = json.dumps((json.loads(existing["top_titles"]) + titles)[:5], ensure_ascii=False)
            else:
                features[key] = {
                    "date": row["date"],
                    "symbol": symbol,
                    "concept": concept,
                    "score": round(contribution, 6),
                    "evidence_count": int(row.get("evidence_count") or 1),
                    "source_breakdown_json": json.dumps({source: contribution}, ensure_ascii=False, sort_keys=True),
                    "top_titles": json.dumps(titles[:5], ensure_ascii=False),
                    "generated_at": row["generated_at"],
                }
    return list(features.values())


def upsert_external(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        d1(
            """
            INSERT INTO external_evidence_items (
              source_id, source_kind, title, published_at, source_url, symbols_json, themes_json,
              allowed_use, decision_effect, source_quality_score, entity_linking_confidence,
              spam_filter_status, accepted, packet_checksum, raw_json
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM external_evidence_items
              WHERE source_id = ? AND source_url = ? AND published_at = ?
              LIMIT 1
            )
            """,
            [
                row.get("source_id"),
                row.get("source_kind"),
                row.get("title"),
                row.get("published_at"),
                row.get("source_url"),
                row.get("symbols_json"),
                row.get("themes_json"),
                row.get("allowed_use"),
                row.get("decision_effect"),
                row.get("source_quality_score"),
                row.get("entity_linking_confidence"),
                row.get("spam_filter_status"),
                row.get("accepted"),
                row.get("packet_checksum"),
                row.get("raw_json"),
                row.get("source_id"),
                row.get("source_url"),
                row.get("published_at"),
            ],
        )


def upsert_theme(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        d1(
            """
            INSERT INTO theme_signals (
              date, concept, source, score, sentiment_avg, evidence_count, symbols_json,
              top_titles, allowed_use, decision_effect, generated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, concept, source) DO UPDATE SET
              score=excluded.score,
              sentiment_avg=excluded.sentiment_avg,
              evidence_count=excluded.evidence_count,
              symbols_json=excluded.symbols_json,
              top_titles=excluded.top_titles,
              allowed_use=excluded.allowed_use,
              decision_effect=excluded.decision_effect,
              generated_at=excluded.generated_at
            """,
            [
                row.get("date"),
                row.get("concept"),
                row.get("source"),
                row.get("score"),
                row.get("sentiment_avg"),
                row.get("evidence_count"),
                row.get("symbols_json"),
                row.get("top_titles"),
                row.get("allowed_use"),
                row.get("decision_effect"),
                row.get("generated_at"),
            ],
        )


def upsert_features(rows: list[dict[str, Any]]) -> None:
    for row in rows:
        d1(
            """
            INSERT INTO stock_theme_features (
              date, symbol, concept, score, evidence_count, source_breakdown_json,
              top_titles, generated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(date, symbol, concept) DO UPDATE SET
              score=excluded.score,
              evidence_count=excluded.evidence_count,
              source_breakdown_json=excluded.source_breakdown_json,
              top_titles=excluded.top_titles,
              generated_at=excluded.generated_at
            """,
            [
                row.get("date"),
                row.get("symbol"),
                row.get("concept"),
                row.get("score"),
                row.get("evidence_count"),
                row.get("source_breakdown_json"),
                row.get("top_titles"),
                row.get("generated_at"),
            ],
        )


def upsert_quality(
    source: str,
    dataset: str,
    rows: int,
    latest: str | None,
    confidence: float | None,
    root_cause: str = "ok",
) -> None:
    freshness_status = "present" if rows > 0 else "missing"
    missing_rate = 0 if rows > 0 else 1
    if source == "company_ir_rss" and root_cause == "disabled_pending_allowlist":
        freshness_status = "disabled_pending_allowlist"
    if source == "gdelt_events" and root_cause != "ok" and rows > 0:
        freshness_status = "degraded_context_only"
        missing_rate = 0.5
    if rows > 0 and latest:
        parsed_date = str(latest)[:10]
        if re.match(r"^\d{4}-\d{2}-\d{2}$", parsed_date) and parsed_date < "2026-04-18":
            freshness_status = "stale"
    d1(
        """
        INSERT INTO source_quality_metrics (
          source, dataset, as_of_date, freshness_status, missing_rate, duplicate_rate,
          schema_drift_status, entity_link_confidence, latest_materialization, metrics_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, dataset, as_of_date) DO UPDATE SET
          freshness_status=excluded.freshness_status,
          missing_rate=excluded.missing_rate,
          duplicate_rate=excluded.duplicate_rate,
          schema_drift_status=excluded.schema_drift_status,
          entity_link_confidence=excluded.entity_link_confidence,
          latest_materialization=excluded.latest_materialization,
          metrics_json=excluded.metrics_json
        """,
        [
            source,
            dataset,
            AS_OF_DATE,
            freshness_status,
            missing_rate,
            0,
            "ok",
            confidence,
            latest or GENERATED_AT,
            json.dumps({"rows": rows, "root_cause": root_cause, "generated_at": GENERATED_AT}, ensure_ascii=False, sort_keys=True),
        ],
    )


def main() -> None:
    d1("SELECT 1 AS ok")
    resolve_run_dates()
    recommendations = d1(
        "SELECT symbol, name, market_segment, score FROM daily_recommendations WHERE date=? ORDER BY rank ASC LIMIT 80",
        [TARGET_DATE],
    )
    symbols = [str(row.get("symbol")) for row in recommendations if row.get("symbol")]
    target_symbols = set(symbols)
    tags_by_symbol = tags_query(symbols)
    finlab_tags_by_symbol = finlab_taxonomy_tags_query(symbols)

    official_items = build_official_items(tags_by_symbol)

    company_ir_items, company_ir_status = load_company_ir_allowlist(tags_by_symbol, target_symbols)
    gdelt_items, gdelt_status = build_gdelt_items(recommendations, tags_by_symbol)
    if not gdelt_items and gdelt_status not in {"disabled", "disabled_max_symbols_0"}:
        gdelt_items = [build_gdelt_context_status_item(gdelt_status)]

    packet = build_external_evidence_runtime_packet(
        gdelt_items=gdelt_items,
        official_items=official_items,
        company_ir_items=company_ir_items,
        generated_at=GENERATED_AT,
    )
    evidence_rows = external_evidence_item_d1_rows(packet)
    external_theme_rows = theme_signal_d1_rows(packet["runtime"]["theme_signals"])
    taxonomy_theme_rows = build_finlab_taxonomy_theme_rows(
        finlab_tags_by_symbol,
        date=TARGET_DATE,
        generated_at=GENERATED_AT,
    )
    theme_rows = [*external_theme_rows, *taxonomy_theme_rows]
    feature_rows = build_stock_features(theme_rows, tags_by_symbol, target_symbols)

    upsert_external(evidence_rows)
    upsert_theme(theme_rows)
    upsert_features(feature_rows)

    by_source: dict[str, int] = defaultdict(int)
    latest_by_source: dict[str, str] = {}
    confidence_by_source: dict[str, list[float]] = defaultdict(list)
    for row in evidence_rows:
        source = str(row.get("source_id") or "unknown")
        if int(row.get("accepted") or 0) != 1:
            continue
        by_source[source] += 1
        published_at = str(row.get("published_at") or "")
        if published_at and published_at > latest_by_source.get(source, ""):
            latest_by_source[source] = published_at
        try:
            confidence_by_source[source].append(float(row.get("entity_linking_confidence") or 0))
        except Exception:
            pass

    for source, dataset in [
        ("official_rss", "official_event_evidence"),
        ("company_ir_rss", "company_first_party_feed"),
        ("gdelt_events", "global_event_pressure"),
    ]:
        confidences = confidence_by_source.get(source) or []
        avg_confidence = round(sum(confidences) / len(confidences), 4) if confidences else None
        root = "ok"
        if source == "company_ir_rss" and company_ir_status != "ok":
            root = company_ir_status
        elif source == "gdelt_events" and gdelt_status != "ok":
            root = f"formal_shadow_{gdelt_status}"
        elif by_source.get(source, 0) == 0:
            root = "no_accepted_rows"
        upsert_quality(source, dataset, by_source.get(source, 0), latest_by_source.get(source), avg_confidence, root)

    post = d1(
        """
        SELECT source_id, COUNT(*) AS rows,
               SUM(CASE WHEN accepted=1 THEN 1 ELSE 0 END) AS accepted,
               MAX(published_at) AS latest
        FROM external_evidence_items
        GROUP BY source_id
        ORDER BY source_id
        """
    )
    quality = d1(
        """
        SELECT source, dataset, freshness_status, missing_rate, entity_link_confidence,
               latest_materialization, metrics_json
        FROM source_quality_metrics
        WHERE source IN ('official_rss','company_ir_rss','gdelt_events')
        ORDER BY source, dataset
        """
    )
    print(
        json.dumps(
            {
                "target_date": TARGET_DATE,
                "recommendation_symbols": len(symbols),
                "official_items_built": len(official_items),
                "company_ir_items_built": len(company_ir_items),
                "company_ir_status": company_ir_status,
                "gdelt_items_built": len(gdelt_items),
                "gdelt_status": gdelt_status,
                "packet_quality": packet.get("quality_summary"),
                "evidence_rows_written_or_existing": len(evidence_rows),
                "external_theme_rows_upserted": len(external_theme_rows),
                "finlab_taxonomy_theme_rows_upserted": len(taxonomy_theme_rows),
                "theme_rows_upserted": len(theme_rows),
                "stock_theme_features_upserted": len(feature_rows),
                "post_external_evidence_by_source": post,
                "source_quality_metrics": quality,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
