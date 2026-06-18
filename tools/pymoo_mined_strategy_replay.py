from __future__ import annotations

import argparse
import csv
import importlib.util
import json
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
ALPHA_MINER = ROOT / "tools" / "finlab_alpha_miner_bakeoff.py"
SPEC_RUNNER = ROOT / "tools" / "finlab_strategy_spec_backtest.py"
DEFAULT_CONFIRM_CSV = (
    ROOT
    / "output"
    / "finlab_alpha_miner_canonical114_mresample"
    / "alpha_miner_bakeoff_canonical114_pymoo_sii_20230101_20260615_seed42_finlab_confirm.csv"
)


REPRESENTATIVE_CANDIDATE_IDS = [
    "alpha_miner_pymoo_nsga3_novelty_0081",
    "alpha_miner_pymoo_nsga3_novelty_0193",
    "alpha_miner_pymoo_nsga3_novelty_0187",
]


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        if not np.isfinite(value):
            return None
        return float(value)
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    if isinstance(value, set):
        return sorted(value)
    return str(value)


def _load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot_load_module:{path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def _parse_literal_list(raw: str) -> list[Any]:
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        import ast

        value = ast.literal_eval(text)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"invalid_literal_list:{text}") from exc
    if not isinstance(value, list):
        raise ValueError(f"literal_is_not_list:{text}")
    return value


def _load_confirm_candidates(path: Path, candidate_ids: list[str]) -> list[dict[str, Any]]:
    wanted = set(candidate_ids)
    out: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        for row in csv.DictReader(fh):
            if row.get("id") not in wanted:
                continue
            out.append(
                {
                    "id": row["id"],
                    "algorithm": row.get("algorithm") or "pymoo_nsga3_novelty",
                    "factor_ids": [str(x) for x in _parse_literal_list(row.get("factor_ids", ""))],
                    "weights": [float(x) for x in _parse_literal_list(row.get("weights", ""))],
                    "combine": row.get("combine") or "weighted_sum",
                    "finlab_confirm": {
                        "cagr": _safe_float(row.get("cagr")),
                        "max_drawdown": _safe_float(row.get("max_drawdown")),
                        "monthly_sharpe": _safe_float(row.get("monthly_sharpe")),
                        "calmar": _safe_float(row.get("calmar")),
                        "latest_matches": _safe_int(row.get("latest_matches")),
                    },
                }
            )
    order = {candidate_id: index for index, candidate_id in enumerate(candidate_ids)}
    return sorted(out, key=lambda row: order.get(str(row["id"]), 999))


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _safe_int(value: Any) -> int | None:
    try:
        parsed = int(float(value))
    except (TypeError, ValueError):
        return None
    return parsed


def _latest_index(index: pd.Index, run_date: str) -> pd.Timestamp:
    end = pd.Timestamp(run_date)
    available = pd.DatetimeIndex(index)
    filtered = available[available <= end]
    if len(filtered) == 0:
        raise RuntimeError(f"no_available_date_before:{run_date}")
    return pd.Timestamp(filtered[-1])


def _symbols_from_bool_row(row: pd.Series) -> list[str]:
    selected = [str(symbol) for symbol, flag in row.items() if bool(flag)]
    return sorted(selected)


def _pairwise_overlap(selection: dict[str, list[str]]) -> list[dict[str, Any]]:
    ids = sorted(selection)
    rows: list[dict[str, Any]] = []
    for i, left_id in enumerate(ids):
        left = set(selection[left_id])
        for right_id in ids[i + 1 :]:
            right = set(selection[right_id])
            union = left | right
            inter = left & right
            rows.append(
                {
                    "left": left_id,
                    "right": right_id,
                    "left_count": len(left),
                    "right_count": len(right),
                    "intersection": len(inter),
                    "union": len(union),
                    "jaccard": round(len(inter) / len(union), 6) if union else None,
                    "overlap_symbols": sorted(inter),
                }
            )
    return rows


def _summarize_overlap(selection: dict[str, list[str]]) -> dict[str, Any]:
    pairwise = _pairwise_overlap(selection)
    jaccards = [float(row["jaccard"]) for row in pairwise if row.get("jaccard") is not None]
    all_symbols = set()
    for symbols in selection.values():
        all_symbols.update(symbols)
    return {
        "strategy_count": len(selection),
        "non_empty_strategy_count": sum(1 for symbols in selection.values() if symbols),
        "unique_symbol_count": len(all_symbols),
        "avg_pairwise_jaccard": round(float(np.mean(jaccards)), 6) if jaccards else None,
        "max_pairwise_jaccard": round(float(np.max(jaccards)), 6) if jaccards else None,
        "pairwise": pairwise,
    }


def _compact_diversity(diversity: dict[str, Any], *, top_n: int = 10) -> dict[str, Any]:
    pairwise = sorted(
        list(diversity.get("pairwise") or []),
        key=lambda row: float(row.get("jaccard") or 0),
        reverse=True,
    )
    compact_pairs = []
    for row in pairwise[:top_n]:
        compact_pairs.append(
            {
                "left": row.get("left"),
                "right": row.get("right"),
                "left_count": row.get("left_count"),
                "right_count": row.get("right_count"),
                "intersection": row.get("intersection"),
                "union": row.get("union"),
                "jaccard": row.get("jaccard"),
                "overlap_symbols": row.get("overlap_symbols") if len(row.get("overlap_symbols") or []) <= 20 else None,
            }
        )
    return {
        "strategy_count": diversity.get("strategy_count"),
        "non_empty_strategy_count": diversity.get("non_empty_strategy_count"),
        "unique_symbol_count": diversity.get("unique_symbol_count"),
        "avg_pairwise_jaccard": diversity.get("avg_pairwise_jaccard"),
        "max_pairwise_jaccard": diversity.get("max_pairwise_jaccard"),
        "top_pairwise": compact_pairs,
    }


def _load_active_production_specs() -> list[dict[str, Any]]:
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not npx:
        raise RuntimeError("npx_not_found_for_strategy_specs")
    tsx_expr = """
import { DEFAULT_STRATEGY_SPECS } from './worker/src/lib/strategySpec';
const specs = DEFAULT_STRATEGY_SPECS.filter((s) =>
  s.status === 'active' &&
  s.ownerType === 'strategy' &&
  s.promotionStatus === 'production' &&
  !String(s.id || '').startsWith('finlab_ai_skill_factor_discovery')
);
console.log(JSON.stringify(specs));
"""
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            suffix=".mts",
            prefix=".pymoo-replay-specs-",
            dir=ROOT,
            delete=False,
        ) as fh:
            fh.write(tsx_expr)
            temp_path = Path(fh.name)
        completed = subprocess.run(
            [npx, "tsx", str(temp_path)],
            cwd=ROOT,
            check=False,
            capture_output=True,
            text=True,
        )
    finally:
        if temp_path is not None:
            temp_path.unlink(missing_ok=True)
    if completed.returncode != 0:
        raise RuntimeError(
            "strategy_specs_tsx_failed:"
            f" code={completed.returncode}"
            f" stdout={completed.stdout[-1000:]!r}"
            f" stderr={completed.stderr[-1000:]!r}"
        )
    for line in reversed(completed.stdout.splitlines()):
        text = line.strip()
        if text.startswith("[") and text.endswith("]"):
            return list(json.loads(text))
    raise RuntimeError(f"strategy_specs_json_not_found:{completed.stdout[-1000:]!r}")


def _build_current_strategy_positions(
    *,
    spec_runner: Any,
    run_date: str,
    start_date: str,
    universe: str,
) -> tuple[pd.Timestamp, dict[str, list[str]], dict[str, dict[str, Any]]]:
    from finlab import data

    specs = _load_active_production_specs()
    close_raw = data.get("price:收盤價")
    close_all = spec_runner._as_dt_index(close_raw)
    columns = spec_runner._common_stock_columns(close_all)
    if universe == "sii":
        # _common_stock_columns already includes sii/otc; use the same current production-like coverage.
        pass
    close = close_all.reindex(columns=columns).loc[:run_date]
    open_ = spec_runner._as_dt_index(data.get("price:開盤價")).reindex(index=close.index, columns=columns)
    high = spec_runner._as_dt_index(data.get("price:最高價")).reindex(index=close.index, columns=columns)
    low = spec_runner._as_dt_index(data.get("price:最低價")).reindex(index=close.index, columns=columns)
    volume = spec_runner._as_dt_index(data.get("price:成交股數")).reindex(index=close.index, columns=columns)

    features = spec_runner._technical_features(close, high, low, volume)
    features["open"] = open_
    features.update(spec_runner._financial_features(close, columns))
    features.update(spec_runner._chip_features(close, columns))
    features.update(spec_runner._sector_features(close, volume, columns))

    date_mask = (close.index >= pd.Timestamp(start_date)) & (close.index <= pd.Timestamp(run_date))
    tradable = close.notna() & (close >= 10)
    date_frame = pd.DataFrame(
        np.repeat(np.asarray(date_mask)[:, None], len(columns), axis=1),
        index=close.index,
        columns=columns,
    )
    universe_mask = tradable & date_frame
    latest = _latest_index(close.index, run_date)

    selections: dict[str, list[str]] = {}
    metadata: dict[str, dict[str, Any]] = {}
    for spec in specs:
        strategy_id = str(spec.get("id") or "")
        if not strategy_id:
            continue
        pos = spec_runner._position_for_spec(spec, features, close, universe_mask).loc[start_date:run_date]
        pos = pos.reindex(columns=columns).fillna(False).astype(bool)
        if latest not in pos.index:
            latest_for_spec = _latest_index(pos.index, run_date)
        else:
            latest_for_spec = latest
        symbols = _symbols_from_bool_row(pos.loc[latest_for_spec])
        selections[strategy_id] = symbols
        metadata[strategy_id] = {
            "name": spec.get("name"),
            "family_id": spec.get("familyId"),
            "alpha_bucket": spec.get("alphaBucket"),
            "latest_match_count": len(symbols),
        }
    return latest, selections, metadata


def run(args: argparse.Namespace) -> dict[str, Any]:
    alpha = _load_module(ALPHA_MINER, "stockvision_pymoo_replay_alpha_miner")
    spec_runner = _load_module(SPEC_RUNNER, "stockvision_pymoo_replay_spec_runner")
    candidates = _load_confirm_candidates(Path(args.confirm_csv), args.candidate_id)
    if not candidates:
        raise RuntimeError("no_candidate_loaded")

    universe_args = argparse.Namespace(
        factor_json=args.factor_json,
        factor_universe="unified_registry_v1",
        feature_registry=args.feature_registry,
        start_date=args.factor_start_date,
        end_date=args.run_date,
        universe=args.universe,
        max_symbols=args.max_symbols,
    )
    close, tradable, values, meta, universe_info = alpha._build_unified_registry_factor_universe(universe_args)
    latest = _latest_index(close.index, args.run_date)

    mined_selection: dict[str, list[str]] = {}
    mined_detail: dict[str, Any] = {}
    for row in candidates:
        cand = alpha.Candidate(
            candidate_id=str(row["id"]).replace("alpha_miner_", ""),
            algorithm=str(row["algorithm"]),
            factor_ids=list(row["factor_ids"]),
            weights=list(row["weights"]),
            combine=str(row["combine"] or "weighted_sum"),
        )
        score = alpha._candidate_score(cand, values, meta)
        if score is None:
            mined_selection[str(row["id"])] = []
            mined_detail[str(row["id"])] = {"status": "no_score"}
            continue
        position = alpha._position_from_score(score.loc[: args.run_date], args.top_k, tradable).loc[
            args.factor_start_date : args.run_date
        ]
        if latest not in position.index:
            latest_for_candidate = _latest_index(position.index, args.run_date)
        else:
            latest_for_candidate = latest
        symbols = _symbols_from_bool_row(position.loc[latest_for_candidate])
        latest_scores = score.loc[latest_for_candidate, symbols].sort_values(ascending=False)
        mined_selection[str(row["id"])] = symbols
        mined_detail[str(row["id"])] = {
            "factor_ids": row["factor_ids"],
            "weights": row["weights"],
            "combine": row["combine"],
            "latest_date": latest_for_candidate.isoformat(),
            "match_count": len(symbols),
            "symbols": symbols,
            "scores": {symbol: round(float(latest_scores.get(symbol)), 6) for symbol in symbols},
            "finlab_confirm": row["finlab_confirm"],
        }

    active_latest, active_selection, active_metadata = _build_current_strategy_positions(
        spec_runner=spec_runner,
        run_date=args.run_date,
        start_date=args.factor_start_date,
        universe=args.universe,
    )

    active_nonempty = {key: symbols for key, symbols in active_selection.items() if symbols}
    report = {
        "schema_version": "stockvision-pymoo-mined-strategy-replay-v1",
        "generated_at": pd.Timestamp.utcnow().isoformat(),
        "allowed_use": "research_only",
        "decision_effect": "none",
        "run_date_requested": args.run_date,
        "latest_factor_date": latest.isoformat(),
        "latest_active_strategy_date": active_latest.isoformat(),
        "config": {
            "candidate_ids": args.candidate_id,
            "top_k_per_mined_strategy": args.top_k,
            "factor_start_date": args.factor_start_date,
            "universe": args.universe,
            "max_symbols": args.max_symbols,
            "confirm_csv": str(Path(args.confirm_csv)),
        },
        "universe_info": universe_info,
        "mined_strategy_replay": {
            "selection": mined_detail,
            "diversity": _summarize_overlap(mined_selection),
        },
        "current_active_strategy_baseline": {
            "strategy_count": len(active_selection),
            "non_empty_strategy_count": len(active_nonempty),
            "metadata": active_metadata,
            "diversity": _summarize_overlap(active_nonempty),
        },
    }
    return report


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-date", default="2026-06-17")
    parser.add_argument("--factor-start-date", default="2023-01-01")
    parser.add_argument("--universe", choices=["sii", "sii_otc"], default="sii")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument("--confirm-csv", default=str(DEFAULT_CONFIRM_CSV))
    parser.add_argument(
        "--candidate-id",
        action="append",
        default=[],
        help="alpha_miner_* id. Defaults to representative 0081/0193/0187.",
    )
    parser.add_argument(
        "--factor-json",
        default=str(ROOT / "worker" / ".tmp-test-run-codex" / "alphabuilders_factors_fresh.json"),
    )
    parser.add_argument("--feature-registry", default=str(ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"))
    parser.add_argument("--output-dir", default=str(ROOT / "output" / "pymoo_mined_strategy_replay"))
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not args.candidate_id:
        args.candidate_id = REPRESENTATIVE_CANDIDATE_IDS
    report = run(args)
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    stem = f"pymoo_mined_strategy_replay_{args.run_date.replace('-', '')}"
    json_path = output_dir / f"{stem}.json"
    summary_path = output_dir / f"{stem}_summary.json"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    compact = {
        "json": str(json_path),
        "run_date_requested": report["run_date_requested"],
        "latest_factor_date": report["latest_factor_date"],
        "mined_diversity": _compact_diversity(report["mined_strategy_replay"]["diversity"]),
        "current_active_strategy_baseline": {
            "strategy_count": report["current_active_strategy_baseline"]["strategy_count"],
            "non_empty_strategy_count": report["current_active_strategy_baseline"]["non_empty_strategy_count"],
            "diversity": _compact_diversity(report["current_active_strategy_baseline"]["diversity"]),
        },
    }
    summary_path.write_text(json.dumps(compact, ensure_ascii=False, indent=2, default=_json_default), encoding="utf-8")
    print(json.dumps(compact, ensure_ascii=False, indent=2, default=_json_default))


if __name__ == "__main__":
    main()
