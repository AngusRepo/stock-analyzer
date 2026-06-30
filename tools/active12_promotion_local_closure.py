from __future__ import annotations

import csv
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
FINAL_DIR = ROOT / "output" / "strategy_promotion_preflight" / "final_active12_decision"
SCENARIO_DIR = ROOT / "output" / "strategy_promotion_preflight" / "portfolio_scenarios_final_active12_decision"
FEATURE_CLOSURE = ROOT / "output" / "feature_universe_triage" / "feature_registry_local_closure_20260617.json"

BASELINE_SCENARIO = "Candidate11_noBroker"
FINAL_SCENARIO = "FinalActive12_retire_trio_Broker_S11_add_fused_0248_0109_0166_0283_0009"

EXPECTED_ACTIVE = [
    "alpha_miner_pymoo_nsga3_novelty_0193",
    "defensive_accumulation_seed_v1",
    "stock_tech_s01_55d_trend_volume_breakout_v1",
    "stock_tech_s02_52w_dual_momentum_v1",
    "stock_tech_s04_ma_deduct_turn_breakout_v1",
    "stock_tech_s06_nr7_inside_bar_breakout_v1",
    "trend_quality_breakout_fused_v1",
    "alpha223_0248",
    "alpha223_0109",
    "alpha223_0166",
    "alpha223_0283",
    "alpha223_0009",
]
NEW_STRATEGIES = {
    "trend_quality_breakout_fused_v1",
    "alpha223_0248",
    "alpha223_0109",
    "alpha223_0166",
    "alpha223_0283",
    "alpha223_0009",
}
RETIRED = [
    "alphabuilders_multifactor_revenue_quality_momentum_v1",
    "breakout_vol_expansion_seed_v1",
    "trend_following_seed_v1",
    "finlab_ai_skill_broker_accumulation_reclaim_v1",
    "stock_tech_s11_gap_breakout_continuation_v1",
]
CURRENT_REMOTE_ACTIVE11 = [
    "alpha_miner_pymoo_nsga3_novelty_0193",
    "alphabuilders_multifactor_revenue_quality_momentum_v1",
    "breakout_vol_expansion_seed_v1",
    "defensive_accumulation_seed_v1",
    "finlab_ai_skill_broker_accumulation_reclaim_v1",
    "stock_tech_s01_55d_trend_volume_breakout_v1",
    "stock_tech_s02_52w_dual_momentum_v1",
    "stock_tech_s04_ma_deduct_turn_breakout_v1",
    "stock_tech_s06_nr7_inside_bar_breakout_v1",
    "stock_tech_s11_gap_breakout_continuation_v1",
    "trend_following_seed_v1",
]
ALLOWED_UNSUPPORTED = {
    "alpha_miner_pymoo_nsga3_novelty_0193",
    "stock_tech_s01_55d_trend_volume_breakout_v1",
    "stock_tech_s02_52w_dual_momentum_v1",
    "stock_tech_s04_ma_deduct_turn_breakout_v1",
    "stock_tech_s06_nr7_inside_bar_breakout_v1",
}
RUNTIME_SOURCE_EXPECTATIONS = {
    "worker/src/lib/strategySpec.ts": [
        "finlabCsKsftLowRank",
        "finlabCsBrokerNetAmount5dRank",
        "finlabCsTechRoc10Rank",
        "finlabCsTechGapDownRank",
        "finlabCsVolaCv90dLowRank",
        "finlabCsNonCurrentAssetsRank",
        "finlabCsCashAndCashEquivalentsIncreaseDecreaseRank",
        "finlabCsOtherPayablesRank",
    ],
    "worker/src/lib/marketScreener.ts": [
        "rawField: 'KSFT'",
        "rawField: 'techRoc10'",
        "rawField: 'techGapDown'",
        "rawField: 'volaCv90d'",
        "rawField: 'brokerNetAmount5d'",
        "rawField: 'nonCurrentAssets'",
        "rawField: 'cashAndCashEquivalentsIncreaseDecrease'",
        "rawField: 'otherPayables'",
    ],
    "worker/src/lib/formal137FeatureMaterialization.ts": [
        "finlabCsKsftLowRank",
        "finlabCsBrokerNetAmount5dRank",
        "finlabCsTechRoc10Rank",
        "finlabCsTechGapDownRank",
        "finlabCsVolaCv90dLowRank",
    ],
}


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def _json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def _csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _float(value: Any, default: float = 0.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed == parsed else default


def _check(checks: list[dict[str, Any]], check_id: str, passed: bool, detail: dict[str, Any]) -> None:
    checks.append({"id": check_id, "passed": bool(passed), "detail": detail})


def _rows_by_strategy(path: Path) -> dict[str, dict[str, str]]:
    return {str(row.get("strategy_id")): row for row in _csv(path)}


def _dry_run_registry_sql() -> dict[str, Any]:
    sql_path = FINAL_DIR / "active12_candidate_strategy_registry_draft.sql"
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE strategy_spec_registry (
          strategy_id TEXT NOT NULL,
          version TEXT NOT NULL,
          name TEXT,
          status TEXT,
          owner TEXT,
          alpha_bucket TEXT,
          family_id TEXT,
          variant_id TEXT,
          owner_type TEXT,
          promotion_status TEXT,
          supported_regimes_json TEXT,
          thesis TEXT,
          thresholds_json TEXT,
          candidate_policy_json TEXT,
          risk_notes_json TEXT,
          source_refs_json TEXT,
          created_by TEXT,
          created_at TEXT,
          updated_at TEXT,
          PRIMARY KEY(strategy_id, version)
        );
        """
    )
    for sid in CURRENT_REMOTE_ACTIVE11:
        conn.execute(
            """
            INSERT INTO strategy_spec_registry(
              strategy_id, version, name, status, owner, alpha_bucket, family_id, variant_id,
              owner_type, promotion_status, supported_regimes_json, thesis, thresholds_json,
              candidate_policy_json, risk_notes_json, source_refs_json, created_by, created_at, updated_at
            ) VALUES (?, 'strategy-spec-v1', ?, 'active', 'strategy', 'baseline', 'BASE', ?,
              'strategy', 'production', '[]', '', '{}', '{}', '[]', '[]', 'seed',
              CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (sid, sid, sid),
        )
    conn.executescript(sql_path.read_text(encoding="utf-8"))
    rows = conn.execute(
        "SELECT strategy_id, status, promotion_status FROM strategy_spec_registry ORDER BY strategy_id"
    ).fetchall()
    active_ids = [row[0] for row in rows if row[1] == "active"]
    retired_rows = {
        row[0]: {"status": row[1], "promotion_status": row[2]}
        for row in rows
        if row[0] in RETIRED
    }
    return {
        "sql": _rel(sql_path),
        "active_count": len(active_ids),
        "active_ids": active_ids,
        "missing_expected_active": sorted(set(EXPECTED_ACTIVE) - set(active_ids)),
        "unexpected_active": sorted(set(active_ids) - set(EXPECTED_ACTIVE)),
        "retired_rows": retired_rows,
        "retired_still_active": sorted([sid for sid in RETIRED if sid in active_ids]),
    }


def _scenario_metric(rows: list[dict[str, str]], period: str, bps: float, scenario_id: str) -> dict[str, str]:
    for row in rows:
        if (
            row.get("period") == period
            and row.get("scenario_id") == scenario_id
            and _float(row.get("extra_slippage_bps")) == bps
        ):
            return row
    return {}


def build_report() -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

    summary = _json(FINAL_DIR / "active12_candidate_strategy_specs_summary.json")
    active_ids = set(summary.get("strategy_ids") or [])
    _check(
        checks,
        "final_active12_draft_shape_pass",
        summary.get("strategy_count") == 12
        and active_ids == set(EXPECTED_ACTIVE)
        and set(summary.get("retired_strategy_ids") or []) == set(RETIRED)
        and set(summary.get("added_strategy_ids") or []) == NEW_STRATEGIES
        and summary.get("broker_reclaim_retired") is True
        and not summary.get("errors"),
        {
            "strategy_count": summary.get("strategy_count"),
            "strategy_ids": summary.get("strategy_ids"),
            "retired_strategy_ids": summary.get("retired_strategy_ids"),
            "added_strategy_ids": summary.get("added_strategy_ids"),
            "broker_reclaim_retired": summary.get("broker_reclaim_retired"),
            "errors": summary.get("errors"),
        },
    )

    sql_dry_run = _dry_run_registry_sql()
    _check(
        checks,
        "registry_sql_dry_run_exact_active12_pass",
        sql_dry_run["active_count"] == 12
        and not sql_dry_run["missing_expected_active"]
        and not sql_dry_run["unexpected_active"]
        and not sql_dry_run["retired_still_active"]
        and all(row["status"] == "retired" and row["promotion_status"] == "retired" for row in sql_dry_run["retired_rows"].values()),
        sql_dry_run,
    )

    specs = json.loads((FINAL_DIR / "active12_candidate_strategy_specs.json").read_text(encoding="utf-8"))
    new_spec_rows: list[dict[str, Any]] = []
    spec_errors: list[str] = []
    for spec in specs:
        sid = spec.get("id")
        if sid not in NEW_STRATEGIES:
            continue
        terms = (((spec.get("thresholds") or {}).get("featureRefs") or {}).get("weightedScore") or {}).get("terms") or []
        missing = []
        if spec.get("status") != "active":
            missing.append("status")
        if spec.get("promotionStatus") != "production":
            missing.append("promotionStatus")
        if not terms:
            missing.append("weighted_terms")
        if any(not term.get("featureRef") or not term.get("signal") for term in terms):
            missing.append("featureRef_or_signal")
        spec_errors.extend([f"{sid}:{field}" for field in sorted(set(missing))])
        new_spec_rows.append({"id": sid, "weighted_terms": len(terms), "missing": sorted(set(missing))})
    _check(
        checks,
        "new_strategy_spec_contract_pass",
        len(new_spec_rows) == len(NEW_STRATEGIES) and not spec_errors,
        {"rows": new_spec_rows, "errors": spec_errors},
    )

    missing_runtime_source: list[dict[str, str]] = []
    for rel_path, patterns in RUNTIME_SOURCE_EXPECTATIONS.items():
        source = (ROOT / rel_path).read_text(encoding="utf-8")
        for pattern in patterns:
            if pattern not in source:
                missing_runtime_source.append({"file": rel_path, "pattern": pattern})
    _check(
        checks,
        "runtime_source_mapping_mentions_pass",
        not missing_runtime_source,
        {"missing": missing_runtime_source, "files": sorted(RUNTIME_SOURCE_EXPECTATIONS)},
    )

    replay_summary = _json(FINAL_DIR / "finlab_strategy_spec_active12_20230101_20260615_summary.json")
    replay_rows = _rows_by_strategy(FINAL_DIR / "finlab_strategy_spec_active12_20230101_20260615.csv")
    new_replay_rows = {sid: replay_rows.get(sid) for sid in sorted(NEW_STRATEGIES)}
    unsupported = {sid for sid, row in replay_rows.items() if row.get("status") == "unsupported_feature"}
    new_replay_ok = all(
        row is not None
        and row.get("status") == "ok"
        and str(row.get("recent5_all_positive")) == "True"
        and _float(row.get("latest_matches")) > 0
        for row in new_replay_rows.values()
    )
    _check(
        checks,
        "select0_recent5_replay_pass",
        int(replay_summary.get("strategy_count") or 0) == 12
        and int(replay_summary.get("no_signal") or 0) == 0
        and not replay_summary.get("errors")
        and unsupported == ALLOWED_UNSUPPORTED
        and new_replay_ok,
        {
            "summary": replay_summary,
            "unsupported": sorted(unsupported),
            "new_strategy_rows": new_replay_rows,
        },
    )

    extension_gates = _json(FINAL_DIR / "alpha223_extension_gate_summary.json")
    _check(
        checks,
        "alpha223_0283_0009_gate_pass",
        extension_gates.get("all_local_prod_ready_no_partial") is True
        and all(row.get("local_prod_ready_no_partial") is True for row in extension_gates.get("rows") or []),
        extension_gates,
    )

    scenario_rows = _csv(SCENARIO_DIR / "active12_portfolio_scenarios_sii_20230101_20260615_metrics.csv")
    required_scenario_checks = []
    for period, bps in [
        ("full_2023_2026", 0.0),
        ("full_2023_2026", 50.0),
        ("full_2023_2026", 100.0),
        ("validation_2025", 0.0),
        ("validation_2025", 50.0),
        ("validation_2025", 100.0),
        ("holdout_2026_ytd", 0.0),
        ("holdout_2026_ytd", 50.0),
        ("holdout_2026_ytd", 100.0),
    ]:
        row = _scenario_metric(scenario_rows, period, bps, FINAL_SCENARIO)
        baseline = _scenario_metric(scenario_rows, period, bps, BASELINE_SCENARIO)
        required_scenario_checks.append(
            {
                "period": period,
                "bps": bps,
                "final_cagr": _float(row.get("cagr")),
                "baseline_cagr": _float(baseline.get("cagr")),
                "delta_cagr": _float(row.get("delta_cagr")),
                "delta_sharpe": _float(row.get("delta_sharpe")),
                "delta_max_drawdown": _float(row.get("delta_max_drawdown")),
                "passed": bool(row)
                and bool(baseline)
                and _float(row.get("delta_cagr")) > 0
                and _float(row.get("delta_sharpe")) > 0
                and _float(row.get("delta_max_drawdown")) >= -0.035,
            }
        )
    _check(
        checks,
        "portfolio_oos_cost_delta_pass",
        all(row["passed"] for row in required_scenario_checks),
        {"baseline": BASELINE_SCENARIO, "final": FINAL_SCENARIO, "checks": required_scenario_checks},
    )

    feature_closure = _json(FEATURE_CLOSURE)
    _check(
        checks,
        "feature_registry_local_closure_pass",
        feature_closure.get("status") == "pass" and not feature_closure.get("errors"),
        {"path": _rel(FEATURE_CLOSURE), "status": feature_closure.get("status"), "errors": feature_closure.get("errors")},
    )

    failed = [row for row in checks if row["passed"] is not True]
    return {
        "schema_version": "stockvision-final-active12-preprod-closure-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "allowed_use": "local_validation_only",
        "decision_effect": "none",
        "status": "pass" if not failed else "fail",
        "local_closure": "done" if not failed else "blocked",
        "local_prod_ready": "done" if not failed else "blocked",
        "no_partial": not failed,
        "promotion_allowed": False,
        "production_mutation_allowed": False,
        "expected_active": EXPECTED_ACTIVE,
        "retired": RETIRED,
        "checks": checks,
        "failed_checks": failed,
    }


def main() -> int:
    FINAL_DIR.mkdir(parents=True, exist_ok=True)
    report = build_report()
    path = FINAL_DIR / "final_active12_preprod_closure_latest.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "json": _rel(path),
                "status": report["status"],
                "local_closure": report["local_closure"],
                "local_prod_ready": report["local_prod_ready"],
                "no_partial": report["no_partial"],
                "failed_checks": [row["id"] for row in report["failed_checks"]],
                "production_mutation_allowed": report["production_mutation_allowed"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if report["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
