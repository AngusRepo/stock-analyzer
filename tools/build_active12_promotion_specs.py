from __future__ import annotations

import argparse
import ast
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from strategy_promotion_preflight import FUSED_SOURCE_IDS, RUNTIME_SIGNAL_PATHS


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ACTIVE11 = ROOT / "output" / "finlab_strategy_backtests" / "current_active_11_strategy_specs.json"
DEFAULT_ALPHA_ROWS = ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_recursive_sii_20230101_20260615_seed42_rows.csv"
DEFAULT_CONFIRM = ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_recursive_sii_20230101_20260615_seed42_finlab_confirm.csv"
DEFAULT_OUT_DIR = ROOT / "output" / "strategy_promotion_preflight"

ALPHA_IDS = ["alpha223_0248", "alpha223_0109", "alpha223_0166", "alpha223_0283", "alpha223_0009"]
BROKER_RECLAIM_ID = "finlab_ai_skill_broker_accumulation_reclaim_v1"
FUSED_ID = "trend_quality_breakout_fused_v1"
S11_ID = "stock_tech_s11_gap_breakout_continuation_v1"
RETIRE_IDS = [*FUSED_SOURCE_IDS, BROKER_RECLAIM_ID, S11_ID]

ALPHA_META = {
    "alpha223_0248": {
        "name": "Alpha223 0248 squeeze cash-flow breakout",
        "familyId": "ALPHA223_BREAKOUT_CASH_FLOW",
        "variantId": "alpha223_0248_klow_cashflow_squeeze_v1",
        "alphaBucket": "breakout_vol_expansion",
        "min": 0.58,
        "poolQuota": 14,
    },
    "alpha223_0109": {
        "name": "Alpha223 0109 quality order-block turnover",
        "familyId": "ALPHA223_QUALITY_TURNOVER",
        "variantId": "alpha223_0109_ebitda_turnover_orderblock_v1",
        "alphaBucket": "trend_following",
        "min": 0.58,
        "poolQuota": 14,
    },
    "alpha223_0166": {
        "name": "Alpha223 0166 expense profit volume thrust",
        "familyId": "ALPHA223_EXPENSE_PROFIT_THRUST",
        "variantId": "alpha223_0166_vstd_expense_profit_emv_v1",
        "alphaBucket": "trend_following",
        "min": 0.58,
        "poolQuota": 12,
    },
    "alpha223_0283": {
        "name": "Alpha223 0283 OCF noncurrent-assets order-block",
        "familyId": "ALPHA223_CASHFLOW_ASSET_TURNOVER",
        "variantId": "alpha223_0283_ocf_noncurrent_orderblock_v1",
        "alphaBucket": "breakout_vol_expansion",
        "min": 0.58,
        "poolQuota": 12,
    },
    "alpha223_0009": {
        "name": "Alpha223 0009 cash-change gap broker-flow",
        "familyId": "ALPHA223_CASH_GAP_BROKER_FLOW",
        "variantId": "alpha223_0009_cash_gap_broker_flow_v1",
        "alphaBucket": "smart_money_accumulation",
        "min": 0.58,
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


def _load_alpha_rows(path: Path) -> dict[str, dict[str, Any]]:
    wanted = {_alpha_candidate_id(alpha_id): alpha_id for alpha_id in ALPHA_IDS}
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


def _load_confirm(path: Path) -> dict[str, dict[str, str]]:
    wanted = {f"alpha223_pymoo_nsga3_novelty_{_candidate_suffix(alpha_id)}": alpha_id for alpha_id in ALPHA_IDS}
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


def _alpha_spec(alpha_id: str, row: dict[str, Any], confirm: dict[str, str]) -> dict[str, Any]:
    meta = ALPHA_META[alpha_id]
    terms = []
    for factor_id, weight in zip(row["factor_ids"], row["weights"]):
        signal = RUNTIME_SIGNAL_PATHS.get(factor_id)
        if not signal:
            raise RuntimeError(f"runtime_signal_missing:{alpha_id}:{factor_id}")
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
        "status": "active",
        "owner": "strategy",
        "familyId": meta["familyId"],
        "variantId": meta["variantId"],
        "ownerType": "strategy",
        "promotionStatus": "production",
        "alphaBucket": meta["alphaBucket"],
        "supportedRegimes": ["bull", "sideways", "volatile"],
        "thesis": f"Promoted Alpha223 candidate {_candidate_suffix(alpha_id)} from fixed-contract recursive mining and FinLab confirmation.",
        "thresholds": {
            "minPrice": 10,
            "featureRefs": {
                "weightedScore": {
                    "min": meta["min"],
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
            "Direct active draft only after promotion preflight factor/runtime mapping passes; not applied to remote D1 by this builder.",
            f"FinLab confirm: CAGR {cagr:.1%}, monthly Sharpe {sharpe:.2f}, max drawdown {mdd:.1%}." if cagr is not None and sharpe is not None and mdd is not None else "FinLab confirm metrics unavailable.",
        ],
        "createdBy": "codex_active12_promotion_preflight",
    }


def _fused_spec() -> dict[str, Any]:
    return {
        "id": FUSED_ID,
        "version": "strategy-spec-v1",
        "name": "Trend quality breakout fused",
        "status": "active",
        "owner": "strategy",
        "familyId": "TREND_QUALITY_BREAKOUT_FUSED",
        "variantId": "revenue_trend_squeeze_breakout_fused_v1",
        "ownerType": "strategy",
        "promotionStatus": "production",
        "alphaBucket": "trend_following",
        "supportedRegimes": ["bull", "sideways", "volatile"],
        "thesis": "Fuse the overlapping AlphaBuilders revenue-quality, trend-following, and breakout-volume labels into one diversified trend-quality-breakout owner.",
        "thresholds": {
            "minPrice": 10,
            "dsl": {
                "any": [
                    {"signal": "factorSignals.monthlyRevenueYoY", "op": ">=", "value": 0},
                    {"signal": "technicalIndicators.macdHist", "op": ">=", "value": 0},
                    {"signal": "technicalIndicators.squeezeRelease", "op": ">=", "value": 1},
                ]
            },
            "featureRefs": {
                "weightedScore": {
                    "min": 0.58,
                    "terms": [
                        {"featureRef": "l1_closeAboveMa60Pct", "signal": "factorSignals.finlabCsCloseAboveMa60PctRank", "weight": 0.20},
                        {"featureRef": "l1_volumeExpansion20", "signal": "factorSignals.finlabCsVolumeExpansion20Rank", "weight": 0.20},
                        {"featureRef": "l1_return20d", "signal": "factorSignals.finlabCsReturn20dRank", "weight": 0.16},
                        {"featureRef": "l1_bbBandwidthPct", "signal": "factorSignals.finlabCsBbBandwidthPctRank", "weight": 0.14},
                        {"featureRef": "l1_monthlyRevenueYoY", "signal": "factorSignals.finlabCsMonthlyRevenueYoYRank", "weight": 0.16},
                        {"featureRef": "l1_monthlyRevenueMoM", "signal": "factorSignals.finlabCsMonthlyRevenueMoMRank", "weight": 0.14},
                    ],
                }
            },
        },
        "candidatePolicy": {
            "poolQuota": 18,
            "costBudget": 20,
            "evidenceRequirements": [
                "fused_source:alphabuilders_multifactor_revenue_quality_momentum_v1",
                "fused_source:breakout_vol_expansion_seed_v1",
                "fused_source:trend_following_seed_v1",
            ],
            "maxMlShare": 0.26,
        },
        "riskNotes": [
            "Uses the normalized weighted-score fused variant selected by local full/OOS/cost replay; not applied to remote D1 by this builder.",
        ],
        "createdBy": "codex_active12_promotion_preflight",
    }


def _sql_literal(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, (dict, list)) else str(value)
    return "'" + text.replace("'", "''") + "'"


def _insert_sql(specs: list[dict[str, Any]]) -> str:
    rows = []
    for spec in specs:
        rows.append("(" + ",".join([
            _sql_literal(spec["id"]),
            _sql_literal(spec["version"]),
            _sql_literal(spec["name"]),
            _sql_literal(spec["status"]),
            _sql_literal(spec["owner"]),
            _sql_literal(spec["alphaBucket"]),
            _sql_literal(spec["familyId"]),
            _sql_literal(spec["variantId"]),
            _sql_literal(spec["ownerType"]),
            _sql_literal(spec["promotionStatus"]),
            _sql_literal(spec["supportedRegimes"]),
            _sql_literal(spec["thesis"]),
            _sql_literal(spec["thresholds"]),
            _sql_literal(spec["candidatePolicy"]),
            _sql_literal(spec["riskNotes"]),
            _sql_literal(["active12_promotion_preflight", "alpha223_recursive_search"]),
            _sql_literal(spec["createdBy"]),
            "CURRENT_TIMESTAMP",
            "CURRENT_TIMESTAMP",
        ]) + ")")
    values_sql = ",\n".join(rows)
    retired_sql = ",".join(_sql_literal(item) for item in RETIRE_IDS)
    return f"""-- Draft only. Do not apply without Wei approval and fixed-contract active12 pressure-test evidence.
INSERT INTO strategy_spec_registry (
  strategy_id, version, name, status, owner, alpha_bucket, family_id, variant_id,
  owner_type, promotion_status, supported_regimes_json, thesis, thresholds_json,
  candidate_policy_json, risk_notes_json, source_refs_json, created_by, created_at, updated_at
)
VALUES
{values_sql}
ON CONFLICT(strategy_id, version) DO UPDATE SET
  name=excluded.name,
  status=excluded.status,
  owner=excluded.owner,
  alpha_bucket=excluded.alpha_bucket,
  family_id=excluded.family_id,
  variant_id=excluded.variant_id,
  owner_type=excluded.owner_type,
  promotion_status=excluded.promotion_status,
  supported_regimes_json=excluded.supported_regimes_json,
  thesis=excluded.thesis,
  thresholds_json=excluded.thresholds_json,
  candidate_policy_json=excluded.candidate_policy_json,
  risk_notes_json=excluded.risk_notes_json,
  source_refs_json=excluded.source_refs_json,
  created_by=excluded.created_by,
  updated_at=CURRENT_TIMESTAMP;

UPDATE strategy_spec_registry
   SET status='retired',
       promotion_status='retired',
       updated_at=CURRENT_TIMESTAMP
 WHERE strategy_id IN ({retired_sql});
"""


def build(args: argparse.Namespace) -> dict[str, Any]:
    active11 = json.loads(Path(args.active11_json).read_text(encoding="utf-8"))
    if not isinstance(active11, list):
        raise RuntimeError("active11_json_not_array")
    alpha_rows = _load_alpha_rows(Path(args.alpha_rows_csv))
    confirms = _load_confirm(Path(args.confirm_csv))
    added = [_fused_spec()]
    for alpha_id in ALPHA_IDS:
        added.append(_alpha_spec(alpha_id, alpha_rows[alpha_id], confirms.get(alpha_id, {})))
    kept = [spec for spec in active11 if spec.get("id") not in set(RETIRE_IDS)]
    specs = kept + added
    ids = [spec["id"] for spec in specs]
    errors = []
    if len(ids) != len(set(ids)):
        errors.append("duplicate_strategy_ids")
    if len(specs) != 12:
        errors.append(f"active12_count_mismatch:{len(specs)}")
    for removed in RETIRE_IDS:
        if removed in ids:
            errors.append(f"retired_strategy_not_removed:{removed}")
    return {
        "schema_version": "stockvision-active12-promotion-spec-builder-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "decision_effect": "local_draft_only",
        "strategy_count": len(specs),
        "strategy_ids": ids,
        "retired_strategy_ids": RETIRE_IDS,
        "added_strategy_ids": [spec["id"] for spec in added],
        "broker_reclaim_retired": BROKER_RECLAIM_ID not in ids,
        "errors": errors,
        "specs": specs,
        "sql": _insert_sql(added),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build local active12 draft specs for Alpha223 promotion.")
    parser.add_argument("--active11-json", default=str(DEFAULT_ACTIVE11))
    parser.add_argument("--alpha-rows-csv", default=str(DEFAULT_ALPHA_ROWS))
    parser.add_argument("--confirm-csv", default=str(DEFAULT_CONFIRM))
    parser.add_argument("--output-dir", default=str(DEFAULT_OUT_DIR))
    args = parser.parse_args()
    report = build(args)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    spec_path = out_dir / "active12_candidate_strategy_specs.json"
    summary_path = out_dir / "active12_candidate_strategy_specs_summary.json"
    sql_path = out_dir / "active12_candidate_strategy_registry_draft.sql"
    spec_path.write_text(json.dumps(report["specs"], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sql_path.write_text(report["sql"], encoding="utf-8")
    summary = {key: value for key, value in report.items() if key not in {"specs", "sql"}}
    summary.update({
        "json": _rel(spec_path),
        "sql": _rel(sql_path),
    })
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if not summary["errors"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
