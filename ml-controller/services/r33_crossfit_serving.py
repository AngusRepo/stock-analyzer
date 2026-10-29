"""R33 serving calibration: honest recalibration of the sealed in-sample table (D-2, Q10).

The bundle's calibration F_full is a PAVA fit on every pool row, so its values are
in-sample (the r32 top block read about 3x its cross-fit realization). Serving uses
T = G o F_full: F_full keeps the ordering and segmentation; each block's value becomes
G(value), where G is the PAVA of realized excess on the purged leave-one-day-out
prediction p (a row's excess never entered its own p). Everything is rebuilt from the
sealed OOF and pool receipt; the reproduced F_full must match the sealed checksum.

The table is an ordinary #78 payload (same blocks, same lookup), marked by its estimator.
"""
from __future__ import annotations

import argparse
import json
import re

import numpy as np

from services.r33_calibration_job import crossfit_expected_excess, fit_calibration, pool_score_table
from services.r33_isotonic_calibration import build_payload, canonical_json, pava, predict, validate_payload

ESTIMATOR = "r33-purged-crossfit-recalibrated-v1"
TABLE_NAME = "crossfit_serving_table.json"
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _compose(full_blocks: list[dict], honest: list[dict]) -> list[dict]:
    """F_full's edges with G(value); adjacent equal values merge."""
    values = predict(honest, [b["mean_excess"] for b in full_blocks])
    out: list[dict] = []
    for block, value in zip(full_blocks, values):
        if out and out[-1]["mean_excess"] == float(value):
            last = out[-1]
            last.update(score_hi=block["score_hi"], weight=last["weight"] + block["weight"], n=last["n"] + block["n"])
        else:
            out.append(dict(score_lo=block["score_lo"], score_hi=block["score_hi"], mean_excess=float(value),
                            weight=block["weight"], n=block["n"]))
    return out


def _above_cost(table: dict, expected, cost: float) -> dict:
    picks = [table["excess"][rows][expected[rows] > cost] for _, rows in sorted(table["day_rows"].items())]
    realized = [float(p.mean()) for p in picks if len(p)]
    return dict(days_with_picks=len(realized), picks_per_day=float(np.mean([len(p) for p in picks])),
                realized_excess_mean=float(np.mean(realized)) if realized else None)


def build_serving_table(*, source: dict, oof, pool_by_date) -> dict:
    validate_payload(source)
    inputs = source["inputs"]
    cost, min_weight = inputs["round_trip_cost"], inputs["min_block_weight"]
    refit = fit_calibration(oof=oof, pool_by_date=pool_by_date, round_trip_cost=cost, variant=source["variant"],
                            min_block_weight=min_weight,
                            inputs={k: v for k, v in inputs.items() if k not in ("round_trip_cost", "min_block_weight")})
    if refit["payload_checksum"] != source["payload_checksum"]:
        raise ValueError("r33_crossfit_source_not_reproduced")
    table = pool_score_table(oof, pool_by_date, variant=source["variant"])
    predicted, _ = crossfit_expected_excess(table, min_block_weight=min_weight)
    rows = np.concatenate([table["day_rows"][d] for d in sorted(table["day_rows"])])
    rows = rows[np.isfinite(predicted[rows])]
    if not len(rows):
        raise ValueError("r33_crossfit_no_heldout_rows")
    honest = pava(predicted[rows], table["excess"][rows], table["weight"][rows], min_block_weight=min_weight)
    blocks = _compose(source["blocks"], honest)
    serving = predict(blocks, table["score"])
    diagnostics = dict(source_blocks=source["blocks"], honest_blocks=honest, heldout_rows=int(len(rows)),
                       crossfit_above_cost=_above_cost(table, predicted, cost),
                       serving_above_cost=_above_cost(table, serving, cost))
    return build_payload(blocks=blocks, variant=source["variant"], horizon_sessions=source["horizon_sessions"],
                         inputs=dict(inputs, estimator=ESTIMATOR, source_calibration_checksum=source["payload_checksum"]),
                         diagnostics=diagnostics)


def validate_serving(payload: dict, *, source_checksum: str | None = None) -> dict:
    """An in-sample #78 payload is not a serving table; fail closed on anything else."""
    validate_payload(payload)
    inputs = payload.get("inputs") or {}
    source = inputs.get("source_calibration_checksum")
    if inputs.get("estimator") != ESTIMATOR or not isinstance(source, str) or not _SHA256.match(source):
        raise ValueError("r33_serving_calibration_not_crossfit")
    if source_checksum is not None and source != source_checksum:
        raise ValueError("r33_serving_calibration_source_mismatch")
    return payload


def serving_expected_excess(payload: dict, scores, *, source_checksum: str | None = None):
    return predict(validate_serving(payload, source_checksum=source_checksum)["blocks"], scores)


def table_bytes(payload: dict) -> bytes:
    return canonical_json(payload).encode("utf-8")


def load_bundle_inputs(bundle: dict, *, bucket, ops_query):
    """Sealed OOF + pool for one bundle; both receipts must equal the ones sealed in its calibration."""
    from services.active8_oof_cohort_materializer import load_oof_prediction_rows, load_verified_oof_manifest
    from services.r33_calibration_job import load_l2_pool
    from services.r33_monthly_lifecycle import _canonical, load_raw_open_close, oof_frame
    from services.r33_oof_checks import entry_limit_up_rows

    source = validate_payload(bundle["calibration"])
    manifest, _ = load_verified_oof_manifest(bundle["manifest_path"], bucket=bucket, require_formal_lineage=True)
    if not manifest["manifest_checksum"] == bundle["manifest_checksum"] == source["inputs"].get("manifest_checksum"):
        raise ValueError("r33_crossfit_manifest_mismatch")
    predictions = load_oof_prediction_rows(manifest, bucket=bucket)
    dates = sorted({row["prediction_date"] for row in predictions})
    prices, price_receipt = load_raw_open_close(bucket, manifest["sequence_gcs_prefix"], start=dates[0])
    pool, pool_receipt = load_l2_pool(ops_query, start=dates[0], end=dates[-1])
    for name, receipt in (("pool", pool_receipt), ("prices", price_receipt)):
        if _canonical(receipt) != _canonical(source["inputs"].get(name)):
            raise ValueError(f"r33_crossfit_{name}_receipt_mismatch")
    return source, oof_frame(predictions, entry_limit_up_rows(prices)), pool


def main(argv=None) -> int:
    """Rebuild a cohort's serving table locally; --verify compares it byte for byte. Never writes GCS."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", default="stockvision-models")
    parser.add_argument("--bundle", required=True, help="object path, e.g. r33/monthly_candidates/<cohort>/bundle.json")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--out", help="local file to write the rebuilt table")
    group.add_argument("--verify", help="local copy of a stored table to compare against")
    args = parser.parse_args(argv)
    from google.cloud import storage
    from services.d1_domain_client import D1DataDomain, client_proxy_for_domain

    bucket = storage.Client().bucket(args.bucket)
    bundle = json.loads(bucket.blob(args.bundle).download_as_bytes())
    source, oof, pool = load_bundle_inputs(bundle, bucket=bucket,
                                           ops_query=client_proxy_for_domain(D1DataDomain.OPS).query)
    rebuilt = table_bytes(build_serving_table(source=source, oof=oof, pool_by_date=pool))
    if args.out:
        with open(args.out, "wb") as handle:
            handle.write(rebuilt)
        print(json.dumps({"written": args.out, "payload_checksum": json.loads(rebuilt)["payload_checksum"]}))
        return 0
    with open(args.verify, "rb") as handle:
        identical = handle.read() == rebuilt
    print(json.dumps({"verify": args.verify, "byte_identical": identical}))
    return 0 if identical else 1


if __name__ == "__main__":
    raise SystemExit(main())
