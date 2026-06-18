from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import logging
import math
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import pandas as pd

from services import d1_client


APP_ROOT = Path(__file__).resolve().parent
ROOT = APP_ROOT if (APP_ROOT / "data" / "feature_registry").exists() else APP_ROOT.parent
TOOLS_DIR = ROOT / "tools"
DATA_DIR = ROOT / "data" / "feature_registry"
OUT_DIR = ROOT / "output" / "feature_universe_triage"
ALPHA_MINER = TOOLS_DIR / "finlab_alpha_miner_bakeoff.py"
FACTOR_JSON = DATA_DIR / "alphabuilders_factors_fresh.json"
UNIFIED_REGISTRY = DATA_DIR / "unified_feature_registry_v1.json"
MONTHLY_CONFIG = DATA_DIR / "pymoo_monthly_mining_config_v1.json"
PROMOTION_CONTRACT = DATA_DIR / "alpha_mining_promotion_contract_v1.json"
SIMILARITY_CONTRACT = DATA_DIR / "formal137_similarity_contract_v1.json"
SIMILARITY_PAIRS = OUT_DIR / "formal137_pairwise_similarity_long_20260617.csv"

LOGGER = logging.getLogger("strategy_mining_job")


def _json_default(value: Any) -> Any:
    if isinstance(value, float):
        return None if not math.isfinite(value) else value
    if hasattr(value, "item"):
        try:
            return value.item()
        except Exception:
            return str(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat()
    if isinstance(value, (set, tuple)):
        return list(value)
    return str(value)


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=_json_default, separators=(",", ":"))


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8-sig") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"json_contract_not_object:{path}")
    return data


def _load_alpha_miner():
    if not ALPHA_MINER.exists():
        raise RuntimeError(f"alpha_miner_missing:{ALPHA_MINER}")
    spec = importlib.util.spec_from_file_location("stockvision_strategy_mining_alpha_miner", ALPHA_MINER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"alpha_miner_load_failed:{ALPHA_MINER}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return float(raw)


def _bounded_int(value: int, bounds: list[Any] | tuple[Any, Any] | None, default_bounds: tuple[int, int]) -> int:
    lo, hi = default_bounds
    if bounds and len(bounds) >= 2:
        try:
            lo = int(bounds[0])
            hi = int(bounds[1])
        except (TypeError, ValueError):
            lo, hi = default_bounds
    if hi < lo:
        lo, hi = hi, lo
    return max(lo, min(hi, int(value)))


def _safe_float(value: Any) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if math.isfinite(out) else None


def _load_previous_completed_telemetry() -> dict[str, Any] | None:
    try:
        rows = d1_client.query(
            """
            SELECT run_id, run_date, config_json, telemetry_json, updated_at
            FROM strategy_mining_runs
            WHERE status = 'completed'
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            timeout=30.0,
        )
    except Exception as exc:
        LOGGER.warning("strategy mining adaptive telemetry read skipped: %s", exc)
        return None
    if not rows:
        return None
    row = rows[0]
    try:
        telemetry = json.loads(row.get("telemetry_json") or "{}")
    except Exception:
        telemetry = {}
    try:
        config = json.loads(row.get("config_json") or "{}")
    except Exception:
        config = {}
    return {
        "run_id": row.get("run_id"),
        "run_date": row.get("run_date"),
        "updated_at": row.get("updated_at"),
        "telemetry": telemetry if isinstance(telemetry, dict) else {},
        "config": config if isinstance(config, dict) else {},
    }


def _pbo_failure_rate(summary: dict[str, Any]) -> float | None:
    values: list[float] = []
    for algo_summary in summary.values():
        if not isinstance(algo_summary, dict):
            continue
        pbo = algo_summary.get("pbo")
        if isinstance(pbo, dict):
            value = _safe_float(pbo.get("pbo"))
            if value is not None:
                values.append(value)
    if not values:
        return None
    return sum(1.0 for value in values if value >= 0.50) / len(values)


def _median_summary_metric(summary: dict[str, Any], key: str) -> float | None:
    values: list[float] = []
    for algo_summary in summary.values():
        if not isinstance(algo_summary, dict):
            continue
        value = _safe_float(algo_summary.get(key))
        if value is not None:
            values.append(value)
    if not values:
        return None
    values.sort()
    mid = len(values) // 2
    if len(values) % 2:
        return values[mid]
    return (values[mid - 1] + values[mid]) / 2.0


def _apply_adaptive_mining_params(args: argparse.Namespace) -> argparse.Namespace:
    config = _load_json(MONTHLY_CONFIG)
    adaptive = config.get("adaptive_controller") if isinstance(config.get("adaptive_controller"), dict) else {}
    if adaptive.get("enabled_after_first_telemetry") is not True:
        args.adaptive_controller_applied = False
        args.adaptive_controller_reason = "disabled"
        return args

    previous = _load_previous_completed_telemetry()
    if not previous:
        args.adaptive_controller_applied = False
        args.adaptive_controller_reason = "no_previous_completed_telemetry"
        return args

    telemetry = previous.get("telemetry") or {}
    summary = telemetry.get("summary") if isinstance(telemetry.get("summary"), dict) else {}
    families = (
        telemetry.get("adaptive_strategy_families")
        if isinstance(telemetry.get("adaptive_strategy_families"), dict)
        else {}
    )
    accepted = int(families.get("eligible_count") or 0)
    family_count = int(families.get("family_count") or 0)
    evaluated = int(families.get("evaluated_count") or 0)
    runtime_seconds = float(telemetry.get("runtime_seconds") or 0.0)
    median_novelty = _median_summary_metric(summary, "median_top10_novelty")
    median_similarity_penalty = _median_summary_metric(summary, "median_top10_similarity_penalty")
    median_max_similarity = _median_summary_metric(summary, "median_top10_max_similarity")
    pbo_fail = _pbo_failure_rate(summary)

    pop = int(args.pymoo_population)
    gen = int(args.pymoo_generations)
    top_n = int(args.finlab_confirm_top_n)
    reasons: list[str] = []

    if accepted < 4 or family_count < 3:
        pop = int(round(pop * 1.25))
        gen += 1
        top_n += 2
        reasons.append("low_accepted_or_family_count")
    if median_novelty is not None and median_novelty < 0.20:
        pop = int(round(pop * 1.20))
        top_n += 2
        reasons.append("low_novelty")
    if median_max_similarity is not None and median_max_similarity >= 0.70:
        pop = int(round(pop * 1.15))
        reasons.append("high_similarity")
    if pbo_fail is not None and pbo_fail >= 0.50:
        gen = max(1, gen - 1)
        top_n = max(1, top_n - 2)
        reasons.append("high_pbo_failure")
    if runtime_seconds >= 7200:
        gen = max(1, gen - 1)
        top_n = max(1, top_n - 2)
        reasons.append("runtime_pressure")

    args.pymoo_population = _bounded_int(pop, adaptive.get("population_bounds"), (32, 128))
    args.pymoo_generations = _bounded_int(gen, adaptive.get("generation_bounds"), (4, 16))
    defaults = config.get("defaults") if isinstance(config.get("defaults"), dict) else {}
    top_n_bounds = defaults.get("finlab_confirm_top_n_bounds") or adaptive.get("finlab_confirm_top_n_bounds")
    args.finlab_confirm_top_n = _bounded_int(top_n, top_n_bounds, (6, 24))
    args.adaptive_controller_applied = True
    args.adaptive_controller_reason = ",".join(reasons) if reasons else "previous_telemetry_within_target"
    args.adaptive_controller_previous_run = {
        "run_id": previous.get("run_id"),
        "run_date": previous.get("run_date"),
        "updated_at": previous.get("updated_at"),
    }
    args.adaptive_controller_inputs = {
        "accepted_candidate_count": accepted,
        "family_count": family_count,
        "evaluated_count": evaluated,
        "median_novelty": median_novelty,
        "median_similarity_penalty": median_similarity_penalty,
        "median_max_similarity": median_max_similarity,
        "pbo_failure_rate": pbo_fail,
        "runtime_seconds": runtime_seconds,
    }
    args.adaptive_controller_outputs = {
        "pymoo_population": args.pymoo_population,
        "pymoo_generations": args.pymoo_generations,
        "finlab_confirm_top_n": args.finlab_confirm_top_n,
    }
    return args


def _now_tw() -> datetime:
    return datetime.now(ZoneInfo("Asia/Taipei"))


def _run_date() -> str:
    raw = os.environ.get("STRATEGY_MINING_RUN_DATE", "").strip()
    if raw:
        datetime.strptime(raw, "%Y-%m-%d")
        return raw
    return _now_tw().date().isoformat()


def _build_args(alpha: Any, *, run_date: str, output_dir: Path) -> argparse.Namespace:
    end_date = os.environ.get("STRATEGY_MINING_END_DATE", "").strip() or run_date
    start_date = os.environ.get("STRATEGY_MINING_START_DATE", "").strip() or "2023-01-01"
    args = argparse.Namespace(
        factor_json=str(FACTOR_JSON),
        factor_universe="unified_registry_v1",
        feature_registry=str(UNIFIED_REGISTRY),
        monthly_mining_config=str(MONTHLY_CONFIG),
        similarity_contract=str(SIMILARITY_CONTRACT),
        similarity_pairs=str(SIMILARITY_PAIRS),
        disable_monthly_mining_config=False,
        algorithm="pymoo",
        start_date=start_date,
        end_date=end_date,
        train_start=os.environ.get("STRATEGY_MINING_TRAIN_START", "2023-01-01"),
        train_end=os.environ.get("STRATEGY_MINING_TRAIN_END", "2024-12-31"),
        validation_start=os.environ.get("STRATEGY_MINING_VALIDATION_START", "2025-01-01"),
        validation_end=os.environ.get("STRATEGY_MINING_VALIDATION_END", "2025-12-31"),
        holdout_start=os.environ.get("STRATEGY_MINING_HOLDOUT_START", "2026-01-01"),
        holdout_end=os.environ.get("STRATEGY_MINING_HOLDOUT_END", end_date),
        universe=os.environ.get("STRATEGY_MINING_UNIVERSE", "sii"),
        top_k=_env_int("STRATEGY_MINING_TOP_K", 10),
        max_symbols=_env_int("STRATEGY_MINING_MAX_SYMBOLS", 0),
        min_factors=2,
        max_factors=8,
        fee_tax_cost=_env_float("STRATEGY_MINING_FEE_TAX_COST", 0.004425),
        seed=_env_int("STRATEGY_MINING_SEED", 42),
        random_trials=0,
        optuna_trials=0,
        deap_population=0,
        deap_generations=0,
        pymoo_population=48,
        pymoo_generations=6,
        finlab_confirm_top_n=8,
        pbo_folds=8,
        promote_min_validation_sharpe=1.0,
        promote_min_holdout_sharpe=1.0,
        promote_min_full_cagr=0.0,
        promote_max_full_drawdown=0.35,
        promote_max_turnover=0.95,
        promote_min_deflated_sharpe_probability=0.95,
        promote_family_factor_jaccard=0.50,
        promote_family_category_jaccard=0.67,
        resample=os.environ.get("STRATEGY_MINING_RESAMPLE", "M"),
        position_limit=_env_float("STRATEGY_MINING_POSITION_LIMIT", 0.10),
        trade_at_price=os.environ.get("STRATEGY_MINING_TRADE_AT_PRICE", "close"),
        output_dir=str(output_dir),
    )
    args = alpha._apply_monthly_mining_config(args)
    args = _apply_adaptive_mining_params(args)

    # Environment overrides are intentionally applied after monthly config and adaptive params.
    for env_name, attr, caster in [
        ("STRATEGY_MINING_PYMOO_POPULATION", "pymoo_population", int),
        ("STRATEGY_MINING_PYMOO_GENERATIONS", "pymoo_generations", int),
        ("STRATEGY_MINING_MIN_FACTORS", "min_factors", int),
        ("STRATEGY_MINING_MAX_FACTORS", "max_factors", int),
        ("STRATEGY_MINING_FINLAB_CONFIRM_TOP_N", "finlab_confirm_top_n", int),
        ("STRATEGY_MINING_PBO_FOLDS", "pbo_folds", int),
        ("STRATEGY_MINING_PROMOTE_MIN_VALIDATION_SHARPE", "promote_min_validation_sharpe", float),
        ("STRATEGY_MINING_PROMOTE_MIN_HOLDOUT_SHARPE", "promote_min_holdout_sharpe", float),
        ("STRATEGY_MINING_PROMOTE_MAX_FULL_DRAWDOWN", "promote_max_full_drawdown", float),
        ("STRATEGY_MINING_PROMOTE_MAX_TURNOVER", "promote_max_turnover", float),
    ]:
        raw = os.environ.get(env_name, "").strip()
        if raw:
            setattr(args, attr, caster(raw))
    return args


def _assert_runtime_files() -> None:
    required = [
        ALPHA_MINER,
        FACTOR_JSON,
        UNIFIED_REGISTRY,
        MONTHLY_CONFIG,
        PROMOTION_CONTRACT,
        SIMILARITY_CONTRACT,
        SIMILARITY_PAIRS,
        ROOT / "tools" / "finlab_alphabuilders_factor_backtest.py",
        ROOT / "tools" / "finlab_strategy_spec_backtest.py",
        ROOT / "tools" / "feature_strategy_overlap_numeric.py",
        ROOT / "output" / "finlab_ml_feature_backtests" / "ml106_features_sii_20230101_20260615_top10_bothdir_best.csv",
        ROOT / "output" / "finlab_strategy95_backtests" / "strategy95_factors_sii_20230101_20260615_top10_bothdir_best.csv",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError(f"strategy_mining_runtime_files_missing:{missing}")


def _login_finlab() -> None:
    api_key = os.environ.get("FINLAB_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("FINLAB_API_KEY_missing_for_strategy_mining")
    from finlab import login

    login(api_key)


def _ledger_candidate_id(run_id: str, raw_candidate_id: str) -> str:
    safe_raw = raw_candidate_id.replace(":", "_").replace("/", "_").strip()
    return f"{run_id}__{safe_raw}"


def _family_maps(report: dict[str, Any]) -> tuple[dict[str, str], set[str], dict[str, dict[str, Any]]]:
    candidate_to_family: dict[str, str] = {}
    representative_ids: set[str] = set()
    family_packets: dict[str, dict[str, Any]] = {}
    families = ((report.get("adaptive_strategy_families") or {}).get("families") or [])
    for family in families:
        if not isinstance(family, dict):
            continue
        family_id = str(family.get("family_id") or "")
        for member in family.get("members") or []:
            candidate_to_family[str(member)] = family_id
        rep = family.get("representative") or {}
        raw_id = str(rep.get("candidate_id") or "")
        if raw_id:
            representative_ids.add(raw_id)
            family_packets[raw_id] = family
    return candidate_to_family, representative_ids, family_packets


def _confirm_raw_candidate_id(confirm: dict[str, Any]) -> str:
    raw = str(confirm.get("id") or "")
    return raw[len("alpha_miner_") :] if raw.startswith("alpha_miner_") else raw


def _ranked_rows(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    def key(row: dict[str, Any]) -> tuple[int, float]:
        ok = 1 if row.get("status") == "ok" else 0
        return ok, float(row.get("fitness") or -999.0)

    return sorted(rows, key=key, reverse=True)[:limit]


def _insert_run(run_id: str, run_date: str, cadence: str, args: argparse.Namespace) -> None:
    registry = _load_json(UNIFIED_REGISTRY)
    promotion = _load_json(PROMOTION_CONTRACT)
    feature_pool = promotion.get("feature_pool_policy") or {}
    role_counts = feature_pool.get("selector_role_counts") or {}
    d1_client.execute(
        """
        INSERT OR REPLACE INTO strategy_mining_runs (
          run_id, run_date, cadence, algorithm, feature_registry_version,
          feature_pool_count, core_prior_count, evidence_watch_count,
          config_json, telemetry_json, status, decision_effect, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'research_only', CURRENT_TIMESTAMP)
        """,
        [
            run_id,
            run_date,
            cadence,
            "pymoo_nsga3_novelty",
            str(registry.get("schema_version") or "unified_feature_registry_v1"),
            int(feature_pool.get("eligible_for_alpha_mining") or 0),
            int(role_counts.get("core_prior") or 0),
            int(role_counts.get("evidence_watch") or 0),
            _json_dumps(vars(args)),
            _json_dumps({"started_at": _now_tw().isoformat()}),
        ],
        timeout=60.0,
    )


def _update_run(run_id: str, *, status: str, telemetry: dict[str, Any]) -> None:
    d1_client.execute(
        """
        UPDATE strategy_mining_runs
        SET status = ?, telemetry_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ?
        """,
        [status, _json_dumps(telemetry), run_id],
        timeout=60.0,
    )


def _persist_candidates(run_id: str, report: dict[str, Any]) -> dict[str, Any]:
    candidate_to_family, representative_ids, _family_packets = _family_maps(report)
    confirm_ids = {_confirm_raw_candidate_id(row) for row in report.get("finlab_confirm") or [] if isinstance(row, dict)}
    rows = [row for row in report.get("rows") or [] if isinstance(row, dict)]
    max_candidates = _env_int("STRATEGY_MINING_LEDGER_MAX_CANDIDATES", 300)
    selected = _ranked_rows(rows, max_candidates)
    statements: list[tuple[str, list[Any]]] = []
    for row in selected:
        raw_id = str(row.get("candidate_id") or "")
        if not raw_id:
            continue
        validation_status = "not_ok"
        if row.get("status") == "ok":
            validation_status = "finlab_confirmed" if raw_id in confirm_ids else "pymoo_ok"
        promotion_state = "challenger_candidate" if raw_id in representative_ids else "research_candidate"
        metrics = {
            key: row.get(key)
            for key in [
                "status",
                "fitness",
                "complexity",
                "turnover",
                "base_novelty",
                "novelty",
                "similarity_novelty_penalty",
                "similarity_novelty_bonus",
                "max_internal_similarity",
                "max_archive_similarity",
                "max_similarity",
                "deflated_sharpe_proxy",
                "deflated_sharpe",
                "fold_sharpes",
                "train",
                "validation",
                "holdout",
                "full",
                "latest_matches",
                "match_days",
            ]
        }
        metrics["raw_candidate_id"] = raw_id
        statements.append(
            (
                """
                INSERT OR REPLACE INTO strategy_mining_candidates (
                  candidate_id, run_id, algorithm, factor_ids_json, factor_weights_json,
                  family_id, novelty_score, similarity_penalty, max_pairwise_similarity,
                  validation_status, promotion_state, decision_effect, metrics_json, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, CURRENT_TIMESTAMP)
                """,
                [
                    _ledger_candidate_id(run_id, raw_id),
                    run_id,
                    str(row.get("algorithm") or "pymoo_nsga3_novelty"),
                    _json_dumps(row.get("factor_ids") or []),
                    _json_dumps(row.get("weights") or []),
                    candidate_to_family.get(raw_id),
                    _safe_float(row.get("novelty")),
                    _safe_float(row.get("similarity_novelty_penalty")),
                    _safe_float(row.get("max_similarity")),
                    validation_status,
                    promotion_state,
                    _json_dumps(metrics),
                ],
            )
        )
    result = d1_client.batch_execute(statements, timeout=60.0, chunk_size=50)
    return {"selected": len(selected), "batch": result}


def _persist_backtests(run_id: str, report: dict[str, Any]) -> dict[str, Any]:
    candidate_by_raw = {
        str(row.get("candidate_id")): row
        for row in report.get("rows") or []
        if isinstance(row, dict) and row.get("candidate_id")
    }
    statements: list[tuple[str, list[Any]]] = []
    config = report.get("config") or {}
    for confirm in report.get("finlab_confirm") or []:
        if not isinstance(confirm, dict):
            continue
        raw_id = _confirm_raw_candidate_id(confirm)
        source_row = candidate_by_raw.get(raw_id) or {}
        dsr = ((source_row.get("deflated_sharpe") or {}).get("probability") if isinstance(source_row, dict) else None)
        evidence = {
            "confirm": confirm,
            "candidate_metrics": {
                "validation": source_row.get("validation"),
                "holdout": source_row.get("holdout"),
                "full": source_row.get("full"),
                "fitness": source_row.get("fitness"),
                "raw_candidate_id": raw_id,
            },
        }
        statements.append(
            (
                """
                INSERT INTO strategy_backtest_results (
                  candidate_id, run_id, source, start_date, end_date, cagr,
                  sharpe, max_drawdown, calmar, turnover, pbo,
                  deflated_sharpe_probability, decision, evidence_json
                ) VALUES (?, ?, 'finlab', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'research_only', ?)
                """,
                [
                    _ledger_candidate_id(run_id, raw_id),
                    run_id,
                    config.get("start_date"),
                    config.get("end_date"),
                    _safe_float(confirm.get("cagr")),
                    _safe_float(confirm.get("monthly_sharpe")),
                    _safe_float(confirm.get("max_drawdown")),
                    _safe_float(confirm.get("calmar")),
                    _safe_float(confirm.get("avg_turnover_proxy")),
                    None,
                    _safe_float(dsr),
                    _json_dumps(evidence),
                ],
            )
        )
    result = d1_client.batch_execute(statements, timeout=60.0, chunk_size=50)
    return {"selected": len(statements), "batch": result}


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 0.0
    union = left | right
    return float(len(left & right) / len(union)) if union else 0.0


def _persist_candidate_similarity(run_id: str, report: dict[str, Any]) -> dict[str, Any]:
    rows = _ranked_rows([row for row in report.get("rows") or [] if isinstance(row, dict)], 50)
    statements: list[tuple[str, list[Any]]] = []
    for i, left in enumerate(rows):
        left_raw = str(left.get("candidate_id") or "")
        left_factors = {str(fid) for fid in (left.get("factor_ids") or [])}
        if not left_raw:
            continue
        for right in rows[i + 1 :]:
            right_raw = str(right.get("candidate_id") or "")
            right_factors = {str(fid) for fid in (right.get("factor_ids") or [])}
            if not right_raw:
                continue
            sim = _jaccard(left_factors, right_factors)
            if sim <= 0:
                continue
            statements.append(
                (
                    """
                    INSERT OR REPLACE INTO strategy_similarity_matrix (
                      run_id, left_id, right_id, similarity, similarity_method, feature_overlap
                    ) VALUES (?, ?, ?, ?, 'candidate_factor_jaccard', ?)
                    """,
                    [
                        run_id,
                        _ledger_candidate_id(run_id, left_raw),
                        _ledger_candidate_id(run_id, right_raw),
                        sim,
                        sim,
                    ],
                )
            )
    result = d1_client.batch_execute(statements, timeout=60.0, chunk_size=100)
    return {"selected": len(statements), "batch": result}


def _persist_promotion_packets(run_id: str, report: dict[str, Any]) -> dict[str, Any]:
    _candidate_to_family, representative_ids, family_packets = _family_maps(report)
    statements: list[tuple[str, list[Any]]] = []
    for raw_id in sorted(representative_ids):
        packet = family_packets.get(raw_id) or {}
        statements.append(
            (
                """
                INSERT OR REPLACE INTO strategy_promotion_ledger (
                  ledger_id, candidate_id, run_id, from_state, to_state, decision,
                  failed_gates_json, packet_json, real_trading_effect
                ) VALUES (?, ?, ?, 'research_candidate', 'challenger_candidate',
                  'auto_research_gate_passed_pending_review', '[]', ?, 'none')
                """,
                [
                    f"{run_id}__{raw_id}__challenger_packet",
                    _ledger_candidate_id(run_id, raw_id),
                    run_id,
                    _json_dumps(packet),
                ],
            )
        )
    result = d1_client.batch_execute(statements, timeout=60.0, chunk_size=50)
    return {"selected": len(statements), "batch": result}


def _write_artifacts(run_id: str, output_dir: Path, report: dict[str, Any]) -> dict[str, Any]:
    output_dir.mkdir(parents=True, exist_ok=True)
    json_path = output_dir / f"{run_id}.json"
    rows_path = output_dir / f"{run_id}_rows.csv"
    confirm_path = output_dir / f"{run_id}_finlab_confirm.csv"
    summary_path = output_dir / f"{run_id}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    pd.DataFrame(report.get("rows") or []).to_csv(rows_path, index=False, encoding="utf-8-sig")
    pd.DataFrame(report.get("finlab_confirm") or []).to_csv(confirm_path, index=False, encoding="utf-8-sig")
    summary_payload = {
        "run_id": run_id,
        "summary": report.get("summary"),
        "adaptive_strategy_families": report.get("adaptive_strategy_families"),
        "factor_universe": {
            key: value
            for key, value in (report.get("factor_universe") or {}).items()
            if key not in {"factor_meta", "ab_mapping"}
        },
        "runtime_seconds": report.get("runtime_seconds"),
    }
    summary_path.write_text(json.dumps(summary_payload, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    local = {
        "json": str(json_path),
        "rows_csv": str(rows_path),
        "finlab_confirm_csv": str(confirm_path),
        "summary_json": str(summary_path),
    }
    bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
    if not bucket_name:
        return {"local": local, "gcs": {}, "gcs_status": "skipped_no_bucket"}
    from google.cloud import storage

    run_date = str((report.get("config") or {}).get("end_date") or "unknown")
    prefix = f"strategy_mining/monthly/{run_date}/{run_id}"
    bucket = storage.Client().bucket(bucket_name)
    gcs: dict[str, str] = {}
    for label, path_text in local.items():
        path = Path(path_text)
        blob_name = f"{prefix}/{path.name}"
        content_type = "application/json" if path.suffix == ".json" else "text/csv"
        bucket.blob(blob_name).upload_from_filename(str(path), content_type=content_type)
        gcs[label] = f"gs://{bucket_name}/{blob_name}"
    return {"local": local, "gcs": gcs, "gcs_status": "uploaded"}


def _persist_ledger(run_id: str, report: dict[str, Any]) -> dict[str, Any]:
    if not _env_bool("STRATEGY_MINING_PERSIST", True):
        return {"status": "skipped", "reason": "STRATEGY_MINING_PERSIST=false"}
    return {
        "candidates": _persist_candidates(run_id, report),
        "backtests": _persist_backtests(run_id, report),
        "candidate_similarity": _persist_candidate_similarity(run_id, report),
        "promotion_packets": _persist_promotion_packets(run_id, report),
    }


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    started = time.time()
    run_date = _run_date()
    cadence = os.environ.get("STRATEGY_MINING_CADENCE", "monthly").strip() or "monthly"
    if cadence != "monthly":
        raise RuntimeError(f"unsupported_strategy_mining_cadence:{cadence}")

    run_id = os.environ.get("STRATEGY_MINING_RUN_ID", "").strip()
    if not run_id:
        run_id = f"strategy-mining-{run_date}-{_now_tw().strftime('%Y%m%d%H%M%S')}"
    output_dir = Path(os.environ.get("STRATEGY_MINING_OUTPUT_DIR", "") or f"/tmp/strategy_mining/{run_id}")

    LOGGER.info("strategy mining job starting run_id=%s run_date=%s", run_id, run_date)
    _assert_runtime_files()
    _login_finlab()
    alpha = _load_alpha_miner()
    args = _build_args(alpha, run_date=run_date, output_dir=output_dir)
    _insert_run(run_id, run_date, cadence, args)

    try:
        report = alpha.run(args)
        report["job"] = {
            "run_id": run_id,
            "run_date": run_date,
            "cadence": cadence,
            "trigger_source": os.environ.get("STRATEGY_MINING_TRIGGER_SOURCE", ""),
            "started_at": datetime.fromtimestamp(started, tz=ZoneInfo("Asia/Taipei")).isoformat(),
        }
        artifacts = _write_artifacts(run_id, output_dir, report)
        ledger = _persist_ledger(run_id, report)
        telemetry = {
            "completed_at": _now_tw().isoformat(),
            "runtime_seconds": round(time.time() - started, 3),
            "artifact_paths": artifacts,
            "ledger": ledger,
            "summary": report.get("summary"),
            "adaptive_strategy_families": report.get("adaptive_strategy_families"),
            "factor_universe_summary": {
                key: value
                for key, value in (report.get("factor_universe") or {}).items()
                if key not in {"factor_ids", "factor_meta", "ab_mapping"}
            },
        }
        _update_run(run_id, status="completed", telemetry=telemetry)
        print(json.dumps({"status": "completed", "run_id": run_id, **telemetry}, ensure_ascii=False, default=_json_default))
        return 0
    except Exception as exc:
        telemetry = {
            "failed_at": _now_tw().isoformat(),
            "runtime_seconds": round(time.time() - started, 3),
            "error_type": type(exc).__name__,
            "error": str(exc),
        }
        try:
            _update_run(run_id, status="error", telemetry=telemetry)
        except Exception:
            LOGGER.exception("failed to update strategy mining error status")
        LOGGER.exception("strategy mining job failed run_id=%s", run_id)
        print(json.dumps({"status": "error", "run_id": run_id, **telemetry}, ensure_ascii=False, default=_json_default))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
