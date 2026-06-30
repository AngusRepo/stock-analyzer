from __future__ import annotations

import argparse
import ast
import csv
import json
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "output" / "strategy_promotion_preflight"

POLICY_PATH = ROOT / "data" / "feature_registry" / "strategy_promotion_factor_gate_policy_v1.json"
REGISTRY_PATH = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
STRATEGY_REF_CONTRACT_PATH = ROOT / "data" / "feature_registry" / "strategy_feature_ref_contract_v1.json"
MATERIALIZATION_AUDIT_PATH = ROOT / "output" / "feature_universe_triage" / "unified137_materialization_audit_sii_20230101_20260615.json"
FINLAB86_CSV = ROOT / "output" / "feature_universe_triage" / "finlab701_recommended_keep_candidates.csv"
ALPHA223_ROWS_CSV = ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_recursive_sii_20230101_20260615_seed42_rows.csv"
ALPHA223_CONFIRM_CSV = ROOT / "output" / "finlab_alpha223_recursive_search" / "alpha223_recursive_sii_20230101_20260615_seed42_finlab_confirm.csv"
ROBUSTNESS_SUMMARY_JSON = ROOT / "output" / "finlab_alpha223_robustness_oos_cost" / "alpha223_robustness_sii_20230101_20260615_summary.json"
REPLACEMENT_DECISIONS_CSV = ROOT / "output" / "finlab_alpha223_robustness_oos_cost" / "alpha223_robustness_sii_20230101_20260615_replacement_decisions.csv"

DEFAULT_ALPHA_IDS = ["alpha223_0248", "alpha223_0109", "alpha223_0166"]
BROKER_RECLAIM_ID = "finlab_ai_skill_broker_accumulation_reclaim_v1"
FUSED_ID = "trend_quality_breakout_fused_v1"
FUSED_SOURCE_IDS = [
    "alphabuilders_multifactor_revenue_quality_momentum_v1",
    "breakout_vol_expansion_seed_v1",
    "trend_following_seed_v1",
]
RUNTIME_SIGNAL_PATHS = {
    "KLOW2": "factorSignals.finlabCsKlow2LowRank",
    "VSTD_10": "factorSignals.finlabCsVstd10Rank",
    "tech_emv_14": "factorSignals.finlabCsTechEmv14Rank",
    "tech_sma_20_pos": "closeAboveMa20Pct",
    "tech_adx_14": "technicalIndicators.adx14",
    "vol_share_turnover_21d": "factorSignals.finlabCsVolShareTurnover21dRank",
    "l1_bestOrderBlockStrength": "factorSignals.finlabCsBestOrderBlockStrengthRank",
    "l1_squeezeRelease": "technicalIndicators.squeezeRelease",
    "l1_bbBandwidthPct": "factorSignals.finlabCsBbBandwidthPctRank",
    "l1_closeAboveMa60Pct": "factorSignals.finlabCsCloseAboveMa60PctRank",
    "l1_volumeExpansion20": "factorSignals.finlabCsVolumeExpansion20Rank",
    "l1_return20d": "factorSignals.finlabCsReturn20dRank",
    "l1_macdHist": "technicalIndicators.macdHist",
    "l1_diTrend": "technicalIndicators.diTrend",
    "l1_squeezeMomentum": "technicalIndicators.squeezeMomentum",
    "l1_monthlyRevenueYoY": "factorSignals.finlabCsMonthlyRevenueYoYRank",
    "l1_monthlyRevenueMoM": "factorSignals.finlabCsMonthlyRevenueMoMRank",
    "vola_cv_90d": "factorSignals.finlabCsVolaCv90dLowRank",
    "tech_roc_10": "factorSignals.finlabCsTechRoc10Rank",
    "tech_gap_down": "factorSignals.finlabCsTechGapDownRank",
    "KSFT": "factorSignals.finlabCsKsftLowRank",
    "l1_brokerNetAmount5d": "factorSignals.finlabCsBrokerNetAmount5dRank",
    "finlab701_fundamental_features_EBITDA": "factorSignals.finlabCsEbitdaRank",
    "finlab701_financial_statement_非流動資產": "factorSignals.finlabCsNonCurrentAssetsRank",
    "finlab701_financial_statement_本期現金及約當現金增加_減少_數": "factorSignals.finlabCsCashAndCashEquivalentsIncreaseDecreaseRank",
    "finlab701_financial_statement_其他應付款": "factorSignals.finlabCsOtherPayablesRank",
    "finlab701_financial_statement_流動負債": "factorSignals.finlabCsCurrentLiabilitiesRank",
    "finlab701_fundamental_features_每股現金流量": "factorSignals.finlabCsCashFlowPerShareRank",
    "finlab701_financial_statement_不動產廠房及設備": "factorSignals.finlabCsPropertyPlantEquipmentRank",
    "finlab701_financial_statement_營業費用": "factorSignals.finlabCsOperatingExpensesRank",
    "finlab701_fundamental_features_每股稅前淨利": "factorSignals.finlabCsPretaxIncomePerShareRank",
    "finlab701_financial_statement_營業活動之淨現金流入_流出": "factorSignals.finlabCsOperatingCashFlowStatementRank",
    "finlab701_fundamental_features_營運資金": "factorSignals.finlabCsWorkingCapitalRank",
    "finlab701_fundamental_features_自由現金流量": "factorSignals.finlabCsFreeCashFlowRank",
    "finlab701_financial_statement_財務成本": "factorSignals.finlabCsFinancialCostRank",
}


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise RuntimeError(f"invalid_json_object:{path}")
    return data


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = sorted({key for row in rows for key in row.keys()})
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _literal_list(value: str) -> list[Any]:
    parsed = ast.literal_eval(value)
    if not isinstance(parsed, list):
        raise RuntimeError(f"expected_list:{value[:80]}")
    return parsed


def _safe_float(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n else None


def _safe_int(value: Any) -> int | None:
    n = _safe_float(value)
    return None if n is None else int(n)


def _candidate_suffix(alpha_id: str) -> str:
    return alpha_id.rsplit("_", 1)[-1]


def _alpha_candidate_id(alpha_id: str) -> str:
    return f"pymoo_nsga3_novelty_{_candidate_suffix(alpha_id)}"


def _load_registry(path: Path) -> dict[str, dict[str, Any]]:
    data = _load_json(path)
    return {
        str(row.get("feature_id")): row
        for row in data.get("features", [])
        if isinstance(row, dict) and row.get("feature_id")
    }


def _load_finlab86(path: Path) -> dict[str, dict[str, str]]:
    rows = _read_csv(path)
    return {str(row.get("api_key") or ""): row for row in rows if row.get("api_key")}


def finlab701_api_key(factor_id: str) -> str | None:
    prefix = "finlab701_"
    if not factor_id.startswith(prefix):
        return None
    rest = factor_id[len(prefix):]
    for namespace in ("financial_statement", "fundamental_features"):
        head = f"{namespace}_"
        if rest.startswith(head):
            return f"{namespace}:{rest[len(head):]}"
    return None


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


def _load_confirm_rows(path: Path, alpha_ids: list[str]) -> dict[str, dict[str, str]]:
    wanted = {f"alpha223_pymoo_nsga3_novelty_{_candidate_suffix(alpha_id)}": alpha_id for alpha_id in alpha_ids}
    out: dict[str, dict[str, str]] = {}
    for row in _read_csv(path):
        alpha_id = wanted.get(str(row.get("id") or ""))
        if alpha_id:
            out[alpha_id] = row
    return out


def _load_replacement_rows(path: Path, alpha_ids: list[str]) -> dict[str, dict[str, str]]:
    wanted = set(alpha_ids)
    out: dict[str, dict[str, str]] = {}
    for row in _read_csv(path):
        if row.get("removed_id") == BROKER_RECLAIM_ID and row.get("added_id") in wanted:
            out[str(row["added_id"])] = row
    return out


def _artifact_factor_stats(artifact: dict[str, Any], factor_id: str) -> dict[str, Any] | None:
    stats = artifact.get("factor_stats")
    if isinstance(stats, dict):
        value = stats.get(factor_id)
        if isinstance(value, dict):
            return value
    coverage = artifact.get("coverage_by_factor")
    if isinstance(coverage, dict) and factor_id in coverage:
        return {"coverage": coverage.get(factor_id)}
    return None


def _infer_factor_type(*, factor_id: str, registry_row: dict[str, Any] | None, finlab_row: dict[str, str] | None) -> str:
    if finlab_row is not None:
        return str(finlab_row.get("group") or finlab_row.get("dataset_lane") or "fundamental_factor_diversity")
    if registry_row is None:
        return "missing"
    category = str(registry_row.get("category") or "")
    source = str(registry_row.get("source_system") or "")
    if category:
        return category
    if source == "stockvision_l1":
        return "l1_signal"
    return "unknown"


def _gate_for_factor(policy: dict[str, Any], factor_id: str, factor_type: str) -> dict[str, Any]:
    defaults = policy.get("defaults_by_factor_type") if isinstance(policy.get("defaults_by_factor_type"), dict) else {}
    by_factor = policy.get("by_factor") if isinstance(policy.get("by_factor"), dict) else {}
    override = by_factor.get(factor_id) if isinstance(by_factor.get(factor_id), dict) else {}
    effective_type = str(override.get("factor_type") or factor_type)
    base = defaults.get(effective_type) if isinstance(defaults.get(effective_type), dict) else {}
    return {
        "factor_type": effective_type,
        "coverage_min": float(override.get("coverage_min", base.get("coverage_min", 0.9))),
        "min_unique_values": int(override.get("min_unique_values", base.get("min_unique_values", 20))),
        "exact_stats_required": bool(override.get("exact_stats_required", base.get("exact_stats_required", True))),
        "asof_lag_rule": str(override.get("asof_lag_rule", base.get("asof_lag_rule", "unspecified"))),
    }


def _runtime_field_path(factor_id: str, source_type: str) -> str:
    if source_type == "runtime_gate":
        return factor_id
    return RUNTIME_SIGNAL_PATHS.get(factor_id, "")


def _factor_direction(factor_id: str, runtime_field_path: str, weight: float | None) -> str:
    if factor_id.startswith("runtime_gate."):
        return "required_gate_present"
    if "Klow2LowRank" in runtime_field_path:
        return "lower_raw_value_ranked_higher"
    if "finlabCs" in runtime_field_path or runtime_field_path.endswith("Rank"):
        return "higher_rank_better"
    if weight is not None and weight < 0:
        return "lower_value_better"
    if weight is not None:
        return "higher_value_better"
    return "source_strategy_threshold_direction"


def _factor_transform(factor_id: str, runtime_field_path: str, weight: float | None) -> str:
    if factor_id.startswith("runtime_gate."):
        return "runtime_presence_gate"
    if "finlabCs" in runtime_field_path or runtime_field_path.endswith("Rank"):
        return "finlab_style_cross_sectional_rank"
    if weight is not None:
        return "weighted_score_component"
    if runtime_field_path.startswith("technicalIndicators."):
        return "technical_indicator_threshold"
    if runtime_field_path.startswith("factorSignals."):
        return "factor_signal_threshold"
    return "source_strategy_feature_ref_threshold"


def _factor_threshold(strategy_id: str, factor_id: str, weight: float | None, source: str) -> str:
    if factor_id.startswith("runtime_gate."):
        return "required_for_runtime_price_or_universe_gate"
    if strategy_id in DEFAULT_ALPHA_IDS:
        return f"alpha223_weighted_score_min=0.58;component_weight={weight:.6f}" if weight is not None else "alpha223_weighted_score_min=0.58"
    if strategy_id == FUSED_ID:
        return "fused_source_threshold_or_active12_fused_spec_gate"
    return source


def _factor_contract_row(
    *,
    strategy_id: str,
    source_strategy_id: str | None,
    factor_id: str,
    weight: float | None,
    policy: dict[str, Any],
    registry: dict[str, dict[str, Any]],
    finlab86: dict[str, dict[str, str]],
    materialization: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    if factor_id.startswith("runtime_gate."):
        gate = _gate_for_factor(policy, factor_id, "runtime_gate")
        return {
            "strategy_id": strategy_id,
            "source_strategy_id": source_strategy_id or "",
            "factor_id": factor_id,
            "weight": weight,
            "source": source,
            "source_type": "runtime_gate",
            "normalized_feature_id": "",
            "runtime_field_path": factor_id,
            "factor_type": gate["factor_type"],
            "coverage_min": gate["coverage_min"],
            "coverage_actual": None,
            "coverage_status": "not_applicable_runtime_gate",
            "min_unique_values": gate["min_unique_values"],
            "unique_values_actual": None,
            "mapping_ok": True,
            "runtime_mapping_ok": True,
            "coverage_ok": True,
            "unique_ok": True,
            "direction": _factor_direction(factor_id, factor_id, weight),
            "transform": _factor_transform(factor_id, factor_id, weight),
            "threshold": _factor_threshold(strategy_id, factor_id, weight, source),
            "gate_ok": True,
            "blocker": "",
        }

    registry_row = registry.get(factor_id)
    finlab_key = finlab701_api_key(factor_id)
    finlab_row = finlab86.get(finlab_key or "")
    source_type = "formal137" if registry_row is not None else "finlab701" if finlab_row is not None else "missing"
    factor_type = _infer_factor_type(factor_id=factor_id, registry_row=registry_row, finlab_row=finlab_row)
    gate = _gate_for_factor(policy, factor_id, factor_type)
    normalized_feature_id = factor_id if registry_row is not None else f"finlab701:{finlab_key}" if finlab_key else ""
    runtime_field_path = _runtime_field_path(factor_id, source_type)

    mapping_ok = source_type != "missing"
    runtime_mapping_ok = source_type == "runtime_gate" or bool(runtime_field_path)
    coverage_actual: float | None = None
    unique_values_actual: int | None = None
    exact_missing = False
    if source_type == "finlab701" and finlab_row is not None:
        coverage_actual = _safe_float(finlab_row.get("coverage"))
        unique_values_actual = _safe_int(finlab_row.get("trade_count"))
    elif source_type == "formal137":
        stats = _artifact_factor_stats(materialization, factor_id)
        if stats is None:
            exact_missing = gate["exact_stats_required"]
        else:
            coverage_actual = _safe_float(stats.get("coverage"))
            unique_values_actual = _safe_int(stats.get("unique_values"))

    coverage_ok = True
    coverage_status = "ok"
    if not mapping_ok:
        coverage_ok = False
        coverage_status = "missing_mapping"
    elif exact_missing:
        coverage_ok = False
        coverage_status = "exact_factor_stats_missing"
    elif coverage_actual is None:
        coverage_ok = not gate["exact_stats_required"]
        coverage_status = "coverage_not_required" if coverage_ok else "coverage_missing"
    elif coverage_actual < gate["coverage_min"]:
        coverage_ok = False
        coverage_status = "below_min"

    unique_ok = True
    if not mapping_ok:
        unique_ok = False
    elif unique_values_actual is None:
        unique_ok = not gate["exact_stats_required"]
    elif unique_values_actual < gate["min_unique_values"]:
        unique_ok = False

    blocker = ""
    if not mapping_ok:
        blocker = "factor_mapping_missing"
    elif not runtime_mapping_ok:
        blocker = "runtime_mapping_missing"
    elif not coverage_ok:
        blocker = coverage_status
    elif not unique_ok:
        blocker = "unique_values_below_min"

    return {
        "strategy_id": strategy_id,
        "source_strategy_id": source_strategy_id or "",
        "factor_id": factor_id,
        "weight": weight,
        "source": source,
        "source_type": source_type,
        "normalized_feature_id": normalized_feature_id,
        "runtime_field_path": runtime_field_path,
        "factor_type": gate["factor_type"],
        "category": registry_row.get("category") if registry_row else finlab_row.get("group") if finlab_row else "",
        "source_system": registry_row.get("source_system") if registry_row else "finlab701_research_supplement" if finlab_row else "",
        "selector_role": registry_row.get("selector_role") if registry_row else "",
        "coverage_min": gate["coverage_min"],
        "coverage_actual": coverage_actual,
        "coverage_status": coverage_status,
        "min_unique_values": gate["min_unique_values"],
        "unique_values_actual": unique_values_actual,
        "asof_lag_rule": gate["asof_lag_rule"],
        "direction": _factor_direction(factor_id, runtime_field_path, weight),
        "transform": _factor_transform(factor_id, runtime_field_path, weight),
        "threshold": _factor_threshold(strategy_id, factor_id, weight, source),
        "mapping_ok": mapping_ok,
        "runtime_mapping_ok": runtime_mapping_ok,
        "coverage_ok": coverage_ok,
        "unique_ok": unique_ok,
        "gate_ok": mapping_ok and runtime_mapping_ok and coverage_ok and unique_ok,
        "blocker": blocker,
        "finlab701_api_key": finlab_key or "",
    }


def _fused_factor_rows(
    *,
    policy: dict[str, Any],
    registry: dict[str, dict[str, Any]],
    finlab86: dict[str, dict[str, str]],
    materialization: dict[str, Any],
    strategy_ref_contract: dict[str, Any],
) -> list[dict[str, Any]]:
    refs = strategy_ref_contract.get("refs") if isinstance(strategy_ref_contract.get("refs"), list) else []
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for ref in refs:
        if not isinstance(ref, dict) or ref.get("strategy_id") not in FUSED_SOURCE_IDS:
            continue
        if ref.get("ref_type") == "runtime_gate":
            factor_id = str(ref.get("runtime_signal") or "runtime_gate.unknown")
        else:
            factor_id = str(ref.get("feature_id") or ref.get("feature_ref") or ref.get("runtime_signal") or "")
        if not factor_id:
            continue
        key = (str(ref.get("strategy_id")), factor_id)
        if key in seen:
            continue
        seen.add(key)
        rows.append(_factor_contract_row(
            strategy_id=FUSED_ID,
            source_strategy_id=str(ref.get("strategy_id") or ""),
            factor_id=factor_id,
            weight=None,
            policy=policy,
            registry=registry,
            finlab86=finlab86,
            materialization=materialization,
            source="fused_source_strategy_feature_refs",
        ))
    return rows


def _resolve_artifact_path(raw_path: Any, base_path: Path | None) -> Path | None:
    if not raw_path:
        return None
    path = Path(str(raw_path))
    if path.is_absolute():
        return path
    if base_path is not None:
        candidate = base_path.parent / path
        if candidate.exists():
            return candidate
    return ROOT / path


def _robustness_config(summary: dict[str, Any], summary_path: Path | None = None) -> dict[str, Any]:
    config = summary.get("config")
    if isinstance(config, dict):
        return config
    full_path = _resolve_artifact_path(summary.get("json"), summary_path)
    if full_path is None or not full_path.exists():
        return {}
    full = _load_json(full_path)
    full_config = full.get("config")
    return full_config if isinstance(full_config, dict) else {}


def _validate_fixed_contract(
    summary: dict[str, Any],
    policy: dict[str, Any],
    summary_path: Path | None = None,
) -> list[str]:
    config = _robustness_config(summary, summary_path)
    contract = ((policy.get("policy") or {}).get("fixed_backtest_contract") or {})
    errors: list[str] = []
    for key in ("start_date", "end_date", "universe", "resample", "top_k"):
        if str(config.get(key)) != str(contract.get(key)):
            errors.append(f"fixed_contract_mismatch:{key}:{config.get(key)}!={contract.get(key)}")
    expected_bps = {int(item) for item in contract.get("required_extra_slippage_bps") or []}
    actual_bps = {int(item) for item in config.get("extra_slippage_bps") or []}
    missing_bps = sorted(expected_bps - actual_bps)
    if missing_bps:
        errors.append(f"fixed_contract_missing_extra_slippage_bps:{missing_bps}")
    return errors


def _strategy_summary(
    *,
    strategy_id: str,
    factor_rows: list[dict[str, Any]],
    replacement_rows: dict[str, dict[str, str]],
    confirm_rows: dict[str, dict[str, str]],
) -> dict[str, Any]:
    rows = [row for row in factor_rows if row["strategy_id"] == strategy_id]
    blockers = [row for row in rows if row.get("blocker")]
    replacement = replacement_rows.get(strategy_id)
    confirm = confirm_rows.get(strategy_id)
    replacement_ok = True
    performance_contract_ok = True
    performance_status = "ok"
    if strategy_id.startswith("alpha223_"):
        replacement_ok = bool(
            replacement
            and replacement.get("decision") == "promote_replacement_candidate"
            and str(replacement.get("pass_count_6")) == "6"
        )
    elif strategy_id == FUSED_ID:
        performance_contract_ok = False
        performance_status = "fused_backtest_pending"
    return {
        "strategy_id": strategy_id,
        "factor_count": len(rows),
        "factor_gate_ok": not blockers,
        "factor_blocker_count": len(blockers),
        "factor_blockers": [row["factor_id"] + ":" + row["blocker"] for row in blockers],
        "replacement_decision_ok": replacement_ok,
        "replacement_decision": replacement.get("decision") if replacement else None,
        "replacement_pass_count_6": replacement.get("pass_count_6") if replacement else None,
        "performance_contract_ok": performance_contract_ok,
        "performance_status": performance_status,
        "finlab_confirm_status": confirm.get("status") if confirm else None,
        "finlab_confirm_cagr": _safe_float(confirm.get("cagr")) if confirm else None,
        "finlab_confirm_monthly_sharpe": _safe_float(confirm.get("monthly_sharpe")) if confirm else None,
        "promotion_ready": (not blockers) and replacement_ok and performance_contract_ok,
    }


def build_report(args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    policy = _load_json(Path(args.policy))
    registry = _load_registry(Path(args.registry))
    finlab86 = _load_finlab86(Path(args.finlab86_csv))
    materialization = _load_json(Path(args.materialization_audit))
    strategy_ref_contract = _load_json(Path(args.strategy_ref_contract))
    alpha_ids = [item.strip() for item in args.alpha_ids.split(",") if item.strip()]
    alpha_rows = _load_alpha_rows(Path(args.alpha223_rows_csv), alpha_ids)
    confirm_rows = _load_confirm_rows(Path(args.alpha223_confirm_csv), alpha_ids)
    replacement_rows = _load_replacement_rows(Path(args.replacement_decisions_csv), alpha_ids)
    robustness_summary = _load_json(Path(args.robustness_summary_json))

    factor_rows: list[dict[str, Any]] = []
    for alpha_id in alpha_ids:
        alpha = alpha_rows.get(alpha_id)
        if not alpha:
            factor_rows.append({
                "strategy_id": alpha_id,
                "factor_id": "",
                "source": "alpha223_recursive_rows",
                "source_type": "missing",
                "mapping_ok": False,
                "coverage_ok": False,
                "unique_ok": False,
                "gate_ok": False,
                "blocker": "alpha223_candidate_row_missing",
            })
            continue
        for factor_id, weight in zip(alpha["factor_ids"], alpha["weights"]):
            factor_rows.append(_factor_contract_row(
                strategy_id=alpha_id,
                source_strategy_id=None,
                factor_id=factor_id,
                weight=weight,
                policy=policy,
                registry=registry,
                finlab86=finlab86,
                materialization=materialization,
                source="alpha223_recursive_rows",
            ))
    factor_rows.extend(_fused_factor_rows(
        policy=policy,
        registry=registry,
        finlab86=finlab86,
        materialization=materialization,
        strategy_ref_contract=strategy_ref_contract,
    ))

    robustness_summary_path = Path(args.robustness_summary_json)
    robustness_config = _robustness_config(robustness_summary, robustness_summary_path)
    fixed_contract_errors = _validate_fixed_contract(robustness_summary, policy, robustness_summary_path)
    strategy_ids = alpha_ids + [FUSED_ID]
    strategies = [
        _strategy_summary(
            strategy_id=strategy_id,
            factor_rows=factor_rows,
            replacement_rows=replacement_rows,
            confirm_rows=confirm_rows,
        )
        for strategy_id in strategy_ids
    ]
    factor_blockers = [row for row in factor_rows if row.get("blocker")]
    source_counts = Counter(str(row.get("source_type") or "unknown") for row in factor_rows)
    blocker_counts = Counter(str(row.get("blocker") or "none") for row in factor_rows)
    report = {
        "schema_version": "stockvision-strategy-promotion-preflight-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "allowed_use": "research_and_promotion_preflight_only",
        "decision_effect": "none",
        "policy": {
            "active12_first": True,
            "candidate12": "current11 - trio + trend_quality_breakout_fused_v1 + alpha223_0248 + alpha223_0109 + alpha223_0166 + keep BrokerReclaim",
            "candidate11_no_broker": "Candidate12 - BrokerReclaim, only after same-contract pressure test",
            "direct_active_if_wins": True,
            "shadow_required_after_win": False,
        },
        "source_files": {
            "policy": _rel(Path(args.policy)),
            "registry": _rel(Path(args.registry)),
            "strategy_ref_contract": _rel(Path(args.strategy_ref_contract)),
            "materialization_audit": _rel(Path(args.materialization_audit)),
            "finlab86_csv": _rel(Path(args.finlab86_csv)),
            "alpha223_rows_csv": _rel(Path(args.alpha223_rows_csv)),
            "alpha223_confirm_csv": _rel(Path(args.alpha223_confirm_csv)),
            "robustness_summary_json": _rel(Path(args.robustness_summary_json)),
            "replacement_decisions_csv": _rel(Path(args.replacement_decisions_csv)),
        },
        "fixed_backtest_contract": {
            "errors": fixed_contract_errors,
            "ok": not fixed_contract_errors,
            "config": robustness_config,
        },
        "materialization_contract": {
            "artifact_pass": materialization.get("pass") is True,
            "has_factor_stats": isinstance(materialization.get("factor_stats"), dict),
            "counts": materialization.get("counts"),
        },
        "counts": {
            "strategies": len(strategy_ids),
            "factor_rows": len(factor_rows),
            "factor_blockers": len(factor_blockers),
            "source_type_counts": dict(source_counts),
            "blocker_counts": dict(blocker_counts),
        },
        "strategies": strategies,
        "promotion_ready": not fixed_contract_errors and not factor_blockers and all(row["promotion_ready"] for row in strategies),
        "next_action": "Rebuild unified137 materialization audit after this patch to populate factor_stats, then rerun preflight." if not isinstance(materialization.get("factor_stats"), dict) else "Run fixed-contract portfolio scenario pressure tests.",
    }
    return report, factor_rows


def main() -> int:
    parser = argparse.ArgumentParser(description="Promotion preflight for active12 strategy changes and factor mapping gates.")
    parser.add_argument("--policy", default=str(POLICY_PATH))
    parser.add_argument("--registry", default=str(REGISTRY_PATH))
    parser.add_argument("--strategy-ref-contract", default=str(STRATEGY_REF_CONTRACT_PATH))
    parser.add_argument("--materialization-audit", default=str(MATERIALIZATION_AUDIT_PATH))
    parser.add_argument("--finlab86-csv", default=str(FINLAB86_CSV))
    parser.add_argument("--alpha223-rows-csv", default=str(ALPHA223_ROWS_CSV))
    parser.add_argument("--alpha223-confirm-csv", default=str(ALPHA223_CONFIRM_CSV))
    parser.add_argument("--robustness-summary-json", default=str(ROBUSTNESS_SUMMARY_JSON))
    parser.add_argument("--replacement-decisions-csv", default=str(REPLACEMENT_DECISIONS_CSV))
    parser.add_argument("--alpha-ids", default=",".join(DEFAULT_ALPHA_IDS))
    parser.add_argument("--output-dir", default=str(OUT_DIR))
    args = parser.parse_args()

    started = time.time()
    report, factor_rows = build_report(args)
    report["runtime_seconds"] = round(time.time() - started, 3)

    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "active12_promotion_preflight_latest.json"
    csv_path = out_dir / "active12_promotion_factor_contract_latest.csv"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    _write_csv(factor_rows, csv_path)
    print(json.dumps({
        "json": _rel(json_path),
        "csv": _rel(csv_path),
        "promotion_ready": report["promotion_ready"],
        "counts": report["counts"],
        "next_action": report["next_action"],
    }, ensure_ascii=False, indent=2))
    return 0 if report["promotion_ready"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
