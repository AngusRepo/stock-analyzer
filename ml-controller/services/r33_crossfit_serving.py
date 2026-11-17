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
    """The monthly gate's cost line (r33_oof_checks C1/C2) for one estimator: per day, the mean
    realized excess of the names whose expected excess clears the round trip."""
    from services.r33_oof_checks import _mean_se
    picks = [table["excess"][rows][expected[rows] > cost] for _, rows in sorted(table["day_rows"].items())]
    realized = np.array([float(p.mean()) for p in picks if len(p)])
    return dict(days_with_picks=len(realized), picks_per_day=float(np.mean([len(p) for p in picks])),
                realized_excess_mean=float(np.mean(realized)) if len(realized) else None,
                realized_excess=_mean_se(realized), net_of_cost=_mean_se(realized - cost), round_trip_cost=cost)


SANITY_SCHEMA = "r33-serving-curve-sanity-v1"


def serving_curve_sanity(payload: dict, *, table: dict, round_trip_cost: float) -> dict:
    """B-1 (HB1105, Wei 2026-11-12 Q12): the monthly gate measures the cross-fit p, serving uses
    T = G o F_full, and T had no gate. Before T serves, on the bundle's own pool rows (`table`,
    pool_score_table of the archived OOF) at the serving round trip, T must clear the gate's own
    cost lines (C1 realized excess, C2 net of cost: mean minus one SE > 0; the same rule, no new
    constant), and its top block must clear that cost (else serving never buys). T is in-sample
    on those rows, so a pass is a floor, not out-of-sample evidence. The monthly gate itself is
    not changed here (Q12: before the December cohort). Report only; callers fail closed."""
    from services.r33_oof_checks import _lower_bound_positive
    validate_serving(payload)
    if not (isinstance(round_trip_cost, float) and np.isfinite(round_trip_cost) and round_trip_cost > 0):
        raise ValueError("r33_round_trip_cost_invalid")
    line = _above_cost(table, predict(payload["blocks"], table["score"]), round_trip_cost)
    top = max(float(b["mean_excess"]) for b in payload["blocks"])
    reasons = [name for name, ok in (
        ("top_block_not_above_cost", top > round_trip_cost),
        ("realized_excess_lower_bound_not_positive", _lower_bound_positive(line["realized_excess"])),
        ("net_of_cost_lower_bound_not_positive", _lower_bound_positive(line["net_of_cost"]))) if not ok]
    return dict(schema_version=SANITY_SCHEMA, passed=not reasons, reasons=reasons, round_trip_cost=round_trip_cost,
                serving_table_checksum=payload["payload_checksum"], top_block_mean_excess=top,
                blocks=len(payload["blocks"]), serving_above_cost=line, in_sample=True)


def rebuild_and_check(bundle: dict, *, bucket, ops_query, round_trip_cost: float) -> tuple[dict, dict]:
    """B-7 + B-1: the serving table rebuilt from the bundle's archived OOF and pool receipt, and
    its sanity at the serving cost. Callers compare the rebuilt bytes with the table they hold."""
    source, oof, pool = load_bundle_inputs(bundle, bucket=bucket, ops_query=ops_query)
    rebuilt = build_serving_table(source=source, oof=oof, pool_by_date=pool)
    table = pool_score_table(oof, pool, variant=source["variant"])
    return rebuilt, serving_curve_sanity(rebuilt, table=table, round_trip_cost=round_trip_cost)


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
    serving = build_serving_table(source=source, oof=oof, pool_by_date=pool)
    rebuilt = table_bytes(serving)
    if args.out:
        with open(args.out, "wb") as handle:
            handle.write(rebuilt)
        # B-1 sanity at the serving round trip (trading:config.fees); written for review either
        # way, exit 2 when it fails. The switch re-runs it and fails closed.
        from services.r33_monthly_lifecycle import gate_round_trip_cost
        sanity = serving_curve_sanity(serving, table=pool_score_table(oof, pool, variant=source["variant"]),
                                      round_trip_cost=gate_round_trip_cost()["round_trip_cost"])
        print(json.dumps({"written": args.out, "payload_checksum": serving["payload_checksum"], "sanity": sanity}))
        return 0 if sanity["passed"] else 2
    with open(args.verify, "rb") as handle:
        identical = handle.read() == rebuilt
    print(json.dumps({"verify": args.verify, "byte_identical": identical}))
    return 0 if identical else 1


if __name__ == "__main__":
    raise SystemExit(main())
