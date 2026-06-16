from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services import state_space_series  # noqa: E402


@dataclass
class FakePayload:
    symbol: str
    prices: list[dict] = field(default_factory=list)


def _test_tmp_file(name: str) -> Path:
    base = Path(__file__).resolve().parent.parent / ".tmp" / "test_state_space_series"
    base.mkdir(parents=True, exist_ok=True)
    return base / name


def test_build_state_space_series_from_payloads_preserves_pipeline_shape_and_order():
    series = state_space_series.build_state_space_series_from_payloads(
        [
            {
                "symbol": "2330",
                "prices": [
                    {"date": "2026-05-14", "close": 100},
                    {"date": "2026-05-15", "close": "101.5"},
                    {"date": "2026-05-16", "close": None},
                ],
            },
            FakePayload(
                symbol="2317",
                prices=[
                    {"date": "2026-05-14", "close": 90},
                    {"date": "2026-05-15", "close": 91},
                ],
            ),
            {"symbol": "empty", "prices": [{"close": None}]},
        ],
    )

    assert series == [
        {"symbol": "2330", "prices": [100.0, 101.5]},
        {"symbol": "2317", "prices": [90.0, 91.0]},
    ]


def test_long_history_enrichment_prefers_gcs_sequence_and_trims_to_target(monkeypatch):
    monkeypatch.setattr(
        state_space_series,
        "load_long_history_sequence_map",
        lambda **_kwargs: {"2330": [float(i) for i in range(1200)]},
    )

    enriched, meta = state_space_series.enrich_state_space_series_with_long_history(
        [{"symbol": "2330", "prices": [1.0, 2.0]}, {"symbol": "2317", "prices": [90.0, 91.0]}],
        target_points=1024,
    )

    assert meta["status"] == "ok"
    assert meta["source"] == "gcs_long_history_or_payload_prices"
    assert meta["target_points"] == 1024
    assert meta["enriched_series"] == 1
    assert enriched[0]["sequence_source"] == "gcs_long_history"
    assert len(enriched[0]["prices"]) == 1024
    assert enriched[0]["prices"][0] == 176.0
    assert enriched[1]["sequence_source"] == "payload_prices"
    assert enriched[1]["prices"] == [90.0, 91.0]


def test_long_history_enrichment_surfaces_payload_only_without_fallback_label(monkeypatch):
    def raise_loader(**_kwargs):
        raise RuntimeError("gcs unavailable")

    monkeypatch.setattr(state_space_series, "load_long_history_sequence_map", raise_loader)

    enriched, meta = state_space_series.enrich_state_space_series_with_long_history(
        [{"symbol": "2330", "prices": [1.0, 2.0]}],
        target_points=1024,
    )

    assert enriched == [{"symbol": "2330", "prices": [1.0, 2.0]}]
    assert meta["status"] == "payload_prices_only"
    assert "fallback" not in meta["status"]


def test_build_state_space_series_export_applies_limit():
    export = state_space_series.build_state_space_series_export(
        run_date="2026-05-18",
        payloads=[
            {"symbol": "2330", "prices": [{"close": 100}]},
            {"symbol": "2317", "prices": [{"close": 90}]},
        ],
        limit=1,
    )

    assert export["schema_version"] == state_space_series.STATE_SPACE_SERIES_EXPORT_SCHEMA_VERSION
    assert export["run_date"] == "2026-05-18"
    assert export["n_series"] == 1
    assert export["series_list"] == [{"symbol": "2330", "prices": [100.0]}]


def test_load_state_space_series_export_from_payload_file_supports_offline_payloads():
    payload_path = _test_tmp_file("payloads.json")
    payload_path.write_text(
        """
        {
          "payloads": [
            {"symbol": "2330", "prices": [{"close": 100}, {"close": 101}]},
            {"symbol": "2317", "prices": [{"close": 90}, {"close": null}]}
          ]
        }
        """,
        encoding="utf-8-sig",
    )

    export = state_space_series.load_state_space_series_export_from_payload_file(
        path=payload_path,
        run_date="2026-05-18",
    )

    assert export["source"] == "offline_payload_json.payloads.prices.close"
    assert export["source_path"] == str(payload_path)
    assert export["n_payloads"] == 2
    assert export["series_list"] == [
        {"symbol": "2330", "prices": [100.0, 101.0]},
        {"symbol": "2317", "prices": [90.0]},
    ]


def test_load_state_space_series_export_from_payload_file_supports_list_payload():
    payload_path = _test_tmp_file("payloads-list.json")
    payload_path.write_text(
        '[{"symbol": "2330", "prices": [{"close": 100}]}, {"symbol": "2317", "prices": [{"close": 90}]}]',
        encoding="utf-8",
    )

    export = state_space_series.load_state_space_series_export_from_payload_file(
        path=payload_path,
        run_date="2026-05-18",
        limit=1,
    )

    assert export["n_payloads"] == 2
    assert export["n_series"] == 1
    assert export["series_list"] == [{"symbol": "2330", "prices": [100.0]}]


def test_load_daily_state_space_series_export_uses_read_only_pipeline_inputs(monkeypatch):
    from services import d1_client, payload_builder

    monkeypatch.setattr(
        d1_client,
        "query",
        lambda sql, params=None: [{"id": 1, "symbol": "2330", "rank": 1}],
    )
    monkeypatch.setattr(
        payload_builder,
        "build_ml_universe",
        lambda _active, screener: [{"id": screener[0]["id"], "symbol": screener[0]["symbol"]}],
    )
    monkeypatch.setattr(
        payload_builder,
        "load_market_env",
        lambda _run_date: ({}, {}, {}, {}, {}),
    )
    monkeypatch.setattr(
        payload_builder,
        "build_payloads",
        lambda **_kwargs: [{"symbol": "2330", "prices": [{"close": 100}, {"close": 101}]}],
    )

    export = state_space_series.load_daily_state_space_series_export(run_date="2026-05-18")

    assert export["n_screener_recs"] == 1
    assert export["n_payloads"] == 1
    assert export["series_list"] == [{"symbol": "2330", "prices": [100.0, 101.0]}]
