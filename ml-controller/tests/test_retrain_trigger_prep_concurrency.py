from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import retrain_trigger  # noqa: E402


def test_universal_prep_concurrency_defaults_to_bounded_parallelism(monkeypatch):
    monkeypatch.delenv("UNIVERSAL_PREP_CONCURRENCY", raising=False)

    assert retrain_trigger._universal_prep_concurrency() == 3


def test_universal_prep_concurrency_clamps_invalid_and_extreme_values(monkeypatch):
    monkeypatch.setenv("UNIVERSAL_PREP_CONCURRENCY", "not-a-number")
    assert retrain_trigger._universal_prep_concurrency() == 3

    monkeypatch.setenv("UNIVERSAL_PREP_CONCURRENCY", "0")
    assert retrain_trigger._universal_prep_concurrency() == 1

    monkeypatch.setenv("UNIVERSAL_PREP_CONCURRENCY", "99")
    assert retrain_trigger._universal_prep_concurrency() == 5


def test_snapshot_component_uris_reads_component_meta_and_components():
    snapshot = {
        "metadata_json": """
        {
          "component_meta": {
            "prices": {"gcs_uri": "gs://bucket/p/prices.parquet"}
          },
          "components": {
            "chips": "gs://bucket/p/chips.parquet"
          }
        }
        """
    }

    assert retrain_trigger._snapshot_component_uris(snapshot) == {
        "prices": "gs://bucket/p/prices.parquet",
        "chips": "gs://bucket/p/chips.parquet",
    }


def test_parse_gcs_uri_splits_bucket_and_blob():
    assert retrain_trigger._parse_gcs_uri("gs://bucket/path/file.parquet") == (
        "bucket",
        "path/file.parquet",
    )


def test_load_training_maps_requires_exact_snapshot_date(monkeypatch):
    captured = {}

    def fake_latest_dataset_snapshot(**kwargs):
        captured.update(kwargs)
        return None

    monkeypatch.setattr(
        "services.dataset_snapshots.latest_dataset_snapshot",
        fake_latest_dataset_snapshot,
    )

    result = retrain_trigger._load_training_maps_from_snapshot(
        stock_ids=[1],
        symbols=["2330"],
        prices_lookback=252,
        as_of_business_date="2026-05-06",
    )

    assert result is None
    assert captured == {
        "kind": "backtest_dataset",
        "access_tier": "compute",
        "business_date": "2026-05-06",
    }


def _retired_test_monthly_business_date_resolves_weekend_to_complete_snapshot(monkeypatch):
    monkeypatch.setattr(
        "services.active8_prep_lifecycle._latest_market_session",
        lambda cutoff, query_fn: ("2026-07-31", {"market_session_price_rows": 2301}),
    )
    monkeypatch.setattr(
        "services.dataset_snapshots.latest_dataset_snapshot",
        lambda **kwargs: {
            "snapshot_id": "backtest_dataset:2026-07-31:test",
            "business_date": "2026-07-31",
            "manifest_errors": [],
        },
    )

    business_date, evidence = retrain_trigger._resolve_monthly_retrain_business_date(
        requested_run_date=None,
        cutoff_date="2026-08-02",
    )

    assert business_date == "2026-07-31"
    assert evidence["mode"] == "latest_complete_market_session"
    assert evidence["snapshot_id"] == "backtest_dataset:2026-07-31:test"


def _retired_test_monthly_business_date_rejects_snapshot_behind_market_session(monkeypatch):
    monkeypatch.setattr(
        "services.active8_prep_lifecycle._latest_market_session",
        lambda cutoff, query_fn: ("2026-07-31", {}),
    )
    monkeypatch.setattr(
        "services.dataset_snapshots.latest_dataset_snapshot",
        lambda **kwargs: {
            "snapshot_id": "backtest_dataset:2026-07-30:test",
            "business_date": "2026-07-30",
            "manifest_errors": [],
        },
    )

    try:
        retrain_trigger._resolve_monthly_retrain_business_date(
            requested_run_date=None,
            cutoff_date="2026-08-02",
        )
    except ValueError as exc:
        assert "monthly_compute_snapshot_behind_market_session" in str(exc)
    else:
        raise AssertionError("stale monthly snapshot must fail closed")

def test_timesfm_feature_release_coverage_requires_breadth_and_history():
    failed = retrain_trigger._timesfm_l175_release_coverage(
        {"stocks_with_history": 396, "history_dates": 7},
        eligible_stocks=2317,
    )
    passed = retrain_trigger._timesfm_l175_release_coverage(
        {"stocks_with_history": 2100, "history_dates": 25},
        eligible_stocks=2317,
    )

    assert failed["status"] == "fail"
    assert failed["blockers"] == [
        "timesfm_l175_stock_coverage_below_minimum",
        "timesfm_l175_history_dates_below_minimum",
    ]
    assert passed["status"] == "pass"
    assert passed["blockers"] == []


def test_snapshot_per_stock_ts_map_builds_wave3_history():
    mapped = retrain_trigger._snapshot_per_stock_ts_map(
        stock_ids=[1],
        monthly_revenue_rows=[{"stock_id": 1, "date": "2026-04", "revenue_yoy": 12.5}],
        canonical_fundamental_rows=[{
            "stock_id": "2330", "available_date": "2026-05-15",
            "eps": 10.0, "roe": 25.0, "pe": 20.0, "pb": 5.0,
        }],
        margin_rows=[{"stock_id": 1, "date": "2026-05-06", "margin_balance": 1000, "short_ratio": 0.2}],
        shareholding_rows=[{"stock_id": 1, "date": "2026-05-06", "retail_pct": 45.6}],
        symbol_to_id={"2330": 1},
    )

    assert mapped[1]["2026-05-12"]["revenue_yoy"] == 12.5
    assert mapped[1]["2026-05-06"]["margin_balance"] == 1000
    assert mapped[1]["2026-05-06"]["short_ratio"] == 0.2
    assert mapped[1]["2026-05-06"]["retail_pct"] == 45.6
    assert mapped[1]["2026-05-15"]["eps"] == 10.0
    assert mapped[1]["2026-05-15"]["pb"] == 5.0


def test_snapshot_sentiment_map_groups_by_stock():
    mapped = retrain_trigger._snapshot_sentiment_map(
        [
            {"stock_id": 1, "date": "2026-05-06", "score": 0.7},
            {"stock_id": 2, "date": "2026-05-06", "score": -0.2},
        ],
        [1],
    )

    assert mapped == {1: [{"date": "2026-05-06", "score": 0.7}]}
