#!/usr/bin/env python3
"""One-fold Modal smoke for the §7 challengers (ephemeral app run, never a deploy).

Default prints the exact payloads only. ``--execute`` spends Modal money and writes
fold OOF/artifacts to GCS, so it needs Wei's explicit go.  Industry arms also need
the sidecar uploaded first (``--industry-path`` / ``--industry-sha256``).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

FEATURE131 = "formal131-without-unverified-daily-owners-v1"
# r32 plan-a canonical cohort, window w6 (last window; its train range overlaps PIT industry snapshots).
WINDOW = {"window_id": 6, "fold_id": "w6", "train_start": "2023-04-06", "train_end": "2026-09-08",
          "test_start": "2026-09-09", "test_end": "2026-09-22"}


def payloads(args) -> dict[str, tuple[str, dict]]:
    base = {
        "gcs_prefix": args.prep_prefix, "prep_gcs_prefix": args.prep_prefix, "batch_count": args.batch_count,
        "feature_semantic_version": FEATURE131, "feature_release_mode": "approved_full131_v1",
        "generation_mode": "purged_oof", "cohort_id": args.cohort_id, "label_horizon_days": 5,
        "register_challengers": False, **WINDOW,
    }
    version = f"{args.cohort_id}-{WINDOW['fold_id']}"
    industry = ({"path": args.industry_path, "sha256": args.industry_sha256}
                if args.industry_path and args.industry_sha256 else None)
    # The lifecycle slot: the trainer resolves LinearNeutralSize vs LinearNeutral from PIT coverage.
    linear = {**base, "neutralization_exposures": "auto", "validation_folds": 8, "output_model_version": version}
    if industry:
        linear["industry_exposure"] = industry
    out = {"linear_neutral": ("train_linear_neutral_universal", linear)}
    if industry and args.include_deferred_gnn:
        gnn = {"epochs": 36, "hidden_dim": 64, "dropout": 0.12, "lr": 0.003, "weight_decay": 0.0001,
               "max_train_dates_per_epoch": 120, "edge_top_k": 8, "edge_threshold": 0.25,
               "standardization_clip": 8.0, "seed": 42, "industry_exposure": industry,
               "output_model_version": version, "version": version}
        out["GNNIndustry"] = ("train_gnn_industry_universal", {**base, **gnn, "graph_variant": "industry"})
        out["GNNIndustryCosine"] = ("train_gnn_industry_universal",
                                    {**base, **gnn, "graph_variant": "industry_plus_cosine"})
    return {name: out[name] for name in (args.models or out) if name in out}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prep-prefix", default="r32-plan-a-canonical")
    parser.add_argument("--batch-count", type=int, default=24)
    parser.add_argument("--cohort-id", default="s7-challenger-smoke-20261028")
    parser.add_argument("--industry-path")
    parser.add_argument("--industry-sha256")
    parser.add_argument("--models", nargs="*")
    parser.add_argument("--include-deferred-gnn", action="store_true",
                        help="Also run GNNIndustry arms (deferred by Wei 2026-10-25; needs the sidecar).")
    parser.add_argument("--execute", action="store_true", help="Spend Modal money (requires Wei go).")
    args = parser.parse_args()
    planned = payloads(args)
    print(json.dumps({name: {"function": fn, "payload": body} for name, (fn, body) in planned.items()},
                     ensure_ascii=False, indent=1))
    if not args.execute:
        return 0
    import modal
    import modal_app

    results = {}
    with modal.enable_output(), modal_app.app.run():
        calls = {name: getattr(modal_app, fn).spawn(body) for name, (fn, body) in planned.items()}
        for name, call in calls.items():
            result = call.get()
            results[name] = {k: result.get(k) for k in (
                "error", "model", "version", "oos_ic", "train_samples", "test_samples", "validation_samples",
                "elapsed_s", "artifact_path", "exposure_coverage")}
            results[name]["oof_path"] = (result.get("oof_artifact") or {}).get("path")
    print(json.dumps(results, ensure_ascii=False, indent=1, default=str))
    return 0 if all(not r.get("error") for r in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
