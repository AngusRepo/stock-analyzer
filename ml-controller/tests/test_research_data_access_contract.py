from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_backtest_research_lane_uses_chunked_d1_fallback():
    source = (ROOT / "services" / "backtest_service.py").read_text(encoding="utf-8")

    assert "resolve_research_data_access" in source
    assert "BACKTEST_D1_READ_CHUNK_SIZE" in source
    assert "_bulk_load_prices_by_stock" in source
    assert "_bulk_load_ensemble_signals_by_stock" in source
    assert "d1_chunked_bulk_fallback" in source
    assert "d1_read_queries" in source
    assert "_load_backtest_inputs_from_snapshot" in source
    assert "snapshot_reader_not_implemented" not in source


def test_optuna_sandbox_price_loaders_are_chunked_not_per_stock_n_plus_one():
    source = (ROOT / "routers" / "optuna.py").read_text(encoding="utf-8")

    assert "resolve_research_data_access" in source
    assert "OPTUNA_D1_READ_CHUNK_SIZE" in source
    assert "_load_price_rows_by_stock_ids" in source
    assert "ROW_NUMBER() OVER (PARTITION BY stock_id" in source
    assert "stock_price_rows = _load_price_rows_by_stock_ids" in source
    assert "_load_top_active_stocks_with_prices_from_snapshot" in source
    assert "_load_rrg_inputs_from_snapshot" in source
    assert "snapshot_reader_not_implemented" not in source


def test_research_data_policy_prevents_silent_fallback():
    source = (ROOT / "services" / "research_data_access.py").read_text(encoding="utf-8")

    assert "STOCKVISION_RESEARCH_DATA_SOURCE" in source
    assert "research_snapshot_required_but_unavailable" in source
    assert "explicit D1 chunked fallback" in source
    assert "latest_dataset_snapshot" in source
    assert "required_start_date" in source
    assert "snapshot_start_after_required" in source
    assert "snapshot_end_before_required" in source


def test_backtest_engine_replay_uses_manifest_before_d1():
    source = (ROOT / "services" / "backtest_engine.py").read_text(encoding="utf-8")

    assert "load_from_snapshot_manifest" in source
    assert "load_from_snapshot" in source
    assert "resolve_research_data_access" in source
    assert "kind=\"backtest_dataset\"" in source
    assert "required_start_date=start_date" in source
    assert "required_end_date=end_date" in source
    assert "data_access.source == \"snapshot\"" in source


def test_research_backtest_callers_share_single_loader_contract():
    config_pool = (ROOT / "routers" / "config_pool.py").read_text(encoding="utf-8")
    walk_forward = (ROOT / "routers" / "walk_forward.py").read_text(encoding="utf-8")
    backtest = (ROOT / "routers" / "backtest.py").read_text(encoding="utf-8")

    assert "BacktestDataset.load_for_research" in config_pool
    assert "BacktestDataset.load_for_research" in walk_forward
    assert "BacktestDataset.load_for_research" in backtest
    assert "BacktestDataset.load_from_d1(start_date=start_date, end_date=end_date)" not in config_pool
    assert "BacktestDataset.load_from_d1(" not in walk_forward


def test_dataset_snapshot_exporter_produces_gcs_manifest():
    source = (ROOT / "services" / "dataset_snapshot_exporter.py").read_text(encoding="utf-8")
    main_source = (ROOT / "main.py").read_text(encoding="utf-8")
    route_source = (ROOT / "routers" / "dataset_snapshots.py").read_text(encoding="utf-8")

    assert "export_backtest_dataset_snapshot" in source
    assert "export_price_history_snapshot" in source
    assert "export_daily_research_snapshots" in source
    assert "write_parquet" in source
    assert "upsert_dataset_snapshot_manifest" in source
    assert "build_dataset_snapshot_manifest" in source
    assert "access_tier=\"compute\"" in source
    assert "dataset_export_no_prices" in source
    assert "dataset_export_no_ensemble_signals" in source
    assert "price-history-parquet-v1" in source
    assert 'supported = {"backtest_dataset", "price_history"}' in route_source
    assert "dataset_snapshots.router" in main_source


def test_pipeline_exports_research_snapshot_after_recommendation_write():
    graph_source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    job_source = (ROOT / "pipeline_job_main.py").read_text(encoding="utf-8")

    assert "node_export_dataset_snapshot" in graph_source
    assert "export_daily_research_snapshots" in graph_source
    assert "asyncio.gather(" not in graph_source[graph_source.index("async def node_export_dataset_snapshot"):graph_source.index("def _to_dict")]
    assert "STOCKVISION_EXPORT_RESEARCH_SNAPSHOT" in graph_source
    assert "producer_run_id" in graph_source
    assert graph_source.index('g.add_node("write_d1"') < graph_source.index('g.add_node("export_dataset_snapshot"')
    assert graph_source.index('g.add_edge("write_d1"') < graph_source.index('g.add_edge("export_dataset_snapshot"')
    assert "producer_run_id=run_id" in job_source
    assert "snapshot=" in job_source
