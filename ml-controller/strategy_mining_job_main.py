from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import logging
import math
import os
import signal
import sys
import time
from datetime import date, timedelta
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pandas as pd

from services.d1_domain_client import D1DataDomain, client_for_domain


class _ResearchD1ClientProxy:
    """Mutable compatibility seam that resolves the Research route per call."""

    def query(self, *args: Any, **kwargs: Any) -> list[dict]:
        return client_for_domain(D1DataDomain.RESEARCH).query(*args, **kwargs)

    def execute(self, *args: Any, **kwargs: Any) -> dict:
        return client_for_domain(D1DataDomain.RESEARCH).execute(*args, **kwargs)

    def batch_execute(self, *args: Any, **kwargs: Any) -> dict:
        return client_for_domain(D1DataDomain.RESEARCH).batch_execute(*args, **kwargs)


d1_client = _ResearchD1ClientProxy()
from services.finlab_auth import login_finlab_sdk
from services.strategy_mining_evidence import build_strategy_mining_evidence


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
STRATEGY_FEATURE_REF_CONTRACT = DATA_DIR / "strategy_feature_ref_contract_v1.json"
# Worker D1 gateway rejects any string parameter longer than this (strategyMiningGateway.ts).
D1_MAX_STRING_PARAM_CHARS = 300_000
# Calendar days of history loaded so the rolling train+validation+holdout windows (plus feature
# warm-up) fit: 504+252+126 sessions + 2x(21+5) gap ~= 934 sessions (~3.8y) + ~270 sessions of
# warm-up for 252-session features ~= 1800 calendar days.
DEFAULT_HISTORY_CALENDAR_DAYS = 1800

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


def _callback_worker_scheduler(payload: dict[str, Any]) -> dict[str, Any]:
    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip().rstrip("/")
    worker_auth = os.environ.get("STRATEGY_MINING_CALLBACK_TOKEN", "").strip()
    if not worker_url:
        raise RuntimeError("STOCKVISION_WORKER_URL missing; strategy mining callback cannot close")
    if not worker_auth:
        raise RuntimeError("STRATEGY_MINING_CALLBACK_TOKEN missing; strategy mining callback cannot close")

    body = _json_dumps(payload).encode("utf-8")
    url = f"{worker_url}/api/internal/strategy-mining/callback"
    headers = {
        "Authorization": f"Bearer {worker_auth}",
        "Content-Type": "application/json",
        "User-Agent": "StockVision-Strategy-Mining/1.0",
    }
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            response = httpx.post(
                url,
                headers=headers,
                content=body,
                timeout=15.0,
            )
            status_code = int(response.status_code)
            response_text = response.text[:300]
            if status_code != 200:
                raise RuntimeError(f"strategy mining callback HTTP {status_code}: {response_text}")
            return {
                "attempted": True,
                "ok": True,
                "attempt": attempt,
                "status_code": status_code,
            }
        except Exception as exc:  # noqa: BLE001 - bounded retry, then fail closed.
            last_error = exc
            if attempt < 3:
                time.sleep(float(attempt))
    raise RuntimeError(f"strategy mining callback failed after 3 attempts: {last_error}") from last_error


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


# run_date lower bound for history reads: keeps them on idx_strategy_mining_runs_date (mining began 2026-06-17).
MINING_HISTORY_FLOOR_DATE = "2026-01-01"


def _load_previous_completed_telemetry() -> dict[str, Any] | None:
    # A task retry of a run that already completed must not tune itself from its own row (that
    # would search a different family on the same holdout), so the current run_id is excluded.
    current_run_id = os.environ.get("STRATEGY_MINING_RUN_ID", "").strip()
    try:
        rows = d1_client.query(
            """
            SELECT run_id, run_date, config_json, telemetry_json, updated_at
            FROM strategy_mining_runs
            WHERE run_date >= ? AND status = 'completed' AND run_id != ?
            ORDER BY updated_at DESC
            LIMIT 1
            """,
            [MINING_HISTORY_FLOOR_DATE, current_run_id],
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


def _summed(ledgers: list[dict[str, Any]], key: str) -> Any:
    # Attempts of one run_id are summed, not maxed: a retry can search a different family (another
    # env override, a data refresh) on the same holdout, so over-counting is the safe side.
    values = [_safe_float(item.get(key)) for item in ledgers]
    values = [value for value in values if value is not None]
    return sum(values) if values else None


# Rows written with this protocol record search_started_at before the miner runs, so a failed attempt
# without the marker provably tested nothing. Older rows without a ledger stay "incomplete".
ATTEMPT_PROTOCOL = "search-marker-v1"

# Runs up to this date predate the multiple-testing ledger (config holdout_not_before = 2026-11-08).
LEGACY_LEDGER_LAST_RUN_DATE = "2026-11-07"


def _prior_multiple_testing_runs(*, current_run_id: str) -> list[dict[str, Any]]:
    """Every earlier completed run's search family, so DSR/Holm count trials across months.

    New runs persist `multiple_testing_ledger` (selection window, raw + effective trials, holdout
    family). Legacy runs (<= 2026-11-07) predate it: their config windows and evaluated_count are
    used, with selection_end = holdout_end because those runs optimised and gated on the holdout.
    A non-legacy run that errored or never finished (status error/running, e.g. SIGTERM/SIGKILL
    after its holdout was opened) without a persisted ledger is marked incomplete when its search
    had started (search_started_at, or a row written before ATTEMPT_PROTOCOL recorded the marker):
    its family is unknown, so promotion is blocked instead of
    silently shrinking the Holm/DSR family. An attempt that failed before the search tested nothing
    and counts only its earlier attempts' ledgers. Task retries of one run_id are summed.
    Raises on read failure; the caller turns that into a promotion-blocking gate.
    """
    rows = d1_client.query(
        """
        SELECT run_id, run_date, status, config_json, telemetry_json
        FROM strategy_mining_runs
        WHERE run_date >= ? AND status IN ('completed', 'error', 'running') AND run_id != ?
        ORDER BY run_date
        """,
        # The run_date floor turns the read into an index SEARCH (no SCAN); mining began 2026-06-17.
        [MINING_HISTORY_FLOOR_DATE, current_run_id],
        timeout=60.0,
    )
    out: list[dict[str, Any]] = []
    for row in rows or []:
        try:
            telemetry = json.loads(row.get("telemetry_json") or "{}")
            config = json.loads(row.get("config_json") or "{}")
        except Exception:
            telemetry, config = {}, {}
        telemetry = telemetry if isinstance(telemetry, dict) else {}
        if telemetry.get("previous_attempt_incomplete"):
            out.append({"run_id": row.get("run_id"), "run_date": row.get("run_date"), "incomplete": True})
            continue
        ledger = telemetry.get("multiple_testing_ledger")
        earlier = [item for item in _attempt_ledgers(telemetry, include_current=False) if item.get("selection_start")]
        if not (isinstance(ledger, dict) and ledger.get("selection_start")):
            ledger = None
            if (
                row.get("status") != "completed"
                and telemetry.get("attempt_protocol") == ATTEMPT_PROTOCOL
                and not telemetry.get("search_started_at")
            ):
                # This attempt failed before the search (preflight, data load), so it tested nothing;
                # only earlier attempts of the run count.
                if earlier:
                    ledger = earlier[-1]
                else:
                    continue
        if ledger is not None:
            attempts = [ledger, *[item for item in earlier if item is not ledger]]
            out.append({
                "run_id": row.get("run_id"),
                "selection_start": ledger.get("selection_start"),
                "selection_end": ledger.get("selection_end"),
                "holdout_start": ledger.get("holdout_start"),
                "holdout_end": ledger.get("holdout_end"),
                "search_trials_raw": _summed(attempts, "search_trials_raw"),
                "search_trials_effective": _summed(attempts, "search_trials_effective"),
                "holdout_family_size": _summed(attempts, "holdout_family_size"),
                "attempts": len(attempts),
            })
            continue
        if row.get("status") != "completed":
            if str(row.get("run_date") or "") > LEGACY_LEDGER_LAST_RUN_DATE or telemetry.get("attempt_protocol"):
                out.append({"run_id": row.get("run_id"), "run_date": row.get("run_date"), "incomplete": True})
            # Legacy (<= 2026-11-07) error/orphan runs predate the ledger and stay uncountable.
            continue
        families = (telemetry or {}).get("adaptive_strategy_families") or {}
        evaluated = int(_safe_float(families.get("evaluated_count")) or 0)
        if not evaluated or not config.get("train_start"):
            out.append({"run_id": row.get("run_id"), "incomplete": True})
            continue
        out.append({
            "run_id": row.get("run_id"),
            "selection_start": config.get("train_start"),
            "selection_end": config.get("holdout_end") or config.get("end_date"),
            "holdout_start": config.get("holdout_start"),
            "holdout_end": config.get("holdout_end") or config.get("end_date"),
            "search_trials_raw": evaluated,
            "search_trials_effective": None,
            # Legacy runs tested every evaluated candidate on the holdout.
            "holdout_family_size": evaluated,
            "legacy": True,
        })
    return out


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

    # Start from what the PREVIOUS run actually used, not from the static defaults. Starting from
    # the defaults made the controller a fixed point: identical telemetry (0 accepted) produced the
    # identical 69/6/8 every month, so it never explored further.
    previous_config = previous.get("config") or {}
    # Start from the controller's own pre-override values: a one-off env override (e.g. a smoke run
    # with a tiny population) must not become next month's starting point.
    pre_override = previous_config.get("pre_env_override_params")
    if isinstance(pre_override, dict):
        previous_config = {**previous_config, **{k: v for k, v in pre_override.items() if v is not None}}
    overridden = [str(item) for item in previous_config.get("env_overrides_applied") or []]
    if overridden:
        # The previous run's telemetry came from parameters the controller did not choose (a smoke
        # or manual run), so it is not feedback on them: carry the pre-override values unchanged.
        for attr in ("pymoo_population", "pymoo_generations", "pymoo_labeler_population", "finlab_confirm_top_n"):
            value = _safe_float((pre_override or {}).get(attr)) if isinstance(pre_override, dict) else None
            if value is not None:
                setattr(args, attr, int(value))
        args.adaptive_controller_applied = False
        args.adaptive_controller_reason = "previous_run_env_overridden_no_feedback"
        args.adaptive_controller_previous_run = {
            "run_id": previous.get("run_id"),
            "run_date": previous.get("run_date"),
            "env_overrides_applied": overridden,
        }
        return args
    pop = int(_safe_float(previous_config.get("pymoo_population")) or args.pymoo_population)
    gen = int(_safe_float(previous_config.get("pymoo_generations")) or args.pymoo_generations)
    top_n = int(_safe_float(previous_config.get("finlab_confirm_top_n")) or args.finlab_confirm_top_n)
    labeler_pop = int(_safe_float(previous_config.get("pymoo_labeler_population")) or args.pymoo_labeler_population)
    reasons: list[str] = []

    if accepted < 4 or family_count < 3:
        pop = int(round(pop * 1.25))
        labeler_pop = int(round(labeler_pop * 1.25))
        gen += 1
        top_n += 2
        reasons.append("low_accepted_or_family_count")
    elif accepted >= 12 and family_count >= 6:
        # Plenty of survivors: shrink the search (every extra trial raises the DSR hurdle).
        pop = int(round(pop * 0.85))
        labeler_pop = int(round(labeler_pop * 0.85))
        reasons.append("ample_accepted_shrink_search")
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
    args.pymoo_labeler_population = _bounded_int(labeler_pop, adaptive.get("population_bounds"), (32, 128))
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
        "previous_outputs": {
            "pymoo_population": previous_config.get("pymoo_population"),
            "pymoo_generations": previous_config.get("pymoo_generations"),
            "pymoo_labeler_population": previous_config.get("pymoo_labeler_population"),
            "finlab_confirm_top_n": previous_config.get("finlab_confirm_top_n"),
        },
    }
    args.adaptive_controller_outputs = {
        "pymoo_population": args.pymoo_population,
        "pymoo_labeler_population": args.pymoo_labeler_population,
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
    start_date = os.environ.get("STRATEGY_MINING_START_DATE", "").strip() or (
        date.fromisoformat(end_date) - timedelta(days=DEFAULT_HISTORY_CALENDAR_DAYS)
    ).isoformat()
    # Rolling walk-forward windows come from research_protocol. Fixed windows only when asked.
    window_mode = os.environ.get("STRATEGY_MINING_WINDOW_MODE", "").strip() or "rolling"
    seed_raw = os.environ.get("STRATEGY_MINING_SEED", "").strip()
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
        train_start=os.environ.get("STRATEGY_MINING_TRAIN_START") or None,
        train_end=os.environ.get("STRATEGY_MINING_TRAIN_END") or None,
        validation_start=os.environ.get("STRATEGY_MINING_VALIDATION_START") or None,
        validation_end=os.environ.get("STRATEGY_MINING_VALIDATION_END") or None,
        holdout_start=os.environ.get("STRATEGY_MINING_HOLDOUT_START") or None,
        holdout_end=os.environ.get("STRATEGY_MINING_HOLDOUT_END") or None,
        research_protocol_override={"window_mode": window_mode},
        universe=os.environ.get("STRATEGY_MINING_UNIVERSE", "sii"),
        top_k=_env_int("STRATEGY_MINING_TOP_K", 10),
        max_symbols=_env_int("STRATEGY_MINING_MAX_SYMBOLS", 0),
        min_factors=2,
        max_factors=8,
        # Seed derives from the run date (recorded); a fixed 42 replayed the same search monthly.
        seed=int(seed_raw) if seed_raw else alpha._seed_from_date(end_date),
        seed_source="env:STRATEGY_MINING_SEED" if seed_raw else f"sha256(run end_date={end_date})",
        random_trials=0,
        optuna_trials=0,
        deap_population=0,
        deap_generations=0,
        pymoo_population=48,
        pymoo_generations=6,
        pymoo_search_mode="top_k_v1",
        pymoo_labeler_population=32,
        pymoo_labeler_generations=4,
        labeler_min_percentile=0.55,
        labeler_max_percentile=0.85,
        finlab_confirm_top_n=8,
        pbo_folds=8,
        pbo_embargo_sessions=_env_int("STRATEGY_MINING_PBO_EMBARGO_SESSIONS", 5),
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
    # The pre-override values are recorded so the next month's controller starts from them.
    args.pre_env_override_params = {
        attr: getattr(args, attr, None)
        for attr in ("pymoo_population", "pymoo_generations", "pymoo_labeler_population", "finlab_confirm_top_n")
    }
    # Scale/window knobs read directly above also make a run unrepresentative for the controller.
    args.env_overrides_applied = [
        name for name in (
            "STRATEGY_MINING_START_DATE", "STRATEGY_MINING_END_DATE",
            "STRATEGY_MINING_TRAIN_START", "STRATEGY_MINING_TRAIN_END", "STRATEGY_MINING_VALIDATION_START",
            "STRATEGY_MINING_VALIDATION_END", "STRATEGY_MINING_HOLDOUT_START", "STRATEGY_MINING_HOLDOUT_END",
            "STRATEGY_MINING_UNIVERSE", "STRATEGY_MINING_TOP_K", "STRATEGY_MINING_MAX_SYMBOLS",
            "STRATEGY_MINING_RESAMPLE", "STRATEGY_MINING_POSITION_LIMIT", "STRATEGY_MINING_TRADE_AT_PRICE",
        )
        if os.environ.get(name, "").strip()
    ]
    if window_mode != "rolling":
        args.env_overrides_applied.append("STRATEGY_MINING_WINDOW_MODE")
    for env_name, attr, caster in [
        ("STRATEGY_MINING_PYMOO_POPULATION", "pymoo_population", int),
        ("STRATEGY_MINING_PYMOO_GENERATIONS", "pymoo_generations", int),
        ("STRATEGY_MINING_MIN_FACTORS", "min_factors", int),
        ("STRATEGY_MINING_MAX_FACTORS", "max_factors", int),
        ("STRATEGY_MINING_FINLAB_CONFIRM_TOP_N", "finlab_confirm_top_n", int),
        ("STRATEGY_MINING_PYMOO_SEARCH_MODE", "pymoo_search_mode", str),
        ("STRATEGY_MINING_PYMOO_LABELER_POPULATION", "pymoo_labeler_population", int),
        ("STRATEGY_MINING_PYMOO_LABELER_GENERATIONS", "pymoo_labeler_generations", int),
        ("STRATEGY_MINING_LABELER_MIN_PERCENTILE", "labeler_min_percentile", float),
        ("STRATEGY_MINING_LABELER_MAX_PERCENTILE", "labeler_max_percentile", float),
        ("STRATEGY_MINING_PBO_FOLDS", "pbo_folds", int),
        ("STRATEGY_MINING_PBO_EMBARGO_SESSIONS", "pbo_embargo_sessions", int),
    ]:
        raw = os.environ.get(env_name, "").strip()
        if raw:
            setattr(args, attr, caster(raw))
            args.env_overrides_applied.append(env_name)
    # Selection-gate thresholds live in research_protocol (monthly config); the legacy
    # STRATEGY_MINING_PROMOTE_* env overrides gated on holdout/full-period metrics and are gone.
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
        STRATEGY_FEATURE_REF_CONTRACT,
        ROOT / "tools" / "finlab_alphabuilders_factor_backtest.py",
        ROOT / "tools" / "finlab_strategy_spec_backtest.py",
        ROOT / "tools" / "feature_strategy_overlap_numeric.py",
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise RuntimeError(f"strategy_mining_runtime_files_missing:{missing}")


def _login_finlab() -> None:
    from finlab import login

    login_finlab_sdk(login)


def _assert_d1_params(label: str, statements: list[tuple[str, list[Any]]]) -> None:
    """Fail before any write of the batch when a parameter would be rejected by the gateway."""
    for index, (_sql, params) in enumerate(statements):
        for position, value in enumerate(params):
            if isinstance(value, str) and len(value) > D1_MAX_STRING_PARAM_CHARS:
                raise RuntimeError(
                    f"strategy_mining_d1_param_too_large:{label}:statement={index}:param={position}:"
                    f"chars={len(value)}>{D1_MAX_STRING_PARAM_CHARS}"
                )


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


def _candidate_factor_key(row: dict[str, Any]) -> tuple[str, ...]:
    factors = row.get("factor_ids") if isinstance(row.get("factor_ids"), list) else []
    return tuple(sorted(str(factor) for factor in factors if str(factor)))


def _deduped_finlab_confirm(report: dict[str, Any]) -> list[dict[str, Any]]:
    candidate_by_raw = {
        str(row.get("candidate_id")): row
        for row in report.get("rows") or []
        if isinstance(row, dict) and row.get("candidate_id")
    }
    best_by_factor_key: dict[tuple[str, ...], dict[str, Any]] = {}
    passthrough: list[dict[str, Any]] = []

    def score(confirm: dict[str, Any]) -> tuple[float, float, float]:
        def value(key: str) -> float:
            out = _safe_float(confirm.get(key))
            return -999.0 if out is None else out

        return value("monthly_sharpe"), value("cagr"), value("calmar")

    for confirm in report.get("finlab_confirm") or []:
        if not isinstance(confirm, dict):
            continue
        raw_id = _confirm_raw_candidate_id(confirm)
        key = _candidate_factor_key(candidate_by_raw.get(raw_id) or {})
        if not key:
            passthrough.append(confirm)
            continue
        current = best_by_factor_key.get(key)
        if current is None or score(confirm) > score(current):
            best_by_factor_key[key] = confirm
    return [*passthrough, *best_by_factor_key.values()]


def _ranked_rows(rows: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    def key(row: dict[str, Any]) -> tuple[int, float]:
        ok = 1 if row.get("status") == "ok" else 0
        fitness = _safe_float(row.get("fitness"))
        return ok, -999.0 if fitness is None else fitness

    return sorted(rows, key=key, reverse=True)[:limit]


def _existing_run_row(run_id: str) -> tuple[str | None, dict[str, Any] | None]:
    """(status, telemetry) of this run_id's row, or (None, None). Unparsable telemetry -> {"unparsable": True}."""
    rows = d1_client.query(
        "SELECT status, telemetry_json FROM strategy_mining_runs WHERE run_id = ?",
        [run_id],
        timeout=30.0,
    )
    if not rows:
        return None, None
    row = rows[0] or {}
    try:
        telemetry = json.loads(row.get("telemetry_json") or "{}")
    except Exception:
        telemetry = None
    if not isinstance(telemetry, dict):
        telemetry = {"unparsable": True}
    return row.get("status"), telemetry


def _existing_run_telemetry(run_id: str) -> dict[str, Any] | None:
    return _existing_run_row(run_id)[1]


def _attempt_left_unknown_family(status: str | None, telemetry: dict[str, Any] | None) -> bool:
    """Whether the row's latest attempt may have searched/opened the holdout without a ledger."""
    if telemetry is None:
        return False
    if telemetry.get("previous_attempt_incomplete") or telemetry.get("unparsable"):
        return True
    ledger = telemetry.get("multiple_testing_ledger")
    if status == "completed" or (isinstance(ledger, dict) and ledger.get("selection_start")):
        return False
    # Marker present (search started), or a row from before the marker existed: family unknown.
    return bool(telemetry.get("search_started_at")) or telemetry.get("attempt_protocol") != ATTEMPT_PROTOCOL


def _attempt_ledgers(telemetry: dict[str, Any] | None, *, include_current: bool) -> list[dict[str, Any]]:
    if not telemetry:
        return []
    ledgers = [item for item in telemetry.get("previous_attempt_ledgers") or [] if isinstance(item, dict)]
    current = telemetry.get("multiple_testing_ledger")
    if include_current and isinstance(current, dict):
        ledgers.append(current)
    return ledgers


def _insert_run(run_id: str, run_date: str, cadence: str, args: argparse.Namespace) -> dict[str, Any]:
    # A Cloud Run task retry reuses the run_id. INSERT OR REPLACE would drop the ledger an earlier
    # attempt recorded (its holdout may already have been opened), so it is carried forward.
    status, existing = _existing_run_row(run_id)
    carried = _attempt_ledgers(existing, include_current=True)
    started: dict[str, Any] = {"started_at": _now_tw().isoformat(), "attempt_protocol": ATTEMPT_PROTOCOL}
    if carried:
        started["previous_attempt_ledgers"] = carried
    if _attempt_left_unknown_family(status, existing):
        # An earlier attempt may have opened the holdout without leaving a ledger: this run's
        # family stays unknown (promotion-blocking) for good, a retry must not wash that out.
        started["previous_attempt_incomplete"] = True
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
            _json_dumps(started),
        ],
        timeout=60.0,
    )
    return started


def _mark_search_started(run_id: str, started: dict[str, Any]) -> dict[str, Any]:
    """Record on the run row that the search (and with it the holdout) is about to be touched.

    Raises when the write fails: without the marker a later failure would read as "tested
    nothing", so the search must not start.
    """
    marked = {**started, "search_started_at": _now_tw().isoformat()}
    d1_client.execute(
        "UPDATE strategy_mining_runs SET telemetry_json = ?, updated_at = CURRENT_TIMESTAMP WHERE run_id = ?",
        [_json_dumps(marked), run_id],
        timeout=60.0,
    )
    return marked


def _compact_completion_telemetry(telemetry: dict[str, Any]) -> dict[str, Any]:
    """Keep consumer scalars in D1; full research evidence remains in artifacts."""
    def scalars(value: Any) -> dict[str, Any]:
        return {k: v for k, v in (value or {}).items()
                if v is None or isinstance(v, (str, int, float, bool))}

    result = dict(telemetry)
    result["schema_version"] = "strategy-mining-completion-summary-v2"
    result["full_report"] = (telemetry.get("artifact_paths") or {}).get("gcs", {}).get("json")
    if not result["full_report"]:
        raise RuntimeError("strategy_mining_completion_full_report_missing")
    result["summary"] = {
        name: {**scalars(summary), "pbo": scalars(summary.get("pbo"))}
        for name, summary in (telemetry.get("summary") or {}).items()
        if isinstance(summary, dict)
    }
    result["adaptive_strategy_families"] = scalars(telemetry.get("adaptive_strategy_families"))
    evidence = telemetry.get("strategy_research_evidence") or {}
    result["strategy_research_evidence"] = {
        **scalars(evidence),
        **{key: scalars(evidence.get(key)) for key in
           ("common_candidate_matrix", "pbo", "walk_forward", "multiple_testing")},
        "candidate_evidence_count": len(evidence.get("candidate_evidence") or {}),
        "full_evidence_ref": result["full_report"] + "#strategy_research_evidence",
    }
    result["factor_universe_summary"] = scalars(telemetry.get("factor_universe_summary"))
    ledger = telemetry.get("multiple_testing_ledger")
    if isinstance(ledger, dict):
        result["multiple_testing_ledger"] = {
            **scalars(ledger),
            "prior_runs_counted": [scalars(item) for item in ledger.get("prior_runs_counted") or []][:120],
        }
    if telemetry.get("previous_attempt_ledgers"):
        result["previous_attempt_ledgers"] = [
            scalars(item) for item in telemetry.get("previous_attempt_ledgers") or [] if isinstance(item, dict)
        ]
    result["holdout_seal"] = scalars(telemetry.get("holdout_seal"))
    result["walk_forward_windows"] = scalars(telemetry.get("walk_forward_windows"))
    result["blocking_gates"] = [str(item) for item in telemetry.get("blocking_gates") or []]
    result["ledger"] = {
        name: {**scalars(item), "batch": scalars(item.get("batch"))}
        for name, item in (telemetry.get("ledger") or {}).items()
        if isinstance(item, dict)
    }
    if len(_json_dumps(result).encode("utf-8")) > 100_000:
        raise RuntimeError("strategy_mining_completion_summary_too_large")
    return result


def _update_run(
    run_id: str, *, status: str, telemetry: dict[str, Any], started: dict[str, Any] | None = None
) -> None:
    # `started` is what _insert_run / _mark_search_started wrote for this attempt. Its earlier-attempt
    # ledgers and search marker are carried in memory, so the status write needs no second read.
    started = started or {}
    carried = [item for item in started.get("previous_attempt_ledgers") or [] if isinstance(item, dict)]
    if carried:
        telemetry = {**telemetry, "previous_attempt_ledgers": carried}
    for key in ("attempt_protocol", "search_started_at", "previous_attempt_incomplete"):
        if started.get(key) and key not in telemetry:
            telemetry = {**telemetry, key: started[key]}
    if status == "completed":
        telemetry = _compact_completion_telemetry(telemetry)
    d1_client.execute(
        """
        UPDATE strategy_mining_runs
        SET status = ?, telemetry_json = ?, updated_at = CURRENT_TIMESTAMP
        WHERE run_id = ?
        """,
        [status, _json_dumps(telemetry), run_id],
        timeout=60.0,
    )


def _persist_candidates(run_id: str, report: dict[str, Any], *, execute: bool = True) -> dict[str, Any]:
    candidate_to_family, representative_ids, _family_packets = _family_maps(report)
    research_evidence = report.get("strategy_research_evidence") or {}
    candidate_evidence = research_evidence.get("candidate_evidence") or {}
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
            validation_status = "pymoo_ok"
            if raw_id in confirm_ids:
                # Having a confirm row is not passing it; the label follows the confirm gate verdict.
                passed = (row.get("finlab_confirm_gate") or {}).get("status") == "pass"
                validation_status = "finlab_confirmed" if passed else "finlab_confirm_failed"
        evidence = candidate_evidence.get(raw_id) or {}
        promotion_state = (
            "challenger_candidate"
            if raw_id in representative_ids and evidence.get("status") == "pass"
            else "research_candidate"
        )
        metrics = {
            key: row.get(key)
            for key in [
                "status",
                "fitness",
                "fitness_contract",
                "complexity",
                "turnover",
                "validation_turnover",
                "base_novelty",
                "novelty",
                "similarity_novelty_penalty",
                "similarity_novelty_bonus",
                "max_internal_similarity",
                "max_archive_similarity",
                "max_similarity",
                "deflated_sharpe",
                "train",
                "validation",
                "selection",
                "train_excess",
                "validation_excess",
                "selection_excess",
                "holdout_status",
                "holdout",
                "holdout_excess",
                "finlab_confirm_gate",
                "latest_matches",
                "match_days",
            ]
        }
        metrics["raw_candidate_id"] = raw_id
        metrics["factor_directions"] = row.get("factor_directions")
        metrics["factor_direction_sources"] = row.get("factor_direction_sources")
        metrics["research_evidence"] = evidence
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
    _assert_d1_params("candidates", statements)
    if not execute:
        return {"statements": statements}
    result = d1_client.batch_execute(statements, timeout=60.0, chunk_size=50)
    return {"selected": len(selected), "batch": result}


_BACKTEST_UPDATE_SQL = """
UPDATE strategy_backtest_results
SET start_date = ?, end_date = ?, cagr = ?, sharpe = ?, max_drawdown = ?, calmar = ?, turnover = ?,
    pbo = ?, deflated_sharpe_probability = ?, evidence_json = ?
WHERE candidate_id = ? AND run_id = ?
"""


def _persist_backtests(run_id: str, report: dict[str, Any], *, execute: bool = True) -> dict[str, Any]:
    candidate_by_raw = {
        str(row.get("candidate_id")): row
        for row in report.get("rows") or []
        if isinstance(row, dict) and row.get("candidate_id")
    }
    statements: list[tuple[str, list[Any]]] = []
    config = report.get("config") or {}
    research_evidence = report.get("strategy_research_evidence") or {}
    common_pbo = research_evidence.get("pbo") or {}
    candidate_evidence = research_evidence.get("candidate_evidence") or {}
    for confirm in _deduped_finlab_confirm(report):
        if not isinstance(confirm, dict):
            continue
        raw_id = _confirm_raw_candidate_id(confirm)
        source_row = candidate_by_raw.get(raw_id) or {}
        dsr = ((source_row.get("deflated_sharpe") or {}).get("probability") if isinstance(source_row, dict) else None)
        evidence = {
            "confirm": confirm,
            "candidate_metrics": {
                "validation": source_row.get("validation"),
                "validation_excess": source_row.get("validation_excess"),
                "selection": source_row.get("selection"),
                "holdout": source_row.get("holdout"),
                "holdout_excess": source_row.get("holdout_excess"),
                "finlab_confirm_gate": source_row.get("finlab_confirm_gate"),
                "fitness": source_row.get("fitness"),
                "fitness_contract": source_row.get("fitness_contract"),
                "raw_candidate_id": raw_id,
            },
            "common_pbo": common_pbo,
            "candidate_research_evidence": candidate_evidence.get(raw_id),
            "walk_forward": research_evidence.get("walk_forward"),
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
                    _safe_float(common_pbo.get("pbo")),
                    _safe_float(dsr),
                    _json_dumps(evidence),
                ],
            )
        )
    _assert_d1_params("ledger", statements)
    if not execute:
        return {"statements": statements}
    if not statements:
        return {"selected": 0, "batch": None}
    # A retry after a partial write inserts only the candidates that are still missing (the table
    # has no unique key, and skipping the whole batch left a half-written run forever). The lookup
    # goes through idx_strategy_backtest_results_candidate (candidate_id IN ...), not a run_id scan.
    candidate_ids = [params[0] for _sql, params in statements]
    persisted: set[str] = set()
    for start in range(0, len(candidate_ids), 50):
        chunk = candidate_ids[start:start + 50]
        rows = d1_client.query(
            "SELECT candidate_id FROM strategy_backtest_results WHERE candidate_id IN ("
            + ", ".join("?" for _ in chunk)
            + ") AND run_id = ?",
            [*chunk, run_id],
            timeout=30.0,
        )
        persisted.update(str(row.get("candidate_id")) for row in rows or [])
    # Candidate ids are positional (eval counters), so an existing row from an earlier attempt may
    # describe a different factor set: it is overwritten with this attempt's values, and only the
    # missing candidates are inserted.
    writes: list[tuple[str, list[Any]]] = []
    for sql, params in statements:
        if params[0] in persisted:
            writes.append((_BACKTEST_UPDATE_SQL, [*params[2:], params[0], run_id]))
        else:
            writes.append((sql, params))
    result = d1_client.batch_execute(writes, timeout=60.0, chunk_size=50)
    return {"selected": len(writes), "inserted": len(writes) - len(persisted), "updated": len(persisted), "batch": result}


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left and not right:
        return 0.0
    union = left | right
    return float(len(left & right) / len(union)) if union else 0.0


def _persist_candidate_similarity(run_id: str, report: dict[str, Any], *, execute: bool = True) -> dict[str, Any]:
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
    _assert_d1_params("candidate_similarity", statements)
    if not execute:
        return {"statements": statements}
    result = d1_client.batch_execute(statements, timeout=60.0, chunk_size=100)
    return {"selected": len(statements), "batch": result}


def _persist_promotion_packets(run_id: str, report: dict[str, Any], *, execute: bool = True) -> dict[str, Any]:
    _candidate_to_family, representative_ids, family_packets = _family_maps(report)
    research_evidence = report.get("strategy_research_evidence") or {}
    candidate_evidence = research_evidence.get("candidate_evidence") or {}
    statements: list[tuple[str, list[Any]]] = []
    for raw_id in sorted(representative_ids):
        packet = family_packets.get(raw_id) or {}
        evidence = candidate_evidence.get(raw_id) or {}
        evidence_status = str(evidence.get("status") or "pending")
        if evidence_status == "pass":
            to_state = "challenger_candidate"
            decision = "auto_research_gate_passed_pending_review"
            failed_gates: list[str] = []
        elif evidence_status == "failed":
            to_state = "research_candidate"
            decision = "auto_research_gate_failed"
            failed_gates = list(evidence.get("failed_gates") or ["research_evidence_failed"])
        else:
            to_state = "research_candidate"
            decision = "auto_research_evidence_pending"
            failed_gates = ["research_evidence_pending"]
        packet = {
            **packet,
            "strategy_research_evidence": {
                "common_candidate_matrix": research_evidence.get("common_candidate_matrix"),
                "pbo": research_evidence.get("pbo"),
                "walk_forward": research_evidence.get("walk_forward"),
                "multiple_testing": research_evidence.get("multiple_testing"),
                "candidate": evidence or None,
            },
        }
        statements.append(
            (
                """
                INSERT OR REPLACE INTO strategy_promotion_ledger (
                  ledger_id, candidate_id, run_id, from_state, to_state, decision,
                  failed_gates_json, packet_json, real_trading_effect
                ) VALUES (?, ?, ?, 'research_candidate', ?, ?, ?, ?, 'none')
                """,
                [
                    f"{run_id}__{raw_id}__challenger_packet",
                    _ledger_candidate_id(run_id, raw_id),
                    run_id,
                    to_state,
                    decision,
                    _json_dumps(failed_gates),
                    _json_dumps(packet),
                ],
            )
        )
    _assert_d1_params("ledger", statements)
    if not execute:
        return {"statements": statements}
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
    persisters = {
        "candidates": _persist_candidates,
        "backtests": _persist_backtests,
        "candidate_similarity": _persist_candidate_similarity,
        "promotion_packets": _persist_promotion_packets,
    }
    # Build and size-check every batch first: an oversized later batch must not leave the
    # earlier batches half-written.
    planned = {name: persist(run_id, report, execute=False) for name, persist in persisters.items()}
    result = {name: persist(run_id, report) for name, persist in persisters.items()}
    result["superseded_by_retry"] = _supersede_stale_attempt_rows(run_id, planned)
    return result


SUPERSEDED_BY_RETRY = "superseded_by_retry"


def _chunks(values: list[str], size: int = 50) -> list[list[str]]:
    return [values[start:start + size] for start in range(0, len(values), size)]


def _supersede_stale_attempt_rows(run_id: str, planned: dict[str, Any]) -> dict[str, int]:
    """Mark rows an earlier attempt of this run_id wrote and this attempt did not.

    Candidate ids are positional (eval counters) and the gateway allows no DELETE, so a retry that
    searched differently would otherwise leave e.g. a passing challenger packet the final attempt
    never produced. All reads/updates go through indexes (candidates by run_id; backtests and
    packets by candidate_id).
    """
    def ids(name: str, index: int = 0) -> set[str]:
        return {str(params[index]) for _sql, params in (planned.get(name) or {}).get("statements") or []}

    written_candidates = ids("candidates")
    written_backtests = ids("backtests")
    written_packets = ids("promotion_packets")
    rows = d1_client.query(
        "SELECT candidate_id FROM strategy_mining_candidates WHERE run_id = ?", [run_id], timeout=30.0,
    )
    run_candidates = sorted({str(row.get("candidate_id")) for row in rows or [] if row.get("candidate_id")})
    stale_candidates = [cid for cid in run_candidates if cid not in written_candidates]
    stale_backtests: set[str] = set()
    stale_packets: set[str] = set()
    for chunk in _chunks(run_candidates):
        marks = ", ".join("?" for _ in chunk)
        for row in d1_client.query(
            f"SELECT candidate_id FROM strategy_backtest_results WHERE candidate_id IN ({marks}) AND run_id = ?",
            [*chunk, run_id], timeout=30.0,
        ) or []:
            if str(row.get("candidate_id")) not in written_backtests:
                stale_backtests.add(str(row.get("candidate_id")))
        for row in d1_client.query(
            f"SELECT ledger_id FROM strategy_promotion_ledger WHERE candidate_id IN ({marks}) AND run_id = ?",
            [*chunk, run_id], timeout=30.0,
        ) or []:
            if str(row.get("ledger_id")) not in written_packets:
                stale_packets.add(str(row.get("ledger_id")))
    statements: list[tuple[str, list[Any]]] = []
    for chunk in _chunks(stale_candidates):
        statements.append((
            "UPDATE strategy_mining_candidates SET validation_status = ?, promotion_state = 'research_candidate', "
            f"updated_at = CURRENT_TIMESTAMP WHERE candidate_id IN ({', '.join('?' for _ in chunk)})",
            [SUPERSEDED_BY_RETRY, *chunk],
        ))
    for chunk in _chunks(sorted(stale_backtests)):
        statements.append((
            "UPDATE strategy_backtest_results SET decision = ? "
            f"WHERE candidate_id IN ({', '.join('?' for _ in chunk)}) AND run_id = ?",
            [SUPERSEDED_BY_RETRY, *chunk, run_id],
        ))
    for chunk in _chunks(sorted(stale_packets)):
        statements.append((
            "UPDATE strategy_promotion_ledger SET to_state = 'research_candidate', decision = ? "
            f"WHERE ledger_id IN ({', '.join('?' for _ in chunk)})",
            [SUPERSEDED_BY_RETRY, *chunk],
        ))
    if statements:
        d1_client.batch_execute(statements, timeout=60.0, chunk_size=50)
    return {"candidates": len(stale_candidates), "backtests": len(stale_backtests), "promotion_packets": len(stale_packets)}


# Set when the run ended on SIGTERM: the platform may re-run the same run_id (Modal preemption),
# so no terminal callback is sent for that attempt (as before the handler existed).
_TERMINATED_BY_SIGNAL = False


class StrategyMiningTerminated(BaseException):
    """SIGTERM (Cloud Run task timeout/cancel, Modal shutdown) turned into a recordable error."""


def _install_sigterm_handler() -> Any:
    def handler(signum: int, _frame: Any) -> None:
        raise StrategyMiningTerminated(f"received_signal_{signum}")

    try:
        return signal.signal(signal.SIGTERM, handler)
    except ValueError:  # not the main thread; nothing to install
        return None


def _restore_sigterm_handler(previous: Any) -> None:
    if previous is None:
        return
    try:
        signal.signal(signal.SIGTERM, previous)
    except ValueError:
        pass


def _gcs_credentials_preflight() -> dict[str, Any]:
    """Resolve ADC and exchange a token (read-only; no object is written)."""
    import google.auth
    from google.auth.transport.requests import Request

    credentials, project = google.auth.default(scopes=["https://www.googleapis.com/auth/devstorage.read_write"])
    credentials.refresh(Request())
    return {"status": "pass", "project": project, "credential_type": type(credentials).__name__}


def _run_strategy_mining() -> int:
    from services.json_logging import configure_json_logging

    configure_json_logging(os.environ.get("LOG_LEVEL", "INFO"))
    started = time.time()
    run_date = _run_date()
    cadence = os.environ.get("STRATEGY_MINING_CADENCE", "monthly").strip() or "monthly"
    if cadence != "monthly":
        raise RuntimeError(f"unsupported_strategy_mining_cadence:{cadence}")

    run_id = os.environ.get("STRATEGY_MINING_RUN_ID", "").strip()
    if not run_id:
        # Cloud Run sets CLOUD_RUN_EXECUTION for every task attempt of one execution, so a task
        # retry reuses (INSERT OR REPLACE) the same run row instead of leaving an orphan 'running'
        # row under a fresh timestamp id (the 2026-07-04 orphan pattern).
        execution = "".join(
            ch for ch in os.environ.get("CLOUD_RUN_EXECUTION", "").strip() if ch.isalnum() or ch in "-_"
        )
        run_id = (
            f"strategy-mining-{run_date}-{execution}"
            if execution
            else f"strategy-mining-{run_date}-{_now_tw().strftime('%Y%m%d%H%M%S')}"
        )
    os.environ["STRATEGY_MINING_RUN_ID"] = run_id
    output_dir = Path(os.environ.get("STRATEGY_MINING_OUTPUT_DIR", "") or f"/tmp/strategy_mining/{run_id}")

    LOGGER.info("strategy mining job starting run_id=%s run_date=%s", run_id, run_date)
    _assert_runtime_files()
    _login_finlab()
    alpha = _load_alpha_miner()
    args = _build_args(alpha, run_date=run_date, output_dir=output_dir)
    started_row = _insert_run(run_id, run_date, cadence, args) or {}

    previous_sigterm = _install_sigterm_handler()
    report: dict[str, Any] | None = None
    try:
        bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
        if os.environ.get("STRATEGY_MINING_BACKEND") != "modal" and bucket_name:
            # Fail in seconds, not after 20-30 minutes of compute at artifact upload time
            # (DefaultCredentialsError / OAuthError unauthorized_client classes).
            LOGGER.info("strategy mining GCS credential preflight: %s", _json_dumps(_gcs_credentials_preflight()))
        if os.environ.get("STRATEGY_MINING_BACKEND") == "modal":
            from app.gcs_preflight import verify_gcs_object_lifecycle
            from google.cloud import storage

            bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
            if not bucket_name:
                raise RuntimeError("strategy_mining_gcs_bucket_missing")
            preflight = verify_gcs_object_lifecycle(
                storage.Client().bucket(bucket_name), workload="strategy-mining", run_id=run_id,
            )
            LOGGER.info("strategy mining GCS preflight: %s", _json_dumps(preflight))
        ledger_blocking: list[str] = []
        try:
            prior_runs = _prior_multiple_testing_runs(current_run_id=run_id)
        except Exception as exc:  # noqa: BLE001 - undercounting trials is not allowed to pass a gate
            LOGGER.warning("strategy mining prior multiple-testing ledger unavailable: %s", exc)
            prior_runs = []
            ledger_blocking.append("multiple_testing_prior_ledger_unavailable")
        if any(item.get("incomplete") for item in prior_runs) or started_row.get("previous_attempt_incomplete"):
            ledger_blocking.append("multiple_testing_prior_ledger_incomplete")
        own_earlier = [
            item for item in started_row.get("previous_attempt_ledgers") or []
            if isinstance(item, dict) and item.get("selection_start")
        ]
        if own_earlier:
            # Earlier attempts of this run_id already tested on this holdout; this attempt's DSR/Holm
            # must count them like later runs will.
            last = own_earlier[-1]
            prior_runs = [*prior_runs, {
                "run_id": f"{run_id}#earlier_attempts",
                "selection_start": last.get("selection_start"),
                "selection_end": last.get("selection_end"),
                "holdout_start": last.get("holdout_start"),
                "holdout_end": last.get("holdout_end"),
                "search_trials_raw": _summed(own_earlier, "search_trials_raw"),
                "search_trials_effective": _summed(own_earlier, "search_trials_effective"),
                "holdout_family_size": _summed(own_earlier, "holdout_family_size"),
                "attempts": len(own_earlier),
            }]
        args.prior_multiple_testing_runs = [item for item in prior_runs if not item.get("incomplete")]
        # Known before the holdout is opened, so the miner withholds the holdout for this run.
        args.pre_holdout_blocking_gates = list(ledger_blocking)
        started_row = _mark_search_started(run_id, started_row)
        report = alpha.run(args)
        multiple_testing = report.get("multiple_testing") or {}
        blocking_gates = list(dict.fromkeys([*(report.get("blocking_gates") or []), *ledger_blocking]))
        report["blocking_gates"] = blocking_gates
        protocol = report.get("research_protocol") or {}
        report["strategy_research_evidence"] = build_strategy_mining_evidence(
            list(report.get("rows") or []),
            n_partitions=int(args.pbo_folds),
            n_simulations=_env_int("STRATEGY_MINING_MONTE_CARLO_SIMULATIONS", 1000),
            selection_attestation=report.get("selection_purge_attestation"),
            prior_holdout_family_size=int(multiple_testing.get("prior_holdout_family_size") or 0),
            blocking_gates=blocking_gates,
            holm_alpha=float((protocol.get("holdout_gate") or {}).get("holm_alpha") or 0.05),
        )
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
            "strategy_research_evidence": report.get("strategy_research_evidence"),
            "multiple_testing_ledger": report.get("multiple_testing"),
            "holdout_seal": report.get("holdout_seal"),
            "walk_forward_windows": report.get("walk_forward_windows"),
            "blocking_gates": report.get("blocking_gates"),
            "factor_universe_summary": {
                key: value
                for key, value in (report.get("factor_universe") or {}).items()
                if key not in {"factor_ids", "factor_meta", "ab_mapping"}
            },
        }
        _update_run(run_id, status="completed", telemetry=telemetry, started=started_row)
        _restore_sigterm_handler(previous_sigterm)
        previous_sigterm = None
        print(json.dumps({"status": "completed", "run_id": run_id, **telemetry}, ensure_ascii=False, default=_json_default))
        return 0
    except (Exception, StrategyMiningTerminated) as exc:
        telemetry = {
            "failed_at": _now_tw().isoformat(),
            "runtime_seconds": round(time.time() - started, 3),
            "error_type": type(exc).__name__,
            "error": str(exc)[:2000],
        }
        global _TERMINATED_BY_SIGNAL
        _TERMINATED_BY_SIGNAL = isinstance(exc, StrategyMiningTerminated)
        if isinstance(report, dict) and isinstance(report.get("multiple_testing"), dict):
            # The search (and possibly the holdout) already happened; later runs must count it.
            telemetry["multiple_testing_ledger"] = report["multiple_testing"]
        try:
            _update_run(run_id, status="error", telemetry=telemetry, started=started_row)
        except Exception:
            LOGGER.exception("failed to update strategy mining error status")
        LOGGER.exception("strategy mining job failed run_id=%s", run_id)
        print(json.dumps({"status": "error", "run_id": run_id, **telemetry}, ensure_ascii=False, default=_json_default))
        return 1
    finally:
        _restore_sigterm_handler(previous_sigterm)


def main() -> int:
    started = time.time()
    terminal_error: str | None = None
    try:
        exit_code = int(_run_strategy_mining())
    except Exception as exc:  # Includes setup/login/import failures before the inner run ledger exists.
        exit_code = 1
        terminal_error = f"{type(exc).__name__}:{exc}"
        LOGGER.exception("strategy mining failed before the run ledger was initialized")
        print(_json_dumps({
            "status": "error",
            "run_id": os.environ.get("STRATEGY_MINING_RUN_ID") or None,
            "error": terminal_error,
        }))

    run_date = os.environ.get("STRATEGY_MINING_RUN_DATE", "").strip() or _now_tw().date().isoformat()
    run_id = os.environ.get("STRATEGY_MINING_RUN_ID", "").strip() or f"strategy-mining-untracked-{run_date}"
    scheduler_status = "success" if exit_code == 0 else "error"
    summary = (
        f"monthly Pymoo strategy mining {scheduler_status} "
        f"run_id={run_id} backend={os.environ.get('STRATEGY_MINING_BACKEND', 'job')}"
    )
    callback_payload: dict[str, Any] = {
        "task": "monthly-strategy-mining",
        "status": scheduler_status,
        "summary": summary,
        "duration_ms": int(max(time.time() - started, 0.0) * 1000),
        "run_id": run_id,
        "run_date": run_date,
        "metadata": {
            "cadence": os.environ.get("STRATEGY_MINING_CADENCE", "monthly"),
            "backend": os.environ.get("STRATEGY_MINING_BACKEND", "job"),
        },
    }
    if exit_code != 0:
        callback_payload["error"] = terminal_error or "strategy_mining_exit_code=1"
    if _TERMINATED_BY_SIGNAL:
        LOGGER.warning("strategy mining terminated by signal run_id=%s; no terminal callback", run_id)
        return exit_code
    try:
        _callback_worker_scheduler(callback_payload)
    except Exception:
        LOGGER.exception("strategy mining terminal callback failed run_id=%s", run_id)
        return 1
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
