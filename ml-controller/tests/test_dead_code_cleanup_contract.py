from __future__ import annotations

import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_legacy_wave2_and_local_launch_artifacts_are_removed() -> None:
    assert not (ROOT / ".claude" / "launch.json").exists()
    assert not (ROOT / "frontend" / ".claude" / "launch.json").exists()
    assert not (ROOT / "worker" / "migration_wave2_data.sql").exists()

    sql_path = ROOT / "worker" / "migration_supplemental_official_data.sql"
    sql = sql_path.read_text(encoding="utf-8")
    assert "Wave2" not in sql
    assert "Wave 2" not in sql

    con = sqlite3.connect(":memory:")
    con.execute("CREATE TABLE stocks(id INTEGER PRIMARY KEY)")
    con.executescript(sql)
    table_names = {
        row[0]
        for row in con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    assert {"monthly_revenue", "market_breadth", "us_market_signals"} <= table_names


def test_deprecated_permutation_importance_path_is_removed() -> None:
    main_source = (ROOT / "ml-service" / "app" / "main.py").read_text(encoding="utf-8")
    assert "_deprecated_run_permutation_importance" not in main_source
    assert "permutation_importance.json" not in main_source


def test_unused_adaptive_confidence_threshold_helper_is_removed() -> None:
    adaptive_source = (ROOT / "ml-controller" / "services" / "adaptive.py").read_text(encoding="utf-8")
    assert "def compute_confidence_threshold(" not in adaptive_source


def test_retired_ft_transformer_has_no_active_training_or_optuna_entrypoints() -> None:
    controller_optuna = (ROOT / "ml-controller" / "routers" / "optuna.py").read_text(encoding="utf-8")
    controller_modal = (ROOT / "ml-controller" / "services" / "modal_client.py").read_text(encoding="utf-8")
    controller_walk_forward = (
        ROOT / "ml-controller" / "services" / "walk_forward_retrain.py"
    ).read_text(encoding="utf-8")
    modal_app = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert '@router.post("/ft_arch")' not in controller_optuna
    assert "class FtArchReq" not in controller_optuna
    assert "_modal_ft_arch_search" not in controller_optuna
    assert "_modal_ft_arch_search" not in controller_modal

    retired_modal_function_names = (
        "train_ftt_model",
        "ft_transformer_arch_search",
        "train_wf_ftt_window",
    )
    for function_name in retired_modal_function_names:
        assert function_name not in controller_modal
        assert f"def {function_name}" not in modal_app

    assert "_modal_train_wf_ftt_window" not in controller_modal
    assert "_spawn_wf_ftt_window" not in controller_modal
    assert "_modal_train_wf_ftt_window" not in controller_walk_forward
    assert "need_ftt" not in controller_walk_forward


def test_retired_ft_transformer_has_no_optuna_contract_or_script() -> None:
    contracts_source = (
        ROOT / "ml-controller" / "services" / "optuna_script_contracts.py"
    ).read_text(encoding="utf-8")

    assert '"ft_arch"' not in contracts_source
    assert "modal_ft_arch_search" not in contracts_source
    assert not (ROOT / "ml-service" / "app" / "optuna_fttransformer_arch.py").exists()
    assert not (ROOT / "ml-service" / "app" / "ft_online_update.py").exists()


def test_retired_ft_transformer_has_no_dead_training_or_validation_helpers() -> None:
    models_source = (ROOT / "ml-service" / "app" / "models.py").read_text(encoding="utf-8")
    validation_source = (
        ROOT / "ml-service" / "app" / "model_validation.py"
    ).read_text(encoding="utf-8")
    universal_training_source = (
        ROOT / "ml-service" / "app" / "universal_training.py"
    ).read_text(encoding="utf-8")
    training_policy_source = (
        ROOT / "ml-service" / "app" / "training_policy.py"
    ).read_text(encoding="utf-8")
    retrain_trigger_source = (
        ROOT / "ml-controller" / "routers" / "retrain_trigger.py"
    ).read_text(encoding="utf-8")

    assert not (ROOT / "ml-service" / "app" / "ft_transformer.py").exists()

    retired_model_symbols = (
        "build_ft_transformer",
        "rebuild_ft_transformer_from_bundle",
        "rank_from_ft_regression_output",
        "run_ft_transformer",
        "fit_predict_ft_transformer_cpcv",
    )
    for symbol in retired_model_symbols:
        assert symbol not in models_source
        assert symbol not in validation_source
        assert symbol not in universal_training_source

    retired_training_tokens = (
        "_ftt_tensor_loader",
        "FT-Transformer CPCV",
        "FT-Transformer IC",
        "FT-Transformer degenerate",
        "FT-Transformer done",
        "FT-Transformer failed",
        "ftt_d_model",
        "ftt_n_heads",
        "ftt_n_layers",
        "ftt_dropout",
        "ftt_max_epochs",
        "ftt_lr",
        "ftt_patience",
        "ftt_batch_size",
        "ftt_margin",
    )
    for token in retired_training_tokens:
        assert token not in universal_training_source
        assert token not in training_policy_source
        assert token not in retrain_trigger_source


def test_retired_ft_transformer_is_absent_from_production_facing_ui_and_tracks() -> None:
    production_facing_paths = [
        ROOT / "frontend" / "src" / "components" / "StockAIReport.tsx",
        ROOT / "frontend" / "src" / "pages" / "StockReportPage.tsx",
        ROOT / "frontend" / "src" / "pages" / "ModelPoolPage.tsx",
        ROOT / "frontend" / "src" / "lib" / "modelUpgradeTrack.ts",
        ROOT / "worker" / "src" / "lib" / "modelUpgradeResearchTrack.ts",
        ROOT / "ml-service" / "app" / "chronos_universal.py",
        ROOT / "ml-service" / "app" / "training_policy.py",
        ROOT / "ml-service" / "app" / "prediction_runtime.py",
        ROOT / "ml-service" / "modal_app.py",
    ]
    for path in production_facing_paths:
        source = path.read_text(encoding="utf-8")
        for token in ("FT-Transformer", "FT-T", "tree/FT", "FT /", "LinUCB/FT"):
            assert token not in source


def test_legacy_topk_runtime_promotion_is_removed() -> None:
    pipeline_source = (ROOT / "ml-controller" / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    recommendation_source = (
        ROOT / "ml-controller" / "services" / "recommendation_service.py"
    ).read_text(encoding="utf-8")
    backtest_source = (ROOT / "ml-controller" / "services" / "backtest_engine.py").read_text(encoding="utf-8")
    optuna_screener_source = (ROOT / "ml-controller" / "optuna_scripts" / "optuna_screener.py").read_text(encoding="utf-8")
    trading_config_source = (ROOT / "worker" / "src" / "lib" / "tradingConfig.ts").read_text(encoding="utf-8")

    for token in ("topKOverrideEnabled", "allowLegacyTopKOverride", "topk_forced", "ensemble_v2_topk_policy"):
        assert token not in pipeline_source
        assert token not in trading_config_source
    assert "hybrid_ranking_promotion" not in pipeline_source
    assert "def hybrid_ranking_promotion" not in recommendation_source
    assert '"signal_source"] = "ranking_promotion"' not in recommendation_source
    assert "legacy_topk_allocation_retired" in recommendation_source
    assert 'rk.get("topK"' not in backtest_source
    assert '"topK"' not in optuna_screener_source
    assert "buy_signal_count" in backtest_source


def test_unreferenced_shadow_wrappers_are_removed_but_formal_benchmark_adapters_remain() -> None:
    requirements = (ROOT / "ml-service" / "requirements.txt").read_text(encoding="utf-8")
    universal_training = (ROOT / "ml-service" / "app" / "universal_training.py").read_text(encoding="utf-8")
    modal_app = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    modal_model_pool_router = (ROOT / "ml-controller" / "routers" / "model_pool.py").read_text(encoding="utf-8")
    service_model_pool = (ROOT / "ml-service" / "app" / "model_pool.py").read_text(encoding="utf-8")

    assert not (ROOT / "ml-service" / "app" / "gnn_shadow.py").exists()
    assert not (ROOT / "ml-service" / "app" / "rl_shadow.py").exists()
    assert not (ROOT / "ml-service" / "app" / "rl_env.py").exists()
    assert (ROOT / "ml-service" / "app" / "gnn_model.py").exists()
    assert "gymnasium" not in requirements
    assert "stable-baselines3" not in requirements
    assert "from .model_pool import register_challenger" not in universal_training
    assert "from app.model_pool import register_challenger" not in modal_app
    assert '@router.post("/register_challenger")' not in modal_model_pool_router
    assert '@router.post("/discard_challenger")' not in modal_model_pool_router
    assert "def register_challenger(" not in service_model_pool
    assert "def discard_challenger(" not in service_model_pool


def test_legacy_challenger_prediction_namespace_is_quarantined() -> None:
    allowed = ROOT / "ml-controller" / "services" / "legacy_prediction_namespace.py"
    scanned_roots = [
        ROOT / "ml-controller" / "services",
        ROOT / "ml-controller" / "routers",
        ROOT / "ml-service" / "app",
        ROOT / "worker" / "src",
    ]
    offenders: list[str] = []
    for base in scanned_roots:
        for path in base.rglob("*"):
            if path == allowed or path.suffix not in {".py", ".ts", ".tsx"}:
                continue
            source = path.read_text(encoding="utf-8")
            if "::challenger" in source:
                offenders.append(str(path.relative_to(ROOT)))
    assert offenders == []


def test_generated_shadow_research_json_snapshots_are_not_tracked_as_runtime_state() -> None:
    assert not (ROOT / "data" / "finlab_research" / "sector_flow_shadow_manifest.json").exists()
