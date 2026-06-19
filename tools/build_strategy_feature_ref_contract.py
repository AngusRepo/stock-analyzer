from __future__ import annotations

import csv
import json
import re
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "data" / "feature_registry" / "unified_feature_registry_v1.json"
STRATEGY_SPEC_TS = ROOT / "worker" / "src" / "lib" / "strategySpec.ts"
MINED_MIGRATION = ROOT / "worker" / "migration_strategy_registry_alpha_miner_2026_06_17.sql"
OUT_DIR = ROOT / "output" / "feature_universe_triage"
REGISTRY_DIR = ROOT / "data" / "feature_registry"


def _rel(path: Path) -> str:
    return path.resolve().relative_to(ROOT.resolve()).as_posix()


DIRECT_THRESHOLD_SIGNAL: dict[str, str] = {
    "minPrice": "runtime_gate.price",
    "maxPrice": "runtime_gate.price",
    "minCloseAboveMa20Pct": "closeAboveMa20Pct",
    "maxCloseAboveMa20Pct": "closeAboveMa20Pct",
    "minCloseAboveMa60Pct": "closeAboveMa60Pct",
    "maxCloseAboveMa60Pct": "closeAboveMa60Pct",
    "minVolumeExpansion20": "volumeExpansion20",
    "minReturn20d": "return20d",
    "maxReturn20d": "return20d",
    "minForeignTrustNet5d": "foreignTrustNet5d",
    "minDealerNet5d": "dealerNet5d",
    "minBrokerNetShares5d": "brokerNetShares5d",
    "minBrokerNetAmount5d": "brokerNetAmount5d",
    "minBrokerCount": "brokerCount",
    "maxBrokerConcentration": "brokerConcentration",
    "minRevenueGrowthYoY": "revenueGrowthYoY",
    "minMonthlyRevenueYoY": "monthlyRevenueYoY",
    "minMonthlyRevenueMoM": "monthlyRevenueMoM",
    "minGrossMargin": "grossMargin",
    "minOperatingMargin": "operatingMargin",
    "minRoe": "roe",
    "minEps": "eps",
    "maxPe": "pe",
    "maxPb": "pb",
}

SIGNAL_TO_FEATURE_ID: dict[str, str] = {
    "closeAboveMa20Pct": "tech_sma_20_pos",
    "closeAboveMa60Pct": "l1_closeAboveMa60Pct",
    "volumeExpansion20": "l1_volumeExpansion20",
    "return20d": "l1_return20d",
    "foreignTrustNet5d": "l1_foreignTrustNet5d",
    "dealerNet5d": "l1_dealerNet5d",
    "brokerNetShares5d": "l1_brokerNetShares5d",
    "brokerNetAmount5d": "l1_brokerNetAmount5d",
    "brokerCount": "l1_brokerCount",
    "brokerConcentration": "l1_brokerConcentration",
    "revenueGrowthYoY": "l1_revenueGrowthYoY",
    "monthlyRevenueYoY": "l1_monthlyRevenueYoY",
    "monthlyRevenueMoM": "l1_monthlyRevenueMoM",
    "grossMargin": "l1_grossMargin",
    "operatingMargin": "l1_operatingMargin",
    "roe": "l1_roe",
    "eps": "l1_eps",
    "pe": "val_ep",
    "pb": "val_bp",
    "technicalIndicators.rsi14": "mom_rsi_14",
    "technicalIndicators.volumeExpansion20": "l1_volumeExpansion20",
    "technicalIndicators.closeAboveMa20Pct": "tech_sma_20_pos",
    "technicalIndicators.macdHist": "l1_macdHist",
    "technicalIndicators.adx14": "tech_adx_14",
    "technicalIndicators.diTrend": "l1_diTrend",
    "technicalIndicators.squeezeRelease": "l1_squeezeRelease",
    "technicalIndicators.squeezeMomentum": "l1_squeezeMomentum",
    "technicalIndicators.bbBandwidthPct": "l1_bbBandwidthPct",
    "factorSignals.monthlyRevenueYoY": "l1_monthlyRevenueYoY",
    "factorSignals.monthlyRevenueMoM": "l1_monthlyRevenueMoM",
    "factorSignals.revenueGrowthYoY": "l1_revenueGrowthYoY",
    "factorSignals.brokerNetAmount5d": "l1_brokerNetAmount5d",
    "factorSignals.brokerCount": "l1_brokerCount",
}

def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = sorted({key for row in rows for key in row.keys()})
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _load_registry(path: Path) -> dict[str, dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return {
        str(row.get("feature_id")): row
        for row in data.get("features", [])
        if isinstance(row, dict) and row.get("feature_id")
    }


def _extract_array_objects(text: str, marker: str) -> list[str]:
    start = text.index(marker)
    assign_start = text.index("=", start)
    arr_start = text.index("[", assign_start)
    depth = 0
    obj_depth = 0
    in_str: str | None = None
    escape = False
    current: list[str] = []
    objects: list[str] = []
    for ch in text[arr_start:]:
        if escape:
            current.append(ch)
            escape = False
            continue
        if ch == "\\" and in_str:
            current.append(ch)
            escape = True
            continue
        if ch in {"'", '"'}:
            current.append(ch)
            if in_str == ch:
                in_str = None
            elif in_str is None:
                in_str = ch
            continue
        if in_str:
            current.append(ch)
            continue
        if ch == "[":
            depth += 1
            if obj_depth:
                current.append(ch)
            continue
        if ch == "]":
            depth -= 1
            if obj_depth:
                current.append(ch)
            if depth == 0:
                break
            continue
        if ch == "{":
            obj_depth += 1
            current.append(ch)
            continue
        if ch == "}":
            obj_depth -= 1
            current.append(ch)
            if obj_depth == 0:
                objects.append("".join(current))
                current = []
            continue
        if obj_depth:
            current.append(ch)
    return objects


def _extract_ts_strategy_refs(path: Path) -> list[dict[str, Any]]:
    text = path.read_text(encoding="utf-8")
    objects = _extract_array_objects(text, "const DEFAULT_STRATEGY_SPEC_DRAFTS")
    rows: list[dict[str, Any]] = []
    for obj in objects:
        match = re.search(r"\bid:\s*'([^']+)'", obj)
        if not match:
            continue
        strategy_id = match.group(1)
        for key, signal in DIRECT_THRESHOLD_SIGNAL.items():
            if re.search(rf"\b{re.escape(key)}\s*:", obj):
                rows.append({
                    "strategy_id": strategy_id,
                    "source": "ts_bootstrap",
                    "threshold_path": key,
                    "runtime_signal": signal,
                })
        for block_name, prefix in [
            ("minTechnicalIndicators", "technicalIndicators"),
            ("maxTechnicalIndicators", "technicalIndicators"),
            ("minFactorSignals", "factorSignals"),
            ("maxFactorSignals", "factorSignals"),
        ]:
            for block in re.findall(rf"\b{block_name}\s*:\s*\{{([^}}]*)\}}", obj, flags=re.DOTALL):
                for key in re.findall(r"([A-Za-z_][A-Za-z0-9_]*)\s*:", block):
                    rows.append({
                        "strategy_id": strategy_id,
                        "source": "ts_bootstrap",
                        "threshold_path": f"{block_name}.{key}",
                        "runtime_signal": f"{prefix}.{key}",
                    })
        for signal in re.findall(r"signal:\s*'([^']+)'", obj):
            rows.append({
                "strategy_id": strategy_id,
                "source": "ts_bootstrap",
                "threshold_path": "dsl.signal",
                "runtime_signal": signal,
            })
    return rows


def _extract_sql_strategy_refs(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    rows: list[dict[str, Any]] = []
    strategy_ids = re.findall(r"'(alpha_miner_pymoo_nsga3_novelty_[0-9]+)'", text)
    threshold_jsons = re.findall(r"(\{[^']*\"minPrice\"[^']*\})'", text)
    for strategy_id, raw_json in zip(strategy_ids[: len(threshold_jsons)], threshold_jsons):
        try:
            thresholds = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        for key, value in thresholds.items():
            if key in {"minTechnicalIndicators", "maxTechnicalIndicators", "minFactorSignals", "maxFactorSignals"} and isinstance(value, dict):
                prefix = "technicalIndicators" if "Technical" in key else "factorSignals"
                for nested_key in value:
                    rows.append({
                        "strategy_id": strategy_id,
                        "source": "d1_migration",
                        "threshold_path": f"{key}.{nested_key}",
                        "runtime_signal": f"{prefix}.{nested_key}",
                    })
            elif key == "featureRefs" and isinstance(value, dict):
                weighted = value.get("weightedScore") if isinstance(value.get("weightedScore"), dict) else {}
                for idx, term in enumerate(weighted.get("terms") or []):
                    if not isinstance(term, dict):
                        continue
                    feature_ref = str(term.get("featureRef") or "").strip()
                    signal = str(term.get("signal") or feature_ref).strip()
                    if feature_ref:
                        rows.append({
                            "strategy_id": strategy_id,
                            "source": "d1_migration",
                            "threshold_path": f"featureRefs.weightedScore.terms[{idx}]",
                            "runtime_signal": signal,
                            "feature_ref": feature_ref,
                        })
                for block_name in ("all", "any", "not"):
                    for idx, condition in enumerate(value.get(block_name) or []):
                        if not isinstance(condition, dict):
                            continue
                        feature_ref = str(condition.get("featureRef") or "").strip()
                        signal = str(condition.get("signal") or feature_ref).strip()
                        if feature_ref:
                            rows.append({
                                "strategy_id": strategy_id,
                                "source": "d1_migration",
                                "threshold_path": f"featureRefs.{block_name}[{idx}]",
                                "runtime_signal": signal,
                                "feature_ref": feature_ref,
                            })
            else:
                signal = DIRECT_THRESHOLD_SIGNAL.get(key)
                if signal:
                    rows.append({
                        "strategy_id": strategy_id,
                        "source": "d1_migration",
                        "threshold_path": key,
                        "runtime_signal": signal,
                    })
    return rows


def _resolve_ref(row: dict[str, Any], registry: dict[str, dict[str, Any]]) -> dict[str, Any]:
    runtime_signal = str(row["runtime_signal"])
    if runtime_signal.startswith("runtime_gate."):
        return {**row, "ref_type": "runtime_gate", "feature_id": "", "registry_status": "not_applicable", "ok": True}
    feature_id = str(row.get("feature_ref") or "").strip() or SIGNAL_TO_FEATURE_ID.get(runtime_signal)
    if not feature_id and "." not in runtime_signal:
        feature_id = SIGNAL_TO_FEATURE_ID.get(runtime_signal)
    if not feature_id:
        return {**row, "ref_type": "orphan_signal", "feature_id": "", "registry_status": "missing_mapping", "ok": False}
    feature = registry.get(feature_id)
    if not feature:
        return {**row, "ref_type": "registry_feature", "feature_id": feature_id, "registry_status": "missing_feature", "ok": False}
    eligible = bool(feature.get("eligible_for_strategy"))
    return {
        **row,
        "ref_type": "registry_feature",
        "feature_id": feature_id,
        "registry_status": "formal_candidate" if eligible else str(feature.get("active_pool_status") or "not_eligible"),
        "selector_role": feature.get("selector_role"),
        "ok": eligible,
    }


def main() -> int:
    registry = _load_registry(REGISTRY)
    raw_rows = _extract_ts_strategy_refs(STRATEGY_SPEC_TS) + _extract_sql_strategy_refs(MINED_MIGRATION)
    resolved = [_resolve_ref(row, registry) for row in raw_rows]
    unique_rows = []
    seen = set()
    for row in resolved:
        key = (row["strategy_id"], row["source"], row["threshold_path"], row["runtime_signal"], row.get("feature_id"))
        if key in seen:
            continue
        seen.add(key)
        unique_rows.append(row)

    type_counts = Counter(row["ref_type"] for row in unique_rows)
    status_counts = Counter(row["registry_status"] for row in unique_rows)
    strategy_counts = Counter(row["strategy_id"] for row in unique_rows)
    blockers = [
        row for row in unique_rows
        if not row.get("ok")
    ]
    summary = {
        "schema_version": "stockvision-strategy-feature-ref-contract-v1",
        "policy": {
            "purpose": "Map runtime strategy thresholds, DSL signals, and D1 featureRefs to unified feature registry ids or explicit non-feature runtime gates.",
            "blocker_rule": "Any active strategy signal that maps to a missing/dropped registry feature or lacks mapping is a blocker.",
            "no_behavior_change": "This contract is validation metadata; it does not change L1 matching by itself.",
        },
        "source_files": {
            "registry": _rel(REGISTRY),
            "ts_bootstrap": _rel(STRATEGY_SPEC_TS),
            "d1_migration": _rel(MINED_MIGRATION),
        },
        "counts": {
            "strategies": len(strategy_counts),
            "refs": len(unique_rows),
            "blockers": len(blockers),
        },
        "ref_type_counts": dict(type_counts),
        "registry_status_counts": dict(status_counts),
        "strategy_ref_counts": dict(strategy_counts),
        "blockers": blockers,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUT_DIR / "strategy_feature_ref_contract_20260617.csv"
    json_path = REGISTRY_DIR / "strategy_feature_ref_contract_v1.json"
    _write_csv(unique_rows, csv_path)
    json_path.write_text(json.dumps({**summary, "refs": unique_rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "json": str(json_path),
        "csv": str(csv_path),
        "counts": summary["counts"],
        "ref_type_counts": summary["ref_type_counts"],
        "registry_status_counts": summary["registry_status_counts"],
        "blockers": blockers[:20],
    }, ensure_ascii=False, indent=2))
    return 0 if not blockers else 2


if __name__ == "__main__":
    raise SystemExit(main())
