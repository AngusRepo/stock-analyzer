from __future__ import annotations

import argparse
import ast
import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_GATE_DIR = ROOT / "output" / "strategy_promotion_preflight" / "s04_s11_defensive_replacement_gates"
DEFAULT_CONTRACT = DEFAULT_GATE_DIR / "active12_promotion_factor_contract_latest.csv"
DEFAULT_REPLAY = DEFAULT_GATE_DIR / "finlab_strategy_spec_active3_20230101_20260615.csv"
DEFAULT_PAIRWISE = (
    ROOT
    / "output"
    / "strategy_promotion_preflight"
    / "portfolio_scenarios_s04_s11_defensive_replacement"
    / "active12_portfolio_scenarios_sii_20230101_20260615_pairwise_focus.csv"
)
DEFAULT_CANDIDATES = ["alpha223_0285", "alpha223_0283", "alpha223_0009"]
DEFAULT_EXISTING = ["alpha223_0248", "alpha223_0109", "alpha223_0166"]


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def _write_csv(rows: list[dict[str, Any]], path: Path) -> None:
    fields = sorted({key for row in rows for key in row.keys()})
    with path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)


def _safe_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed else None


def _safe_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y"}


def _recent5_min(value: str) -> int:
    try:
        rows = ast.literal_eval(value)
    except (SyntaxError, ValueError):
        return 0
    if not isinstance(rows, list) or not rows:
        return 0
    counts = []
    for row in rows:
        if isinstance(row, dict):
            counts.append(int(float(row.get("strict_match_count") or 0)))
    return min(counts) if counts else 0


def _pair_key(row: dict[str, str]) -> tuple[str, str]:
    return str(row.get("strategy_a") or ""), str(row.get("strategy_b") or "")


def build(args: argparse.Namespace) -> dict[str, Any]:
    candidate_ids = [item.strip() for item in args.candidate_ids.split(",") if item.strip()]
    existing_ids = [item.strip() for item in args.existing_ids.split(",") if item.strip()]
    candidates = set(candidate_ids)
    existing = set(existing_ids)

    contract_rows = [
        row for row in _read_csv(Path(args.contract_csv))
        if row.get("strategy_id") in candidates
    ]
    replay_rows = {
        str(row.get("strategy_id") or ""): row
        for row in _read_csv(Path(args.replay_csv))
        if row.get("strategy_id") in candidates
    }
    pairwise_rows = []
    for row in _read_csv(Path(args.pairwise_csv)):
        a, b = _pair_key(row)
        if (a in candidates and b in existing) or (b in candidates and a in existing):
            pairwise_rows.append(row)

    contract_by_strategy: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in contract_rows:
        contract_by_strategy[str(row.get("strategy_id") or "")].append(row)

    pairwise_by_strategy: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in pairwise_rows:
        a, b = _pair_key(row)
        candidate = a if a in candidates else b
        pairwise_by_strategy[candidate].append(row)

    rows: list[dict[str, Any]] = []
    for strategy_id in candidate_ids:
        factor_rows = contract_by_strategy.get(strategy_id, [])
        factor_blockers = [row for row in factor_rows if str(row.get("blocker") or "").strip()]
        mapping_blockers = [
            row for row in factor_blockers
            if row.get("blocker") in {"factor_mapping_missing", "runtime_mapping_missing", "alpha223_candidate_row_missing"}
        ]

        replay = replay_rows.get(strategy_id, {})
        recent5_min = _recent5_min(str(replay.get("recent5_match_counts") or "[]"))
        select0_ok = replay.get("status") == "ok" and int(float(replay.get("latest_matches") or 0)) > 0
        replay_ok = select0_ok and _safe_bool(replay.get("recent5_all_positive")) and recent5_min > 0

        pairs = pairwise_by_strategy.get(strategy_id, [])
        max_corr = max([_safe_float(row.get("return_corr")) or 0 for row in pairs], default=0)
        max_all_j = max([_safe_float(row.get("all_period_jaccard")) or 0 for row in pairs], default=0)
        max_latest_j = max([_safe_float(row.get("latest_jaccard")) or 0 for row in pairs], default=0)
        max_phi = max([_safe_float(row.get("position_phi_corr")) or 0 for row in pairs], default=0)
        pairwise_ok = (
            len(pairs) == len(existing_ids)
            and max_corr <= float(args.max_pair_corr)
            and max_all_j <= float(args.max_pair_all_jaccard)
            and max_latest_j <= float(args.max_pair_latest_jaccard)
        )
        rows.append({
            "strategy_id": strategy_id,
            "factor_count": len(factor_rows),
            "factor_contract_ok": len(factor_rows) > 0 and not factor_blockers,
            "factor_blocker_count": len(factor_blockers),
            "mapping_blocker_count": len(mapping_blockers),
            "factor_blockers": ";".join(f"{row.get('factor_id')}:{row.get('blocker')}" for row in factor_blockers),
            "select0_preflight_ok": select0_ok,
            "runtime_replay_5d_ok": replay_ok,
            "latest_matches": int(float(replay.get("latest_matches") or 0)),
            "recent5_min_strict_match_count": recent5_min,
            "replay_status": replay.get("status") or "",
            "pairwise_rows": len(pairs),
            "pairwise_crowding_ok": pairwise_ok,
            "max_pair_return_corr": max_corr,
            "max_pair_all_period_jaccard": max_all_j,
            "max_pair_latest_jaccard": max_latest_j,
            "max_pair_position_phi_corr": max_phi,
            "local_prod_ready_no_partial": (
                len(factor_rows) > 0
                and not factor_blockers
                and select0_ok
                and replay_ok
                and pairwise_ok
            ),
        })

    return {
        "schema_version": "stockvision-alpha223-extension-gate-summary-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "decision_effect": "local_gate_summary_only",
        "candidate_ids": candidate_ids,
        "existing_pairwise_ids": existing_ids,
        "thresholds": {
            "max_pair_corr": float(args.max_pair_corr),
            "max_pair_all_jaccard": float(args.max_pair_all_jaccard),
            "max_pair_latest_jaccard": float(args.max_pair_latest_jaccard),
        },
        "source_files": {
            "contract_csv": _rel(Path(args.contract_csv)),
            "replay_csv": _rel(Path(args.replay_csv)),
            "pairwise_csv": _rel(Path(args.pairwise_csv)),
        },
        "all_local_prod_ready_no_partial": all(row["local_prod_ready_no_partial"] for row in rows),
        "rows": rows,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize Alpha223 extension factor/select0/replay/crowding gates.")
    parser.add_argument("--candidate-ids", default=",".join(DEFAULT_CANDIDATES))
    parser.add_argument("--existing-ids", default=",".join(DEFAULT_EXISTING))
    parser.add_argument("--contract-csv", default=str(DEFAULT_CONTRACT))
    parser.add_argument("--replay-csv", default=str(DEFAULT_REPLAY))
    parser.add_argument("--pairwise-csv", default=str(DEFAULT_PAIRWISE))
    parser.add_argument("--max-pair-corr", type=float, default=0.85)
    parser.add_argument("--max-pair-all-jaccard", type=float, default=0.20)
    parser.add_argument("--max-pair-latest-jaccard", type=float, default=0.35)
    parser.add_argument("--output-dir", default=str(DEFAULT_GATE_DIR))
    args = parser.parse_args()

    report = build(args)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "alpha223_extension_gate_summary.json"
    csv_path = out_dir / "alpha223_extension_gate_summary.csv"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    _write_csv(report["rows"], csv_path)
    print(json.dumps({
        "json": _rel(json_path),
        "csv": _rel(csv_path),
        "all_local_prod_ready_no_partial": report["all_local_prod_ready_no_partial"],
        "rows": report["rows"],
    }, ensure_ascii=False, indent=2))
    return 0 if report["all_local_prod_ready_no_partial"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
