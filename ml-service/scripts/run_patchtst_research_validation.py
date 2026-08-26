from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ML_SERVICE_ROOT = Path(__file__).resolve().parents[1]
if str(ML_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_SERVICE_ROOT))

import modal_app  # noqa: E402
from app.patchtst_research_gate import evaluate_fixed_config_repeated_seed_gate  # noqa: E402


SOURCE_FILES = (
    "modal_app.py",
    "app/neuralforecast_sequence_runtime.py",
    "app/oof_lineage.py",
    "app/patchtst_universal.py",
    "requirements.txt",
)
WINDOWS = (
    {"window_id": 0, "train_start": "2026-03-06", "train_end": "2026-06-03", "test_start": "2026-06-04", "test_end": "2026-06-18"},
    {"window_id": 1, "train_start": "2026-03-20", "train_end": "2026-06-18", "test_start": "2026-06-22", "test_end": "2026-07-03"},
    {"window_id": 2, "train_start": "2026-04-07", "train_end": "2026-07-03", "test_start": "2026-07-06", "test_end": "2026-07-20"},
    {"window_id": 3, "train_start": "2026-04-21", "train_end": "2026-07-20", "test_start": "2026-07-21", "test_end": "2026-08-03"},
    {"window_id": 4, "train_start": "2026-05-07", "train_end": "2026-08-03", "test_start": "2026-08-04", "test_end": "2026-08-17"},
)
V9_CANONICAL_FOLD_IC = (-0.006382, -0.168641, -0.136104, -0.017158, -0.004178)


def _source_bundle_checksum() -> str:
    digest = hashlib.sha256()
    for relative in SOURCE_FILES:
        path = ML_SERVICE_ROOT / relative
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _payload(window: dict[str, Any], *, seed: int, source_checksum: str) -> dict[str, Any]:
    return {
        **window,
        "generation_mode": "purged_oof",
        "persist_oof_artifact": False,
        "promote_to_active": False,
        "register_challengers": False,
        "candidate_type": "research_benchmark",
        "allowed_use": "research_only",
        "production_effect": False,
        "research_source_bundle_checksum": source_checksum,
        "cohort_id": f"patchtst-research-only-{source_checksum[:12]}",
        "fold_id": f"w{window['window_id']}-seed{seed}",
        "output_model_version": f"research-{source_checksum[:12]}-w{window['window_id']}-s{seed}",
        "version": f"research-{source_checksum[:12]}-w{window['window_id']}-s{seed}",
        "run_date": "2026-08-25",
        "as_of_date": "2026-08-25",
        "gcs_prefix": "universal/canonical_adjusted_v6/2026-08-25-e504e378f68c-a4b8161d065e-95e848048748",
        "sequence_gcs_prefix": "universal/sequence_long/runs/finlab-v4-daily-20260825-1787662855421",
        "sequence_batch_count": 5,
        "batch_count": 5,
        "seq_len": 512,
        "pred_len": 5,
        "max_series": 1024,
        "max_steps": 120,
        "batch_size": 256,
        "seed": seed,
        "oof_training_history_mode": "full_pit_history",
        "trainer_deterministic": True,
        "learning_rate": 1e-4,
        "windows_batch_size": 1024,
        "inference_windows_batch_size": 1024,
        "scaler_type": "identity",
        "step_size": 1,
        "patch_len": 16,
        "stride": 8,
        "revin": True,
    }


def _run(stage: str) -> dict[str, Any]:
    source_checksum = _source_bundle_checksum()
    selected_windows = WINDOWS[-1:] if stage == "smoke" else WINDOWS
    seeds = (42,) if stage == "smoke" else (42, 314, 2718)
    runs: list[dict[str, Any]] = []
    with modal_app.app.run():
        for window in selected_windows:
            for seed in seeds:
                payload = _payload(window, seed=seed, source_checksum=source_checksum)
                result = modal_app.train_patchtst_universal.remote(payload)
                if result.get("error"):
                    raise RuntimeError(f"patchtst_research_failed:w{window['window_id']}:seed={seed}:{result['error']}")
                metrics = result.get("metrics") or {}
                runs.append({
                    "window_id": window["window_id"],
                    "seed": seed,
                    "oos_ic": float(metrics.get("oos_ic") or 0.0),
                    "oos_samples": int(metrics.get("oos_samples") or 0),
                    "oos_dates": int(metrics.get("oos_dates") or 0),
                    "daily_metrics": metrics.get("daily_metrics") or [],
                    "panel_report": (result.get("metadata") or {}).get("panel_report") or {},
                    "allowed_use": result.get("allowed_use"),
                    "production_effect": result.get("production_effect"),
                    "oof_artifact": result.get("oof_artifact"),
                    "elapsed_s": result.get("elapsed_s"),
                })
    by_window: dict[str, dict[str, Any]] = {}
    for window in selected_windows:
        values = [row["oos_ic"] for row in runs if row["window_id"] == window["window_id"]]
        by_window[str(window["window_id"])] = {
            "seed_count": len(values),
            "mean_ic": statistics.mean(values),
            "min_ic": min(values),
            "max_ic": max(values),
            "std_ic": statistics.stdev(values) if len(values) > 1 else 0.0,
            "v9_ic": V9_CANONICAL_FOLD_IC[window["window_id"]],
            "mean_delta_vs_v9": statistics.mean(values) - V9_CANONICAL_FOLD_IC[window["window_id"]],
        }
    no_write_gate = all(
        row["allowed_use"] == "research_only"
        and row["production_effect"] is False
        and row["oof_artifact"] is None
        and row["oos_samples"] > 0
        for row in runs
    )
    if stage == "smoke":
        gate = {
            "passed": no_write_gate and all(
                value["mean_ic"] > 0.0 and value["mean_delta_vs_v9"] > 0.0
                for value in by_window.values()
            ),
            "checks": {"research_only_no_write": no_write_gate},
        }
    else:
        gate = evaluate_fixed_config_repeated_seed_gate(
            runs,
            by_window,
            baseline_fold_ic=V9_CANONICAL_FOLD_IC,
        )
    return {
        "schema_version": "patchtst-research-only-validation-v1",
        "stage": stage,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_bundle_checksum": source_checksum,
        "dataset": {
            "business_date": "2026-08-25",
            "sequence_manifest_checksum": "a4b8161d065e6dc520c84ecfa38fc91439cbb169ce0b7139db8496a225a96df8",
            "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
        },
        "settings": {
            "history_mode": "full_pit_history",
            "max_steps": 120,
            "seeds": list(seeds),
            "same_market_same_date_ic": True,
            "persist_oof_artifact": False,
        },
        "runs": runs,
        "by_window": by_window,
        "research_gate": gate,
        "research_gate_passed": bool(gate["passed"]),
        "formal_action": (
            "eligible_for_full_research"
            if gate["passed"] and stage == "smoke"
            else "eligible_for_monthly_candidate_contract"
            if gate["passed"] and stage == "full"
            else "remain_research_only"
        ),
        "production_effect": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=("smoke", "full"), default="smoke")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    receipt = _run(args.stage)
    rendered = json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered + "\n", encoding="utf-8")
    print("PATCHTST_RESEARCH_RESULT=" + json.dumps(receipt, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
