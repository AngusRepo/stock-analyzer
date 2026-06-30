from __future__ import annotations

import argparse
import ast
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from strategy_promotion_preflight import RUNTIME_SIGNAL_PATHS


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ALPHA_ROWS = ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_recursive_sii_20230101_20260615_seed42_rows.csv"
DEFAULT_CONFIRM = ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_recursive_sii_20230101_20260615_seed42_finlab_confirm.csv"
DEFAULT_OUT_DIR = ROOT / "output" / "strategy_promotion_preflight" / "s04_s11_defensive_replacement_gates"
DEFAULT_ALPHA_IDS = ["alpha223_0285", "alpha223_0283", "alpha223_0009"]

ALPHA_META = {
    "alpha223_0285": {
        "name": "Alpha223 0285 EBITDA low-vol order-block quality",
        "familyId": "ALPHA223_QUALITY_LOW_VOL_BREAKOUT",
        "variantId": "alpha223_0285_ebitda_lowvol_orderblock_v1",
        "alphaBucket": "trend_following",
        "poolQuota": 12,
    },
    "alpha223_0283": {
        "name": "Alpha223 0283 OCF noncurrent-assets order-block",
        "familyId": "ALPHA223_CASHFLOW_ASSET_TURNOVER",
        "variantId": "alpha223_0283_ocf_noncurrent_orderblock_v1",
        "alphaBucket": "breakout_vol_expansion",
        "poolQuota": 12,
    },
    "alpha223_0009": {
        "name": "Alpha223 0009 cash-change gap broker-flow",
        "familyId": "ALPHA223_CASH_GAP_BROKER_FLOW",
        "variantId": "alpha223_0009_cash_gap_broker_flow_v1",
        "alphaBucket": "smart_money_accumulation",
        "poolQuota": 10,
    },
}


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _literal_list(value: str) -> list[Any]:
    parsed = ast.literal_eval(value)
    if not isinstance(parsed, list):
        raise RuntimeError(f"expected_list:{value[:80]}")
    return parsed


def _candidate_suffix(alpha_id: str) -> str:
    return alpha_id.rsplit("_", 1)[-1]


def _alpha_candidate_id(alpha_id: str) -> str:
    return f"pymoo_nsga3_novelty_{_candidate_suffix(alpha_id)}"


def _load_alpha_rows(path: Path, alpha_ids: list[str]) -> dict[str, dict[str, Any]]:
    wanted = {_alpha_candidate_id(alpha_id): alpha_id for alpha_id in alpha_ids}
    out: dict[str, dict[str, Any]] = {}
    for row in _read_csv(path):
        alpha_id = wanted.get(str(row.get("candidate_id") or ""))
        if not alpha_id:
            continue
        out[alpha_id] = {
            **row,
            "factor_ids": [str(item) for item in _literal_list(row["factor_ids"])],
            "weights": [float(item) for item in _literal_list(row["weights"])],
        }
    return out


def _load_confirm(path: Path, alpha_ids: list[str]) -> dict[str, dict[str, str]]:
    wanted = {f"alpha223_pymoo_nsga3_novelty_{_candidate_suffix(alpha_id)}": alpha_id for alpha_id in alpha_ids}
    out: dict[str, dict[str, str]] = {}
    for row in _read_csv(path):
        alpha_id = wanted.get(str(row.get("id") or ""))
        if alpha_id:
            out[alpha_id] = row
    return out


def _safe_float(row: dict[str, str], key: str) -> float | None:
    try:
        value = float(row.get(key) or "")
    except ValueError:
        return None
    return value if value == value else None


def _alpha_spec(alpha_id: str, row: dict[str, Any], confirm: dict[str, str], *, status: str) -> tuple[dict[str, Any], list[str]]:
    meta = ALPHA_META.get(alpha_id, {
        "name": f"Alpha223 {_candidate_suffix(alpha_id)} candidate",
        "familyId": "ALPHA223_EXTENSION",
        "variantId": f"{alpha_id}_extension_v1",
        "alphaBucket": "trend_following",
        "poolQuota": 10,
    })
    errors: list[str] = []
    terms = []
    for factor_id, weight in zip(row["factor_ids"], row["weights"]):
        signal = RUNTIME_SIGNAL_PATHS.get(factor_id)
        if not signal:
            errors.append(f"runtime_signal_missing:{alpha_id}:{factor_id}")
            signal = ""
        terms.append({
            "featureRef": factor_id,
            "signal": signal,
            "weight": round(float(weight), 6),
        })
    cagr = _safe_float(confirm, "cagr")
    sharpe = _safe_float(confirm, "monthly_sharpe")
    mdd = _safe_float(confirm, "max_drawdown")
    return {
        "id": alpha_id,
        "version": "strategy-spec-v1",
        "name": meta["name"],
        "status": status,
        "owner": "strategy",
        "familyId": meta["familyId"],
        "variantId": meta["variantId"],
        "ownerType": "strategy",
        "promotionStatus": "candidate",
        "alphaBucket": meta["alphaBucket"],
        "supportedRegimes": ["bull", "sideways", "volatile"],
        "thesis": f"Local replay draft for Alpha223 candidate {_candidate_suffix(alpha_id)} in S04/S11/defensive replacement test.",
        "thresholds": {
            "minPrice": 10,
            "featureRefs": {
                "weightedScore": {
                    "min": 0.58,
                    "terms": terms,
                }
            },
        },
        "candidatePolicy": {
            "poolQuota": meta["poolQuota"],
            "costBudget": 18,
            "evidenceRequirements": [
                "alpha223_recursive_search",
                "fixed_contract:20230101_20260615:sii:M:top10",
                *[f"feature_ref:{factor_id}" for factor_id in row["factor_ids"]],
            ],
            "maxMlShare": 0.22,
        },
        "riskNotes": [
            "Local replay draft only; not applied to remote D1 or live trading.",
            f"FinLab confirm: CAGR {cagr:.1%}, monthly Sharpe {sharpe:.2f}, max drawdown {mdd:.1%}." if cagr is not None and sharpe is not None and mdd is not None else "FinLab confirm metrics unavailable.",
        ],
        "createdBy": "codex_alpha223_extension_preflight",
    }, errors


def build(args: argparse.Namespace) -> dict[str, Any]:
    alpha_ids = [item.strip() for item in str(args.alpha_ids).split(",") if item.strip()]
    alpha_rows = _load_alpha_rows(Path(args.alpha_rows_csv), alpha_ids)
    confirms = _load_confirm(Path(args.confirm_csv), alpha_ids)
    specs: list[dict[str, Any]] = []
    errors: list[str] = []
    for alpha_id in alpha_ids:
        row = alpha_rows.get(alpha_id)
        if not row:
            errors.append(f"alpha_row_missing:{alpha_id}")
            continue
        spec, spec_errors = _alpha_spec(alpha_id, row, confirms.get(alpha_id, {}), status=args.status)
        specs.append(spec)
        errors.extend(spec_errors)
    return {
        "schema_version": "stockvision-alpha223-extension-spec-builder-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "decision_effect": "local_replay_draft_only",
        "alpha_ids": alpha_ids,
        "strategy_count": len(specs),
        "strategy_ids": [spec["id"] for spec in specs],
        "errors": errors,
        "specs": specs,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build local StrategySpec drafts for Alpha223 extension replay gates.")
    parser.add_argument("--alpha-ids", default=",".join(DEFAULT_ALPHA_IDS))
    parser.add_argument("--alpha-rows-csv", default=str(DEFAULT_ALPHA_ROWS))
    parser.add_argument("--confirm-csv", default=str(DEFAULT_CONFIRM))
    parser.add_argument("--status", default="active")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()

    report = build(args)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    spec_path = out_dir / "alpha223_extension_candidate_strategy_specs.json"
    summary_path = out_dir / "alpha223_extension_candidate_strategy_specs_summary.json"
    spec_path.write_text(json.dumps(report["specs"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {key: value for key, value in report.items() if key != "specs"}
    summary["json"] = _rel(spec_path)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not summary["errors"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
