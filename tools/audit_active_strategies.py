from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

from export_active_strategy_specs_from_d1 import (
    ROOT,
    _run,
    _wrangler_results,
    export_active_strategy_specs,
)


SCHEMA_VERSION = "stockvision-active-strategy-attack-v1"
REWARD_SQL = """
SELECT reward_id, strategy_id, strategy_version, strategy_status, alpha_bucket,
       date_start, date_end, horizon_days, samples, hit_rate, avg_return_pct,
       reward_sum, max_drawdown_pct, coverage, market_segment,
       regime, updated_at
FROM strategy_reward_ledger
WHERE strategy_id IN (SELECT strategy_id FROM strategy_spec_registry WHERE status='active')
ORDER BY strategy_id, regime, horizon_days, updated_at DESC;
""".strip()


def _canonical_hash(value: Any) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _walk(value: Any) -> Iterable[Any]:
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _feature_refs(value: Any) -> list[str]:
    refs: set[str] = set()
    for child in _walk(value):
        if isinstance(child, dict):
            ref = child.get("featureRef")
            if isinstance(ref, str) and ref.strip():
                refs.add(ref.strip())
    return sorted(refs)


def _runtime_signals(value: Any) -> list[str]:
    signals: set[str] = set()
    for child in _walk(value):
        if isinstance(child, dict):
            signal = child.get("signal")
            if isinstance(signal, str) and signal.strip():
                signals.add(signal.strip())
    return sorted(signals)


def _absolute_paths(value: Any) -> list[str]:
    return sorted({child for child in _walk(value) if isinstance(child, str) and re.match(r"^[A-Za-z]:[/\\]", child)})


def _issue(
    issue_id: str,
    category: str,
    severity: str,
    targets: list[str],
    evidence: str,
    optimization: str,
    *,
    blocks_locked_test: bool,
) -> dict[str, Any]:
    return {
        "issue_id": issue_id,
        "category": category,
        "severity": severity,
        "target_ids": sorted(targets),
        "evidence": evidence,
        "optimization": optimization,
        "blocks_locked_test": blocks_locked_test,
        "evidence_level": "E2_LOCAL_DETERMINISTIC",
    }


def build_active_strategy_attack(
    specs: list[dict[str, Any]],
    rewards: list[dict[str, Any]],
    feature_registry: dict[str, Any],
    reward_schema_columns: list[str] | None = None,
) -> dict[str, Any]:
    issues: list[dict[str, Any]] = []
    feature_rows = feature_registry.get("features") if isinstance(feature_registry, dict) else []
    feature_by_id = {
        str(row.get("feature_id")): row
        for row in feature_rows or []
        if isinstance(row, dict) and row.get("feature_id")
    }
    rewards_by_strategy: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rewards:
        rewards_by_strategy[str(row.get("strategy_id") or "")].append(row)

    no_source_refs: list[str] = []
    no_structured_dependencies: list[str] = []
    runtime_only_dependencies: list[str] = []
    nonportable_lineage: list[str] = []
    stale_governance: list[str] = []
    missing_rewards: list[str] = []
    missing_regime_rewards: list[str] = []
    unknown_formal_features: dict[str, list[str]] = {}
    unverified_pit_features: dict[str, list[str]] = {}
    family_members: dict[str, list[str]] = defaultdict(list)
    strategy_rows: list[dict[str, Any]] = []

    for spec in specs:
        strategy_id = str(spec.get("id") or "")
        family_members[str(spec.get("familyId") or "UNKNOWN")].append(strategy_id)
        thresholds = spec.get("thresholds") if isinstance(spec.get("thresholds"), dict) else {}
        refs = _feature_refs(thresholds.get("featureRefs"))
        signals = _runtime_signals(thresholds.get("dsl"))
        scalar_dependencies = sorted(
            key for key in thresholds
            if key not in {"minPrice", "maxPrice", "featureRefs", "dsl", "technicalStrategy"}
            and re.match(r"^(min|max)", key)
        )
        if not spec.get("sourceRefs"):
            no_source_refs.append(strategy_id)
        if not refs and not signals and not scalar_dependencies:
            no_structured_dependencies.append(strategy_id)
        if signals and not refs:
            runtime_only_dependencies.append(strategy_id)
        if _absolute_paths(thresholds):
            nonportable_lineage.append(strategy_id)
        risk_notes = [str(note) for note in spec.get("riskNotes") or []]
        if spec.get("status") == "active" and any("not applied to remote D1" in note for note in risk_notes):
            stale_governance.append(strategy_id)

        unknown_refs = [ref for ref in refs if ref not in feature_by_id]
        if unknown_refs:
            unknown_formal_features[strategy_id] = unknown_refs
        unverified_refs = [
            ref for ref in refs
            if ref in feature_by_id and (
                feature_by_id[ref].get("availability_lag") == "UNKNOWN"
                or feature_by_id[ref].get("earliest_execution") == "UNKNOWN"
                or (feature_by_id[ref].get("point_in_time") or {}).get("status") != "VERIFIED"
            )
        ]
        if unverified_refs:
            unverified_pit_features[strategy_id] = unverified_refs

        reward_rows = rewards_by_strategy.get(strategy_id, [])
        if not reward_rows:
            missing_rewards.append(strategy_id)
        if not any(str(row.get("regime") or "all") != "all" and int(row.get("samples") or 0) > 0 for row in reward_rows):
            missing_regime_rewards.append(strategy_id)
        strategy_rows.append({
            "strategy_id": strategy_id,
            "family_id": str(spec.get("familyId") or "UNKNOWN"),
            "feature_ref_count": len(refs),
            "runtime_signal_count": len(signals),
            "scalar_dependency_count": len(scalar_dependencies),
            "unknown_formal_feature_count": len(unknown_refs),
            "unverified_pit_feature_count": len(unverified_refs),
            "reward_row_count": len(reward_rows),
            "regime_reward_count": sum(1 for row in reward_rows if str(row.get("regime") or "all") != "all"),
        })

    all_ids = [str(spec.get("id") or "") for spec in specs]
    issues.append(_issue(
        "ACTIVE-EXEC-001", "EXECUTION_CONTRACT_INCOMPLETE", "MAJOR", all_ids,
        "strategy_spec_registry has no explicit exit rule, holding period, execution timing, or transaction-cost model columns; StrategyCard currently materializes them as UNKNOWN.",
        "Add versioned execution/exit/cost fields and block promotion or locked testing while any remain UNKNOWN.",
        blocks_locked_test=True,
    ))
    grouped = [
        (no_source_refs, "ACTIVE-LINEAGE-001", "SOURCE_LINEAGE_MISSING", "MAJOR", "source_refs_json is empty.", "Attach immutable repository/data artifact references to every active StrategySpec.", True),
        (no_structured_dependencies, "ACTIVE-LINEAGE-002", "STRUCTURED_DEPENDENCY_MISSING", "MAJOR", "No featureRef, runtime DSL signal, or named scalar dependency is present.", "Declare machine-readable feature dependencies before further validation.", True),
        (runtime_only_dependencies, "ACTIVE-LINEAGE-003", "RUNTIME_SIGNAL_NOT_FORMAL_FEATURE", "MAJOR", "Entry depends on runtime DSL signals without formal feature IDs.", "Map every materialized runtime signal to a versioned formal feature and PIT evidence.", True),
        (nonportable_lineage, "ACTIVE-LINEAGE-004", "NONPORTABLE_LOCAL_PATH", "MINOR", "Strategy metadata contains an absolute workstation path.", "Replace local paths with repository-relative immutable source references.", False),
        (stale_governance, "ACTIVE-GOV-001", "ACTIVE_STATUS_TEXT_CONTRADICTION", "MAJOR", "Active production rows retain risk text stating the builder was not applied to remote D1.", "Replace stale draft language with the actual promotion decision and evidence pointer.", False),
        (missing_rewards, "ACTIVE-EVIDENCE-001", "REWARD_EVIDENCE_MISSING", "MAJOR", "No strategy_reward_ledger rows exist for the active strategy.", "Backfill immutable OOS/replay reward evidence without changing active decisions.", True),
        (missing_regime_rewards, "ACTIVE-EVIDENCE-002", "REGIME_EVIDENCE_MISSING", "MAJOR", "No positive-sample regime-specific reward evidence exists.", "Produce bull/bear/volatile/sideways evidence with frozen dates and dataset hash.", True),
    ]
    for targets, issue_id, category, severity, evidence, optimization, blocks in grouped:
        if targets:
            issues.append(_issue(issue_id, category, severity, targets, evidence, optimization, blocks_locked_test=blocks))
    if unknown_formal_features:
        issues.append(_issue(
            "ACTIVE-PIT-001", "FEATURE_NOT_IN_FORMAL137", "MAJOR", list(unknown_formal_features),
            f"{sum(len(v) for v in unknown_formal_features.values())} referenced dependencies are absent from the formal137 registry.",
            "Canonicalize dependency IDs and prove materializer/runtime lineage before locked testing.", blocks_locked_test=True,
        ))
    if unverified_pit_features:
        issues.append(_issue(
            "ACTIVE-PIT-002", "FEATURE_POINT_IN_TIME_UNVERIFIED", "MAJOR", list(unverified_pit_features),
            f"{sum(len(v) for v in unverified_pit_features.values())} formal feature references still have UNKNOWN availability or earliest execution.",
            "Add repository-backed publication lag and earliest executable timestamp; never infer them from names.", blocks_locked_test=True,
        ))

    concentrated = {family: members for family, members in family_members.items() if len(members) >= 2}
    if concentrated:
        issues.append(_issue(
            "ACTIVE-PORTFOLIO-001", "FAMILY_CONCENTRATION_REQUIRES_OVERLAP_TEST", "INFO",
            sorted({sid for members in concentrated.values() for sid in members}),
            "; ".join(f"{family}:{len(members)}" for family, members in sorted(concentrated.items())),
            "Run same-date selection-overlap and return-correlation profiling before allocating additional family variants.",
            blocks_locked_test=False,
        ))
    bear_targets = [str(spec.get("id") or "") for spec in specs if "bear" not in [str(v).lower() for v in spec.get("supportedRegimes") or []]]
    if bear_targets:
        issues.append(_issue(
            "ACTIVE-PORTFOLIO-002", "BEAR_REGIME_COVERAGE_GAP", "INFO", bear_targets,
            f"{len(bear_targets)}/{len(specs)} active strategies do not declare bear support.",
            "Treat this as a portfolio gap; do not broaden regimes without locked bear-period evidence.", blocks_locked_test=False,
        ))

    remote_reward_columns = set(reward_schema_columns or [])
    cooldown_targets: list[str] = []
    insufficient_reward_targets: list[str] = []
    for row in strategy_rows:
        reward_rows = rewards_by_strategy.get(row["strategy_id"], [])
        samples = sum(int(reward.get("samples") or 0) for reward in reward_rows)
        weighted_sample_count = sum(
            int(reward.get("samples") or 0) for reward in reward_rows
            if reward.get("hit_rate") is not None and reward.get("avg_return_pct") is not None
        )
        weighted_hit_rate = (
            sum(float(reward["hit_rate"]) * int(reward.get("samples") or 0) for reward in reward_rows if reward.get("hit_rate") is not None)
            / sum(int(reward.get("samples") or 0) for reward in reward_rows if reward.get("hit_rate") is not None)
            if any(reward.get("hit_rate") is not None and int(reward.get("samples") or 0) > 0 for reward in reward_rows)
            else None
        )
        weighted_avg_return = (
            sum(float(reward["avg_return_pct"]) * int(reward.get("samples") or 0) for reward in reward_rows if reward.get("avg_return_pct") is not None)
            / sum(int(reward.get("samples") or 0) for reward in reward_rows if reward.get("avg_return_pct") is not None)
            if any(reward.get("avg_return_pct") is not None and int(reward.get("samples") or 0) > 0 for reward in reward_rows)
            else None
        )
        drawdowns = [float(reward["max_drawdown_pct"]) for reward in reward_rows if reward.get("max_drawdown_pct") is not None]
        worst_drawdown = min(drawdowns) if drawdowns else None
        row.update({
            "runtime_aggregate_samples": samples,
            "weighted_sample_count": weighted_sample_count,
            "weighted_hit_rate": weighted_hit_rate,
            "weighted_avg_return_pct": weighted_avg_return,
            "worst_max_drawdown_pct": worst_drawdown,
        })
        if samples < 30:
            insufficient_reward_targets.append(row["strategy_id"])
        elif (
            weighted_hit_rate is None or weighted_hit_rate < 0.48
            or weighted_avg_return is None or weighted_avg_return <= 0
            or (worst_drawdown is not None and worst_drawdown < -0.08)
        ):
            cooldown_targets.append(row["strategy_id"])

    if cooldown_targets:
        issues.append(_issue(
            "ACTIVE-REWARD-001", "ACTIVE_COOLDOWN_SIGNAL", "MAJOR", cooldown_targets,
            f"{len(cooldown_targets)} active strategies meet the local runtime cooldown rule after sample-weighted aggregation.",
            "Keep production unchanged until approval; run locked OOS/paired replay, then explicitly approve cooldown or retention per strategy.",
            blocks_locked_test=True,
        ))
    if insufficient_reward_targets:
        issues.append(_issue(
            "ACTIVE-REWARD-002", "ACTIVE_REWARD_SAMPLE_INSUFFICIENT", "MAJOR", insufficient_reward_targets,
            "Active strategy reward evidence is below the 30-sample runtime gate.",
            "Collect additional immutable forward/replay evidence; do not optimize thresholds on the same small sample.",
            blocks_locked_test=True,
        ))

    severity_counts = Counter(issue["severity"] for issue in issues)
    blocker_ids = [issue["issue_id"] for issue in issues if issue["blocks_locked_test"]]
    return {
        "schema_version": SCHEMA_VERSION,
        "decision": "BLOCKED_FOR_LOCKED_TEST" if blocker_ids else "LOCAL_ATTACK_PASSED",
        "active_strategy_count": len(specs),
        "strategy_snapshot_hash": _canonical_hash(specs),
        "reward_snapshot_hash": _canonical_hash(rewards),
        "formal_feature_snapshot_hash": _canonical_hash(feature_registry),
        "severity_counts": dict(sorted(severity_counts.items())),
        "blocking_issue_ids": blocker_ids,
        "issues": issues,
        "strategies": strategy_rows,
        "private_detail": {
            "unknown_formal_features_by_strategy": unknown_formal_features,
            "unverified_pit_features_by_strategy": unverified_pit_features,
            "remote_reward_schema_columns": sorted(remote_reward_columns),
        },
    }


def build_privacy_projection(report: dict[str, Any], strategy_ids: list[str]) -> tuple[dict[str, Any], dict[str, str]]:
    handle_map = {strategy_id: f"ACTIVE-{index + 1:02d}" for index, strategy_id in enumerate(sorted(strategy_ids))}
    issue_rows = []
    for issue in report["issues"]:
        issue_rows.append({
            "issue_handle": issue["issue_id"],
            "category": issue["category"],
            "severity": issue["severity"],
            "target_handles": [handle_map[target] for target in issue["target_ids"]],
            "blocks_locked_test": issue["blocks_locked_test"],
        })
    projection = {
        "schema_version": "stockvision-active-strategy-attack-privacy-v1",
        "decision": report["decision"],
        "active_strategy_count": report["active_strategy_count"],
        "severity_counts": report["severity_counts"],
        "blocking_issue_count": len(report["blocking_issue_ids"]),
        "issues": issue_rows,
        "redaction": {
            "exact_rules_removed": True,
            "numeric_parameters_removed": True,
            "internal_identifiers_removed": True,
            "data_sources_removed": True,
            "governance_fields_removed": True,
        },
    }
    serialized = json.dumps(projection, ensure_ascii=False, sort_keys=True)
    leaked_ids = [strategy_id for strategy_id in strategy_ids if strategy_id and strategy_id in serialized]
    if leaked_ids:
        raise ValueError(f"privacy_projection_strategy_id_leak:{len(leaked_ids)}")
    return projection, handle_map


def _markdown_report(report: dict[str, Any]) -> str:
    lines = [
        "# Active Strategy Deterministic Attack",
        "",
        f"- Decision: `{report['decision']}`",
        f"- Active strategies: {report['active_strategy_count']}",
        f"- Strategy snapshot: `{report['strategy_snapshot_hash']}`",
        f"- Blocking issues: {len(report['blocking_issue_ids'])}",
        "",
        "## Issues",
        "",
    ]
    for issue in report["issues"]:
        lines.extend([
            f"### {issue['issue_id']} · {issue['category']} · {issue['severity']}",
            "",
            f"- Targets: {', '.join(issue['target_ids'])}",
            f"- Evidence: {issue['evidence']}",
            f"- Optimization: {issue['optimization']}",
            f"- Blocks locked test: {str(issue['blocks_locked_test']).lower()}",
            "",
        ])
    lines.extend(["## Per-strategy coverage", "", "| Strategy | refs | runtime signals | unknown formal | PIT unknown | samples | weighted hit | weighted return | worst drawdown |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|"])
    for row in report["strategies"]:
        lines.append(
            f"| {row['strategy_id']} | {row['feature_ref_count']} | {row['runtime_signal_count']} | "
            f"{row['unknown_formal_feature_count']} | {row['unverified_pit_feature_count']} | "
            f"{row.get('runtime_aggregate_samples', 0)} | {row.get('weighted_hit_rate')} | "
            f"{row.get('weighted_avg_return_pct')} | {row.get('worst_max_drawdown_pct')} |"
        )
    return "\n".join(lines) + "\n"


def _fetch_rewards(root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    schema_run = _run([
        "npx", "wrangler@4", "d1", "execute", "stockvision-db", "--remote", "--json",
        "--command", "PRAGMA table_info(strategy_reward_ledger);",
    ], root / "worker")
    schema_rows = _wrangler_results(schema_run)
    columns = [str(row.get("name") or "") for row in schema_rows if row.get("name")]
    run = _run([
        "npx", "wrangler@4", "d1", "execute", "stockvision-db", "--remote", "--json",
        "--command", " ".join(REWARD_SQL.split()),
    ], root / "worker")
    return _wrangler_results(run), columns


def main() -> int:
    parser = argparse.ArgumentParser(description="Freeze and locally attack current production active strategies.")
    parser.add_argument("--repo", default=str(ROOT))
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    root = Path(args.repo).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    specs, export_summary = export_active_strategy_specs(root)
    rewards, reward_schema_columns = _fetch_rewards(root)
    feature_registry_path = root / "worker/src/strategy-discovery/data/formal137-feature-registry.v1.json"
    feature_registry = json.loads(feature_registry_path.read_text(encoding="utf-8"))
    report = build_active_strategy_attack(specs, rewards, feature_registry, reward_schema_columns)
    projection, handle_map = build_privacy_projection(report, [str(spec["id"]) for spec in specs])

    artifacts = {
        "raw-active-strategy-specs.json": specs,
        "raw-active-strategy-rewards.json": rewards,
        "active-strategy-attack.json": report,
        "active-strategy-privacy-v1.json": projection,
        "privacy-handle-map.local.json": handle_map,
        "active-strategy-export-summary.json": export_summary,
    }
    for name, value in artifacts.items():
        (output_dir / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output_dir / "active-strategy-attack.md").write_text(_markdown_report(report), encoding="utf-8")

    manifest = {
        "schema_version": "stockvision-active-strategy-attack-manifest-v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "decision_effect": "read_only_remote_snapshot_and_local_analysis",
        "production_mutation_allowed": False,
        "external_ai_transmission_performed": False,
        "artifacts": {
            path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(output_dir.iterdir()) if path.is_file() and path.name != "manifest.json"
        },
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "decision": report["decision"],
        "active_strategy_count": report["active_strategy_count"],
        "reward_row_count": len(rewards),
        "issue_count": len(report["issues"]),
        "blocking_issue_count": len(report["blocking_issue_ids"]),
        "output_dir": str(output_dir),
        "external_ai_transmission_performed": False,
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
