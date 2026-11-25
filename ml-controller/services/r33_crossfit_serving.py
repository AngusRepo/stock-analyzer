"""R33 serving calibration of E[5-session pool-relative excess | roster score].

Two estimators, both rebuilt from the sealed OOF and pool receipt (the reproduced in-sample
F_full must match the bundle's sealed checksum):

ESTIMATOR (step, D-2/Q10, legacy): T = G o F_full. F_full is the PAVA on every pool row;
G is the PAVA of realized excess on the purged leave-one-day-out prediction p. T only has
G's few values (core4 cohort: 4 values, 75% of the pool on one), and inside one F_full block
p varies only by which days were left out, which is anti-correlated with the day's own
excess, so G is fit on noise that points the wrong way.

HINGE_ESTIMATOR (L3-EV-STEP, default): E = a + b * max(min(score, cap) - knot, 0), b >= 0,
weighted least squares with every day weighing one, the knot chosen among score quantiles by
purged contiguous-day cross-validation, cap = the largest score the fit saw (no extrapolation).
On the core4 OOF the realized excess is flat over the lower ~85% of scores and rises in the top
tail; the hinge is flat where the data are and rising where they rise, so names above the knot
are no longer tied. Out of sample (time split, purged leave-one-day-out, purged 10-fold) it is
never worse than the step table on squared error and keeps the score's rank IC; its own purged
leave-one-day-out check is recorded in the payload's diagnostics.
"""
from __future__ import annotations

import argparse
import json
import math
import re

import numpy as np

from services.alpha_model_roster import is_r33_roster
from services.r33_calibration_job import crossfit_expected_excess, fit_calibration, pool_score_table
from services.r33_isotonic_calibration import (VARIANTS, build_payload, canonical_json, checksum, pava, predict,
                                               validate_payload)

ESTIMATOR = "r33-purged-crossfit-recalibrated-v1"
HINGE_ESTIMATOR = "r33-purged-cv-hinge-v1"
HINGE_SCHEMA = "r33-roster-hinge-excess-v1"
ESTIMATORS = (ESTIMATOR, HINGE_ESTIMATOR)
# Knot candidates (row quantiles of the score) and the contiguous-day folds that choose one.
KNOT_QUANTILES = (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95)
CV_FOLDS = 5
TABLE_NAME = "crossfit_serving_table.json"
# Display only: day-weighted score quantiles of the fit's pool rows at these probabilities.
SCORE_QUANTILE_PROBS = tuple(i / 20 for i in range(21))
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def estimator_of(payload: dict) -> str | None:
    return (payload.get("inputs") or {}).get("estimator")


def table_name(estimator: str) -> str:
    """Each estimator's table is its own write-once object in the cohort directory; the legacy
    table keeps the original name, so a live legacy grant still names its own path."""
    if estimator == ESTIMATOR:
        return TABLE_NAME
    if estimator in ESTIMATORS:
        return f"crossfit_serving_table.{estimator}.json"
    raise ValueError(f"r33_serving_estimator_unknown:{estimator}")


def _weighted_quantiles(values, weights, probs) -> list[float]:
    order = np.argsort(values, kind="stable")
    v, w = np.asarray(values, dtype=float)[order], np.asarray(weights, dtype=float)[order]
    cdf = (np.cumsum(w) - 0.5 * w) / w.sum()
    return [float(x) for x in np.interp(probs, cdf, v)]


def score_position(payload: dict, scores) -> np.ndarray | None:
    """Display only: where each score sits in the fit's own pool (day-weighted CDF, 0..1).

    Monotone in the score, so it orders names as E-hat does, and it separates the names a
    flat part of the curve gives one E-hat. None for a legacy step table (no quantiles)."""
    quantiles = payload.get("score_quantiles")
    if payload.get("schema_version") != HINGE_SCHEMA or quantiles is None:
        return None
    return np.interp(np.asarray(scores, dtype=float), quantiles, SCORE_QUANTILE_PROBS)


def hinge_value(curve: dict, scores) -> np.ndarray:
    s = np.minimum(np.asarray(scores, dtype=float), curve["score_cap"])
    return curve["intercept"] + curve["slope"] * np.maximum(s - curve["knot"], 0.0)


def _ranks(x: np.ndarray) -> np.ndarray:
    _, inverse, counts = np.unique(x, return_inverse=True, return_counts=True)
    ends = np.cumsum(counts)
    return ((ends - counts + ends - 1) / 2.0)[inverse]


def _spearman(a, b) -> float:
    """Rank correlation with average ties, numpy only (sealed bytes must not move with scipy);
    0 when either side is constant, e.g. a day whose whole pool sits on the flat part."""
    ra, rb = _ranks(np.asarray(a, dtype=float)), _ranks(np.asarray(b, dtype=float))
    ra, rb = ra - ra.mean(), rb - rb.mean()
    denom = math.sqrt(float((ra * ra).sum()) * float((rb * rb).sum()))
    return float((ra * rb).sum()) / denom if denom > 0 else 0.0


def _wls_hinge(score, excess, weight, knot: float, cap: float) -> tuple[float, float]:
    """Closed-form weighted least squares of excess on the hinge; a negative slope is 0."""
    h = np.maximum(np.minimum(score, cap) - knot, 0.0)
    total = float(weight.sum())
    mh, me = float((weight * h).sum()) / total, float((weight * excess).sum()) / total
    var = float((weight * (h - mh) ** 2).sum())
    slope = float((weight * (h - mh) * (excess - me)).sum()) / var if var > 0 else 0.0
    slope = slope if slope > 0 else 0.0
    return me - slope * mh, slope


def _purged_train(days, held, index, horizon):
    lo, hi = index[held[0]], index[held[-1]]
    return [d for d in days if index[d] <= lo - horizon or index[d] >= hi + horizon]


def fit_hinge(table: dict, days=None) -> tuple[dict, list[dict]]:
    """The hinge on `days` (default every pool day of the table); knot by purged day-block CV."""
    days = sorted(table["day_rows"]) if days is None else sorted(days)
    if len(days) < 2 * CV_FOLDS:
        raise ValueError("r33_hinge_too_few_days")
    index, horizon = table["calendar_index"], table["horizon"]
    score, excess, weight = table["score"], table["excess"], table["weight"]

    def rows(ds):
        return np.concatenate([table["day_rows"][d] for d in ds])

    every = rows(days)
    cap = float(score[every].max())
    knots = [float(v) for v in np.quantile(score[every], KNOT_QUANTILES)]
    sse = [0.0] * len(knots)
    for fold in np.array_split(np.arange(len(days)), CV_FOLDS):
        held = [days[i] for i in fold]
        train = _purged_train(days, held, index, horizon)
        if not train:
            raise ValueError("r33_hinge_fold_without_training_days")
        rt, rv = rows(train), rows(held)
        for j, knot in enumerate(knots):
            a, b = _wls_hinge(score[rt], excess[rt], weight[rt], knot, cap)
            fitted = a + b * np.maximum(np.minimum(score[rv], cap) - knot, 0.0)
            sse[j] += float(np.sum(weight[rv] * (excess[rv] - fitted) ** 2))
    best = int(np.argmin(sse))
    a, b = _wls_hinge(score[every], excess[every], weight[every], knots[best], cap)
    curve = dict(kind="hinge", intercept=a, slope=b, knot=knots[best], knot_quantile=KNOT_QUANTILES[best], score_cap=cap)
    cv = [dict(knot_quantile=q, knot=k, weighted_sse=s) for q, k, s in zip(KNOT_QUANTILES, knots, sse)]
    return curve, cv


def hinge_heldout(table: dict) -> tuple[np.ndarray, dict]:
    """Purged leave-one-day-out hinge (refit, knot re-chosen, on each training set) and its scores."""
    days = sorted(table["day_rows"])
    index, horizon = table["calendar_index"], table["horizon"]
    out = np.full(len(table["score"]), np.nan)
    for day in days:
        train = [d for d in days if abs(index[d] - index[day]) >= horizon]
        curve, _ = fit_hinge(table, train)
        rows = table["day_rows"][day]
        out[rows] = hinge_value(curve, table["score"][rows])
    loss, base, ics = 0.0, 0.0, []
    for day in days:
        rows = table["day_rows"][day]
        e, p = table["excess"][rows], out[rows]
        loss += float(np.mean((e - p) ** 2)); base += float(np.mean(e ** 2))
        ics.append(_spearman(p, e))
    ics = np.asarray(ics)
    sd = float(ics.std(ddof=1)) if len(ics) > 1 else 0.0
    return out, dict(days=len(days), mse_skill_vs_zero=1 - loss / base if base > 0 else 0.0,
                     ic_mean=float(ics.mean()), ic_t=float(ics.mean() / (sd / math.sqrt(len(ics)))) if sd > 0 else 0.0)


def _build_hinge_payload(*, curve, variant, horizon_sessions, model_order, inputs, diagnostics,
                         score_quantiles) -> dict:
    body = dict(schema_version=HINGE_SCHEMA, variant=variant, model_order=list(model_order),
                horizon_sessions=int(horizon_sessions), target="daily_pool_centered_excess_return",
                weighting="each_day_equal", curve=curve, score_quantiles=list(score_quantiles),
                inputs=inputs, diagnostics=diagnostics)
    payload = dict(body, payload_checksum=checksum(body))
    _validate_hinge(payload)
    return payload


def _validate_hinge(payload: dict) -> dict:
    body = {k: v for k, v in payload.items() if k != "payload_checksum"}
    if payload.get("schema_version") != HINGE_SCHEMA or payload.get("payload_checksum") != checksum(body):
        raise ValueError("r33_calibration_payload_checksum_invalid")
    if payload.get("variant") not in VARIANTS or not is_r33_roster(payload.get("model_order")):
        raise ValueError("r33_calibration_payload_contract_invalid")
    horizon = payload.get("horizon_sessions")
    if not isinstance(horizon, int) or isinstance(horizon, bool) or horizon < 1:
        raise ValueError("r33_calibration_horizon_invalid")
    curve = payload.get("curve")
    if not isinstance(curve, dict):
        raise ValueError("r33_serving_curve_invalid")
    values = [curve.get(k) for k in ("intercept", "slope", "knot", "score_cap")]
    if (curve.get("kind") != "hinge" or not all(isinstance(v, (int, float)) and not isinstance(v, bool)
                                                 and math.isfinite(v) for v in values)
            or curve["slope"] < 0 or curve["knot"] > curve["score_cap"]
            or not math.isfinite(curve["intercept"] + curve["slope"] * (curve["score_cap"] - curve["knot"]))):
        raise ValueError("r33_serving_curve_invalid")
    quantiles = payload.get("score_quantiles")
    if (not isinstance(quantiles, list) or len(quantiles) != len(SCORE_QUANTILE_PROBS)
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in quantiles)
            or any(b < a for a, b in zip(quantiles, quantiles[1:])) or quantiles[-1] > curve["score_cap"]):
        raise ValueError("r33_serving_score_quantiles_invalid")
    return payload


def serving_range(payload: dict) -> tuple[float, float]:
    """Lowest and highest E-hat the serving table can return."""
    if payload.get("schema_version") == HINGE_SCHEMA:
        curve = payload["curve"]
        return float(curve["intercept"]), float(hinge_value(curve, [curve["score_cap"]])[0])
    values = [float(b["mean_excess"]) for b in payload["blocks"]]
    return min(values), max(values)


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
    line = _above_cost(table, serving_expected_excess(payload, table["score"]), round_trip_cost)
    top = serving_range(payload)[1]
    checks = [("top_block_not_above_cost", top > round_trip_cost),
              ("realized_excess_lower_bound_not_positive", _lower_bound_positive(line["realized_excess"])),
              ("net_of_cost_lower_bound_not_positive", _lower_bound_positive(line["net_of_cost"]))]
    heldout_line = None
    if payload.get("schema_version") == HINGE_SCHEMA:
        # The hinge's own out-of-sample cost line (purged leave-one-day-out refits) at the serving
        # round trip, under the same C1/C2 rule: the monthly gate measured the step cross-fit only.
        heldout, _ = hinge_heldout(table)
        heldout_line = _above_cost(table, heldout, round_trip_cost)
        checks += [("crossfit_realized_excess_lower_bound_not_positive",
                    _lower_bound_positive(heldout_line["realized_excess"])),
                   ("crossfit_net_of_cost_lower_bound_not_positive", _lower_bound_positive(heldout_line["net_of_cost"]))]
    reasons = [name for name, ok in checks if not ok]
    out = dict(schema_version=SANITY_SCHEMA, passed=not reasons, reasons=reasons, round_trip_cost=round_trip_cost,
               serving_table_checksum=payload["payload_checksum"], top_block_mean_excess=top,
               blocks=len(payload["blocks"]) if "blocks" in payload else None, estimator=estimator_of(payload),
               serving_above_cost=line, in_sample=True)
    if heldout_line is not None:
        out["crossfit_above_cost"] = heldout_line
    return out


def rebuild_and_check(bundle: dict, *, bucket, ops_query, round_trip_cost: float,
                      estimator: str = HINGE_ESTIMATOR) -> tuple[dict, dict]:
    """B-7 + B-1: the serving table rebuilt from the bundle's archived OOF and pool receipt, and
    its sanity at the serving cost. Callers compare the rebuilt bytes with the table they hold
    (pass that table's estimator to re-verify a legacy step table)."""
    source, oof, pool = load_bundle_inputs(bundle, bucket=bucket, ops_query=ops_query)
    rebuilt = build_serving_table(source=source, oof=oof, pool_by_date=pool, estimator=estimator)
    table = pool_score_table(oof, pool, variant=source["variant"])
    return rebuilt, serving_curve_sanity(rebuilt, table=table, round_trip_cost=round_trip_cost)


def build_serving_table(*, source: dict, oof, pool_by_date, estimator: str = HINGE_ESTIMATOR) -> dict:
    if estimator not in ESTIMATORS:
        raise ValueError("r33_serving_estimator_unknown:" + str(estimator))
    validate_payload(source)
    inputs = source["inputs"]
    cost, min_weight = inputs["round_trip_cost"], inputs["min_block_weight"]
    refit = fit_calibration(oof=oof, pool_by_date=pool_by_date, round_trip_cost=cost, variant=source["variant"],
                            min_block_weight=min_weight,
                            inputs={k: v for k, v in inputs.items() if k not in ("round_trip_cost", "min_block_weight")})
    if refit["payload_checksum"] != source["payload_checksum"]:
        raise ValueError("r33_crossfit_source_not_reproduced")
    table = pool_score_table(oof, pool_by_date, variant=source["variant"])
    if estimator == HINGE_ESTIMATOR:
        curve, cv = fit_hinge(table)
        heldout, heldout_scores = hinge_heldout(table)
        every = np.concatenate([table["day_rows"][d] for d in sorted(table["day_rows"])])
        diagnostics = dict(source_blocks=source["blocks"], knot_cv=cv,
                           purged_leave_one_day_out=heldout_scores,
                           crossfit_above_cost=_above_cost(table, heldout, cost),
                           serving_above_cost=_above_cost(table, hinge_value(curve, table["score"]), cost))
        return _build_hinge_payload(
            curve=curve, variant=source["variant"], horizon_sessions=source["horizon_sessions"],
            model_order=source["model_order"], diagnostics=diagnostics,
            score_quantiles=_weighted_quantiles(table["score"][every], table["weight"][every], SCORE_QUANTILE_PROBS),
            inputs=dict(inputs, estimator=HINGE_ESTIMATOR, source_calibration_checksum=source["payload_checksum"],
                        knot_quantiles=list(KNOT_QUANTILES), cv_folds=CV_FOLDS))
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
    if payload.get("schema_version") == HINGE_SCHEMA:
        _validate_hinge(payload)
        expected = HINGE_ESTIMATOR
    else:
        validate_payload(payload)
        expected = ESTIMATOR
    inputs = payload.get("inputs") or {}
    source = inputs.get("source_calibration_checksum")
    if inputs.get("estimator") != expected or not isinstance(source, str) or not _SHA256.match(source):
        raise ValueError("r33_serving_calibration_not_crossfit")
    if source_checksum is not None and source != source_checksum:
        raise ValueError("r33_serving_calibration_source_mismatch")
    return payload


def serving_expected_excess(payload: dict, scores, *, source_checksum: str | None = None):
    payload = validate_serving(payload, source_checksum=source_checksum)
    if payload["schema_version"] == HINGE_SCHEMA:
        return hinge_value(payload["curve"], scores)
    return predict(payload["blocks"], scores)


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
    group.add_argument("--verify", help="local copy of a stored table to compare against (its own estimator)")
    parser.add_argument("--estimator", choices=ESTIMATORS, help=f"for --out (default {HINGE_ESTIMATOR})")
    args = parser.parse_args(argv)
    if args.verify and args.estimator:
        parser.error("--verify rebuilds with the stored table's own estimator; drop --estimator")
    from google.cloud import storage
    from services.d1_domain_client import D1DataDomain, client_proxy_for_domain

    stored = None
    if args.verify:
        with open(args.verify, "rb") as handle:
            stored = handle.read()
    estimator = (args.estimator or HINGE_ESTIMATOR) if stored is None else estimator_of(json.loads(stored))
    bucket = storage.Client().bucket(args.bucket)
    bundle = json.loads(bucket.blob(args.bundle).download_as_bytes())
    source, oof, pool = load_bundle_inputs(bundle, bucket=bucket,
                                           ops_query=client_proxy_for_domain(D1DataDomain.OPS).query)
    serving = build_serving_table(source=source, oof=oof, pool_by_date=pool, estimator=estimator)
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
    identical = stored == rebuilt
    print(json.dumps({"verify": args.verify, "estimator": estimator, "byte_identical": identical}))
    return 0 if identical else 1


if __name__ == "__main__":
    raise SystemExit(main())
