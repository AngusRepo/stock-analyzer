from pathlib import Path
import asyncio
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def test_walk_forward_defaults_to_active8_contract():
    from services.walk_forward_retrain import MODELS_ALL, walk_forward_model_coverage

    expected = [
        "LightGBM",
        "XGBoost",
        "ExtraTrees",
        "TabM",
        "GNN",
        "DLinear",
        "PatchTST",
        "iTransformer",
    ]
    assert MODELS_ALL == expected

    coverage = walk_forward_model_coverage()
    assert coverage["requested_models"] == expected
    assert coverage["native_retrain_models"] == expected
    assert coverage["artifact_lifecycle_required_models"] == []
    assert coverage["coverage_mode"] == "active8_purged_oof_retrain"


def test_walk_forward_router_exposes_active8_coverage():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert "walk_forward_model_coverage" in source
    assert "\"planned_model_evaluations\"" in source
    assert "\"model_coverage\"" in source
    assert "active-8 coverage" in source
    assert "5 models" not in source


def test_walk_forward_train_payload_declares_five_day_label_horizon():
    from services.walk_forward_retrain import WalkForwardWindow, build_walk_forward_train_payload

    window = WalkForwardWindow(
        window_id=7,
        train_start="2026-01-02",
        train_end="2026-03-31",
        test_start="2026-04-01",
        test_end="2026-04-30",
    )

    payload = build_walk_forward_train_payload(window, batch_count=5)

    assert payload["label_horizon_days"] == 5
    assert payload["train_end"] == "2026-03-31"
    assert payload["test_start"] == "2026-04-01"


def test_modal_walk_forward_orchestrator_no_longer_defaults_tree_only():
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "from app.model_pool import ALPHA_PREDICTION_MODELS" in source
    assert "active8_models = list(ALPHA_PREDICTION_MODELS)" in source
    assert "family_tasks" in source
    assert "oof_fold_ready" in source
    assert "payload.get(\"models\") or active8_models" in source
    assert "payload.get(\"models\") or [\"XGBoost\", \"ExtraTrees\", \"LightGBM\"]" not in source


def test_oof_automatic_promotion_requires_primary_fusion_and_operational_parity():
    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")

    assert 'fusion_tier == "primary"' in source
    assert 'parity.get("decision") == "PASS"' in source
    assert "archive_ev_candidate_artifacts" in source
    assert "purged OOF quality PASS and native operational parity PASS" in source


def test_walk_forward_routes_long_sequence_v3_prep_into_every_oof_fold():
    router_source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    modal_source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert 'sequence_gcs_prefix: str = "universal/sequence_long/latest"' in router_source
    assert '"sequence_gcs_prefix": req.sequence_gcs_prefix' in router_source
    assert '"sequence_batch_count": req.sequence_batch_count' in router_source
    assert "active8_oof_sequence_v3_prep_batch_missing" in modal_source
    assert "canonical-adjusted-close-net-v4" in modal_source
    assert '"version": f"{cohort_id}-w{wid}"' in modal_source
    assert 'version = payload.get("output_model_version") or payload.get("version", "v1")' in modal_source
    assert 'generation_mode=payload.get("generation_mode")' in modal_source
    assert 'cohort_id=payload.get("cohort_id")' in modal_source
    assert 'test_start=payload.get("test_start")' in modal_source


def test_walk_forward_calendar_reader_does_not_hydrate_backtest_dataset(monkeypatch):
    from routers import walk_forward
    from services import d1_client

    captured = {}

    def fake_query(sql, params=None):
        captured["sql"] = sql
        captured["params"] = params
        return [
            {"trading_date": "2026-07-04", "price_rows": 1},
            {"trading_date": "2026-07-06", "price_rows": 2300},
            {"trading_date": "2026-07-07", "price_rows": 2310},
        ]

    monkeypatch.setattr(d1_client, "query", fake_query)

    days, access = walk_forward._load_trading_calendar("2026-07-01", "2026-07-07")

    assert days == ["2026-07-06", "2026-07-07"]
    assert captured["params"] == ["2026-07-01", "2026-07-07"]
    assert "GROUP BY substr(date, 1, 10)" in captured["sql"]
    assert access["mode"] == "d1_stock_prices_grouped"
    assert access["observed_price_rows"] == 4611
    assert access["coverage_reference_rows"] == 2300.0
    assert access["coverage_threshold_rows"] == 460
    assert access["excluded_low_coverage_dates"] == [
        {"date": "2026-07-04", "price_rows": 1}
    ]
    assert access["training_data_source"] == "immutable_gcs_prep"

    source = (ROOT / "ml-controller" / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    assert "BacktestDataset.load_for_research" not in source


def test_walk_forward_dry_run_builds_windows_from_lightweight_calendar(monkeypatch):
    from routers import walk_forward

    trading_days = [f"2026-01-{day:02d}" for day in range(1, 21)]
    monkeypatch.setattr(
        walk_forward,
        "_load_trading_calendar",
        lambda _start, _end: (trading_days, {"mode": "d1_stock_prices_grouped"}),
    )

    result = asyncio.run(walk_forward.walk_forward_dry_run(walk_forward.WalkForwardRequest(
        start_date="2026-01-01",
        end_date="2026-01-20",
        train_window_days=10,
        test_window_days=5,
    )))

    assert result["windows_count"] == 2
    assert result["windows"][0]["train_range"] == ("2026-01-01", "2026-01-10")
    assert result["windows"][0]["test_range"] == ("2026-01-11", "2026-01-15")
    assert result["data_access"]["mode"] == "d1_stock_prices_grouped"
