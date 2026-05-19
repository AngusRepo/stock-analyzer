from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.external_evidence_runtime import (  # noqa: E402
    build_external_evidence_runtime_packet,
    build_theme_signals_from_external_packet,
    external_evidence_item_d1_rows,
    fetch_rss_items,
    merge_theme_signals,
    normalize_gdelt_article,
    theme_signal_d1_rows,
)


def test_official_rss_fetcher_normalizes_items_for_authoritative_evidence():
    rss = """<?xml version="1.0" encoding="UTF-8"?>
    <rss><channel><item>
      <title>TWSE official market announcement</title>
      <link>https://www.twse.com.tw/news/example</link>
      <pubDate>Fri, 15 May 2026 08:00:00 GMT</pubDate>
      <guid>twse-1</guid>
    </item></channel></rss>"""

    rows = fetch_rss_items(
        url="https://www.twse.com.tw/rss",
        source_id="official_rss",
        provider="TWSE",
        fetcher=lambda _url, _headers=None: rss,
    )

    packet = build_external_evidence_runtime_packet(
        official_items=rows,
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert rows[0]["source_id"] == "official_rss"
    assert rows[0]["domain_allowlist_match"] is True
    assert packet["quality_summary"]["accepted"] == 1
    assert packet["items"][0]["allowed_use"] == "official_event_audit"


def test_external_evidence_runtime_builds_theme_signals_for_screener():
    official_rows = fetch_rss_items(
        url="https://www.twse.com.tw/rss",
        source_id="official_rss",
        provider="TWSE",
        fetcher=lambda _url, _headers=None: """<?xml version="1.0" encoding="UTF-8"?>
        <rss><channel><item>
          <title>AI server order visibility improves</title>
          <link>https://www.twse.com.tw/news/ai</link>
          <pubDate>Fri, 15 May 2026 08:00:00 GMT</pubDate>
        </item></channel></rss>""",
    )
    official_rows[0]["themes"] = ["AI_Server"]
    official_rows[0]["symbols"] = ["2330"]
    packet = build_external_evidence_runtime_packet(
        official_items=official_rows,
        gdelt_items=[
            normalize_gdelt_article(
                {
                    "title": "Global supply chain disruption raises semiconductor risk",
                    "url": "https://gdelt.example/news/1",
                    "seendate": "20260515T120000Z",
                    "tone": -3.1,
                },
                symbols=["2330"],
                themes=["SEMICONDUCTOR_SUPPLY_CHAIN"],
            )
        ],
        generated_at="2026-05-16T00:00:00+00:00",
    )

    assert packet["quality_summary"]["accepted"] == 2
    signals = packet["runtime"]["theme_signals"]
    by_source = {signal["source"]: signal for signal in signals}
    assert by_source["official_rss"]["concept"] == "AI_Server"
    assert by_source["official_rss"]["score"] > by_source["gdelt_events"]["score"]
    assert by_source["gdelt_events"]["decision_effect"] == "research_or_risk_context"
    assert theme_signal_d1_rows(signals)[0]["top_titles"].startswith("[")
    evidence_rows = external_evidence_item_d1_rows(packet)
    official_evidence = next(row for row in evidence_rows if row["source_id"] == "official_rss")
    assert official_evidence["accepted"] == 1
    assert official_evidence["raw_json"].startswith("{")


def test_theme_signal_merge_preserves_source_breakdown():
    official_rows = fetch_rss_items(
        url="https://www.twse.com.tw/rss",
        source_id="official_rss",
        provider="TWSE",
        fetcher=lambda _url, _headers=None: """<?xml version="1.0" encoding="UTF-8"?>
        <rss><channel><item>
          <title>AI server supply chain update</title>
          <link>https://www.twse.com.tw/news/2</link>
          <pubDate>Fri, 15 May 2026 08:00:00 GMT</pubDate>
        </item></channel></rss>""",
    )
    official_rows[0]["themes"] = ["AI_Server"]
    official_rows[0]["symbols"] = ["2330"]
    signals = build_theme_signals_from_external_packet(
        build_external_evidence_runtime_packet(
            official_items=official_rows,
            generated_at="2026-05-16T00:00:00+00:00",
        ),
        generated_at="2026-05-16T00:00:00+00:00",
    )

    merged = merge_theme_signals(signals)

    assert merged[0]["concept"] == "AI_Server"
    assert merged[0]["sources"] == ["official_rss"]
    assert merged[0]["source_breakdown"]["official_rss"] > 0
