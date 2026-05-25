from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


def test_backtest_research_lane_uses_chunked_d1_fallback():
    source = (ROOT / "services" / "backtest_service.py").read_text(encoding="utf-8")

    assert "resolve_research_data_access" in source
    assert "BACKTEST_D1_READ_CHUNK_SIZE" in source
    assert "_bulk_load_prices_by_stock" in source
    assert "_bulk_load_ensemble_signals_by_stock" in source
    assert "market_risk_level" in source
    assert "or p.get(\"market_risk_level\")" in source
    assert "entry_regime = str(" in source
    assert "entry_regime=entry_regime" in source
    assert "\"entry_regime\": lot.entry_regime" in source
    assert "\"all_regimes\": all_regimes" in source
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


def test_weekly_monthly_optuna_heavy_routes_require_compute_snapshot():
    router_source = (ROOT / "routers" / "optuna.py").read_text(encoding="utf-8")
    sltp_source = (ROOT / "optuna_scripts" / "optuna_sltp.py").read_text(encoding="utf-8")
    screener_source = (ROOT / "optuna_scripts" / "optuna_screener.py").read_text(encoding="utf-8")
    per_regime_source = (ROOT / "optuna_scripts" / "optuna_per_regime_robust.py").read_text(encoding="utf-8")

    assert "research_data_source" in router_source
    assert "_research_data_mode_for_request" in router_source
    assert "cadence in {\"weekly\", \"monthly\"}" in router_source
    assert "data_mode=_research_data_mode_for_request(req)" in router_source
    assert "mode=data_mode" in sltp_source
    assert "mode=data_mode" in screener_source
    assert "mode=data_mode" in per_regime_source
    assert "BacktestDataset.load_from_d1(" not in sltp_source
    assert "BacktestDataset.load_from_d1(" not in screener_source
    assert "BacktestDataset.load_from_d1(" not in per_regime_source


def test_snapshot_optuna_defaults_window_to_latest_ready_snapshot_not_wall_clock_today():
    sltp_source = (ROOT / "optuna_scripts" / "optuna_sltp.py").read_text(encoding="utf-8")
    screener_source = (ROOT / "optuna_scripts" / "optuna_screener.py").read_text(encoding="utf-8")
    access_source = (ROOT / "services" / "research_data_access.py").read_text(encoding="utf-8")

    assert "latest_snapshot_business_end_date" in access_source
    assert "snapshot_end_date = latest_snapshot_business_end_date" in sltp_source
    assert "snapshot_end_date = latest_snapshot_business_end_date" in screener_source
    assert "end_date = snapshot_end_date or tw_today" in sltp_source
    assert "end_date = snapshot_end_date or tw_today" in screener_source


def test_weekly_monthly_optuna_sweep_uses_controller_owned_bounded_parallelism():
    router_source = (ROOT / "routers" / "optuna.py").read_text(encoding="utf-8")

    assert "ThreadPoolExecutor" in router_source
    assert "max_workers = min(" in router_source
    assert "executor.submit(_run_optuna_sweep_source" in router_source
    assert "as_completed(" in router_source
    assert "for source, runner in sweep_plan:" not in router_source


def test_weekly_monthly_optuna_sweep_has_job_trigger_and_callback_entrypoint():
    router_source = (ROOT / "routers" / "optuna.py").read_text(encoding="utf-8")
    job_source = (ROOT / "optuna_job_main.py").read_text(encoding="utf-8")

    assert '@router.post("/research_sweep/run")' in router_source
    assert "OPTUNA_JOB_NAME" in router_source
    assert "CloudRunJobsClient" in router_source
    assert "OPTUNA_RESEARCH_SWEEP_EXECUTOR" in router_source
    assert "spawn_optuna_research_sweep" in router_source
    assert "OPTUNA_ALLOW_SYNC_SWEEP" in router_source
    assert "execute_research_sweep" in job_source
    assert 'task = f"{cadence}-optuna"' in job_source
    assert '"task": task' in job_source
    assert "_callback_worker" in job_source
    assert "OPTUNA_RUN_DATE" in job_source
    assert "payload[\"run_date\"] = run_date" in job_source
    assert "OPTUNA_CADENCE" in job_source
    assert "OPTUNA_N_TRIALS" in job_source
    assert "OPTUNA_SUBSET_SIZE" in job_source
    assert "run_date" in router_source
    assert 'env_overrides["OPTUNA_RUN_DATE"] = req.run_date' in router_source


def test_research_data_policy_prevents_silent_fallback():
    source = (ROOT / "services" / "research_data_access.py").read_text(encoding="utf-8")

    assert "STOCKVISION_RESEARCH_DATA_SOURCE" in source
    assert "research_snapshot_required_but_unavailable" in source
    assert "explicit D1 chunked fallback" in source
    assert "latest_dataset_snapshot" in source
    assert "as_of_business_date=business_date" in source
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


def test_backtest_snapshot_path_preserves_technical_v2_columns():
    backtest_source = (ROOT / "services" / "backtest_engine.py").read_text(encoding="utf-8")
    exporter_source = (ROOT / "services" / "dataset_snapshot_exporter.py").read_text(encoding="utf-8")
    snapshot_loader_test = (ROOT / "tests" / "test_backtest_snapshot_loader.py").read_text(encoding="utf-8")
    required_columns = [
        "plus_di14",
        "minus_di14",
        "adx14",
        "parabolic_sar",
        "cci20",
        "volume_weighted_rsi14",
        "volume_momentum_divergence_13_27_10",
    ]

    for column in required_columns:
        assert column in backtest_source, f"backtest dataset loader must preserve {column}"
        assert column in exporter_source, f"snapshot exporter must include {column}"
        assert column in snapshot_loader_test, f"snapshot loader fixture must assert {column}"


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
    assert "backtest-dataset-parquet-v2" in source
    assert '"sentiment": sentiment' in source
    assert '"monthly_revenue": monthly_revenue' in source
    assert '"margin_data": margin_data' in source
    assert '"shareholding": shareholding' in source
    assert "dataset_export_no_prices" in source
    assert "dataset_export_no_ensemble_signals" in source
    assert "price-history-parquet-v1" in source
    assert 'supported = {"backtest_dataset", "price_history"}' in route_source
    assert "dataset_snapshots.router" in main_source


def test_pipeline_exports_research_snapshot_after_recommendation_write():
    graph_source = (ROOT / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    job_source = (ROOT / "pipeline_job_main.py").read_text(encoding="utf-8")
    snapshot_job_source = (ROOT / "dataset_snapshot_job_main.py").read_text(encoding="utf-8")
    modal_client_source = (ROOT / "services" / "modal_client.py").read_text(encoding="utf-8")
    modal_app_source = (ROOT.parent / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert "node_export_dataset_snapshot" in graph_source
    assert "export_daily_research_snapshots" in graph_source
    assert "asyncio.gather(" not in graph_source[graph_source.index("async def node_export_dataset_snapshot"):graph_source.index("def _to_dict")]
    assert "STOCKVISION_EXPORT_RESEARCH_SNAPSHOT" in graph_source
    assert "producer_run_id" in graph_source
    assert graph_source.index('g.add_node("write_d1"') < graph_source.index('g.add_node("export_dataset_snapshot"')
    assert graph_source.index('g.add_edge("write_d1"') < graph_source.index('g.add_edge("export_dataset_snapshot"')
    assert "producer_run_id=run_id" in job_source
    assert "snapshot=" in job_source
    assert "_run_deferred_snapshot_followup" in job_source
    assert "_trigger_deferred_snapshot_job" in job_source
    assert "DATASET_SNAPSHOT_JOB_NAME" in job_source
    assert "DATASET_SNAPSHOT_EXECUTOR" in job_source
    assert "_trigger_deferred_snapshot_modal" in job_source
    assert '"task": "dataset-snapshot-export"' in job_source
    assert '"status": "triggered"' in job_source
    assert "STOCKVISION_DEFERRED_SNAPSHOT_FOLLOWUP" in job_source
    assert "export_daily_research_snapshots" in snapshot_job_source
    assert '"task": "dataset-snapshot-export"' in snapshot_job_source
    assert "async def spawn_dataset_snapshot_export" in modal_client_source
    assert '"dataset_snapshot_export": {"cpu": 4.0, "memory_mb": 4096' in modal_client_source
    assert "def dataset_snapshot_export(payload: dict) -> dict:" in modal_app_source
    assert "export_daily_research_snapshots(request)" in modal_app_source
    assert '"source": "dataset_snapshot_export"' in modal_app_source
    assert '"compute_owner": "modal"' in modal_app_source
    assert '"remote_function": "dataset_snapshot_export"' in modal_app_source
