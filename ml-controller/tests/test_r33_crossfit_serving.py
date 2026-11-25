import json

import numpy as np
import polars as pl
import pytest

from services import r33_crossfit_serving as serving
from services.r33_calibration_job import MIN_BLOCK_DAYS, crossfit_expected_excess, fit_calibration, pool_score_table
from services.r33_isotonic_calibration import MODELS, build_payload, pava, predict, validate_payload

DATES = [f"2026-{m:02d}-{d:02d}" for m in (6, 7, 8) for d in range(1, 29)][:60]
SYMBOLS = [str(2000 + i) for i in range(24)]


def _oof(signal=1.0, seed=11):
    rng = np.random.default_rng(seed)
    rows = []
    for i, day in enumerate(DATES[:-5]):
        target = rng.normal(0, 0.03, len(SYMBOLS))
        for model in MODELS:
            noise = rng.normal(0, 0.03, len(SYMBOLS))
            for j, symbol in enumerate(SYMBOLS):
                rows.append(dict(prediction_date=day, symbol=symbol, model_name=model,
                                 raw_score=float(signal * target[j] + noise[j]), target_return=float(target[j]),
                                 label_known_date=DATES[i + 5], entry_limit_up=False))
    return pl.DataFrame(rows)


POOL = {d: set(SYMBOLS[:20]) for d in DATES}


def _source(oof, pool=POOL):
    return fit_calibration(oof=oof, pool_by_date=pool, round_trip_cost=0.0018, min_block_weight=MIN_BLOCK_DAYS,
                           inputs={"cohort_id": "c1", "manifest_checksum": "m" * 64})


def test_serving_table_is_g_of_f_full_on_f_full_edges():
    oof = _oof()
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL, estimator=serving.ESTIMATOR)
    assert serving.validate_serving(table, source_checksum=source["payload_checksum"]) is table
    honest = table["diagnostics"]["honest_blocks"]
    # Every F_full block maps to G(its in-sample value); T only merges F_full's edges.
    expected = predict(honest, [b["mean_excess"] for b in source["blocks"]])
    assert list(serving.serving_expected_excess(table, [b["score_lo"] for b in source["blocks"]])) == list(expected)
    los = {b["score_lo"] for b in source["blocks"]}
    his = {b["score_hi"] for b in source["blocks"]}
    assert all(b["score_lo"] in los and b["score_hi"] in his for b in table["blocks"])
    assert sum(b["n"] for b in table["blocks"]) == sum(b["n"] for b in source["blocks"])
    means = [b["mean_excess"] for b in table["blocks"]]
    assert means == sorted(means) and len(set(means)) == len(means)
    # G is fit on the purged leave-one-day-out prediction, nothing else.
    pooled = pool_score_table(oof, POOL)
    predicted, _ = crossfit_expected_excess(pooled, min_block_weight=MIN_BLOCK_DAYS)
    rows = np.concatenate([pooled["day_rows"][d] for d in sorted(pooled["day_rows"])])
    assert honest == pava(predicted[rows], pooled["excess"][rows], pooled["weight"][rows], min_block_weight=MIN_BLOCK_DAYS)
    assert table["inputs"]["source_calibration_checksum"] == source["payload_checksum"]
    assert table["inputs"]["round_trip_cost"] == 0.0018 and table["horizon_sessions"] == source["horizon_sessions"]


def test_noise_scores_lose_their_in_sample_top_edge():
    oof = _oof(signal=0.0)
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL, estimator=serving.ESTIMATOR)
    in_sample_top = source["blocks"][-1]["mean_excess"]
    assert in_sample_top > 0 and table["blocks"][-1]["mean_excess"] < in_sample_top
    assert len(table["blocks"]) <= len(source["blocks"])


def test_rebuild_is_byte_identical():
    oof = _oof()
    source = _source(oof)
    first = serving.table_bytes(serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL))
    second = serving.table_bytes(serving.build_serving_table(source=json.loads(json.dumps(source)), oof=oof,
                                                             pool_by_date=POOL))
    assert first == second


def test_source_that_does_not_reproduce_fails_closed():
    oof = _oof()
    source = _source(oof)
    other_pool = {d: set(SYMBOLS[2:22]) for d in DATES}
    with pytest.raises(ValueError, match="r33_crossfit_source_not_reproduced"):
        serving.build_serving_table(source=source, oof=oof, pool_by_date=other_pool)
    forged = {k: v for k, v in source.items() if k != "payload_checksum"}
    forged["blocks"] = [dict(b) for b in forged["blocks"]]
    forged["blocks"][-1]["mean_excess"] += 0.01
    forged = build_payload(**{k: forged[k] for k in ("blocks", "variant", "horizon_sessions", "inputs", "diagnostics")})
    with pytest.raises(ValueError, match="r33_crossfit_source_not_reproduced"):
        serving.build_serving_table(source=forged, oof=oof, pool_by_date=POOL)


def test_in_sample_payload_is_not_a_serving_table():
    oof = _oof()
    source = _source(oof)
    with pytest.raises(ValueError, match="r33_serving_calibration_not_crossfit"):
        serving.validate_serving(source)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL, estimator=serving.ESTIMATOR)
    with pytest.raises(ValueError, match="r33_serving_calibration_source_mismatch"):
        serving.validate_serving(table, source_checksum="0" * 64)
    tampered = json.loads(json.dumps(table))
    tampered["blocks"][-1]["mean_excess"] += 0.01
    with pytest.raises(ValueError, match="checksum"):
        serving.serving_expected_excess(tampered, [0.0])


def _bundle(source):
    return {"manifest_path": "m.json", "manifest_checksum": "m" * 64,
            "calibration": validate_payload(dict(source))}


def _patch_loaders(monkeypatch, oof, *, pool_receipt, price_receipt, manifest_checksum="m" * 64):
    from services import active8_oof_cohort_materializer as materializer, r33_calibration_job, r33_monthly_lifecycle
    from services import r33_oof_checks
    rows = oof.drop("entry_limit_up").to_dicts()
    monkeypatch.setattr(materializer, "load_verified_oof_manifest",
                        lambda path, **_: ({"manifest_checksum": manifest_checksum, "sequence_gcs_prefix": "s"}, b""))
    monkeypatch.setattr(materializer, "load_oof_prediction_rows", lambda manifest, **_: rows)
    monkeypatch.setattr(r33_monthly_lifecycle, "load_raw_open_close", lambda *a, **k: ("prices", price_receipt))
    monkeypatch.setattr(r33_oof_checks, "entry_limit_up_rows",
                        lambda prices: pl.DataFrame(schema={"prediction_date": pl.Utf8, "symbol": pl.Utf8}))
    monkeypatch.setattr(r33_monthly_lifecycle, "oof_frame",
                        lambda predictions, limit_up: pl.DataFrame(predictions).with_columns(
                            pl.lit(False).alias("entry_limit_up")))
    monkeypatch.setattr(r33_calibration_job, "load_l2_pool", lambda query, **_: (POOL, pool_receipt))


def test_bundle_inputs_must_match_the_sealed_receipts(monkeypatch):
    oof = _oof()
    receipts = {"pool": {"membership_sha256": "p" * 64}, "prices": {"manifest_sha256": "q" * 64}}
    source = fit_calibration(oof=oof, pool_by_date=POOL, round_trip_cost=0.0018, min_block_weight=MIN_BLOCK_DAYS,
                             inputs={"manifest_checksum": "m" * 64, **receipts})
    _patch_loaders(monkeypatch, oof, pool_receipt=receipts["pool"], price_receipt=receipts["prices"])
    loaded_source, loaded_oof, pool = serving.load_bundle_inputs(_bundle(source), bucket=None, ops_query=None)
    assert loaded_source["payload_checksum"] == source["payload_checksum"] and pool is POOL
    assert serving.build_serving_table(source=loaded_source, oof=loaded_oof, pool_by_date=pool)
    _patch_loaders(monkeypatch, oof, pool_receipt={"membership_sha256": "x" * 64}, price_receipt=receipts["prices"])
    with pytest.raises(ValueError, match="r33_crossfit_pool_receipt_mismatch"):
        serving.load_bundle_inputs(_bundle(source), bucket=None, ops_query=None)
    _patch_loaders(monkeypatch, oof, pool_receipt=receipts["pool"], price_receipt={"manifest_sha256": "x" * 64})
    with pytest.raises(ValueError, match="r33_crossfit_prices_receipt_mismatch"):
        serving.load_bundle_inputs(_bundle(source), bucket=None, ops_query=None)
    _patch_loaders(monkeypatch, oof, pool_receipt=receipts["pool"], price_receipt=receipts["prices"],
                   manifest_checksum="z" * 64)
    with pytest.raises(ValueError, match="r33_crossfit_manifest_mismatch"):
        serving.load_bundle_inputs(_bundle(source), bucket=None, ops_query=None)


# ---- L3-EV-STEP: purged-CV hinge serving curve (default estimator) ----

def _hinge_table(*, days=40, names=60, knot=1.0, slope=0.02, noise=0.004, seed=5):
    """Pool-centered excess that is flat below `knot` and rises with the score above it."""
    rng = np.random.default_rng(seed)
    score, excess, weight, day_rows = [], [], [], {}
    for i in range(days):
        s = rng.uniform(-2, 2, names)
        e = slope * np.maximum(s - knot, 0) + rng.normal(0, noise, names)
        day_rows[f"d{i:03d}"] = np.arange(i * names, (i + 1) * names)
        score += list(s); excess += list(e - e.mean()); weight += [1.0 / names] * names
    return dict(score=np.array(score), excess=np.array(excess), weight=np.array(weight), day_rows=day_rows,
                horizon=5, calendar_index={f"d{i:03d}": i for i in range(days)})


def test_default_serving_table_is_the_hinge_and_unties_the_top():
    oof = _oof()
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
    assert serving.validate_serving(table, source_checksum=source["payload_checksum"]) is table
    assert table["schema_version"] == serving.HINGE_SCHEMA and serving.estimator_of(table) == serving.HINGE_ESTIMATOR
    curve = table["curve"]
    assert curve["slope"] > 0 and curve["knot"] <= curve["score_cap"] and curve["knot_quantile"] in serving.KNOT_QUANTILES
    assert table["inputs"]["source_calibration_checksum"] == source["payload_checksum"]
    assert table["inputs"]["knot_quantiles"] == list(serving.KNOT_QUANTILES) and table["inputs"]["cv_folds"] == serving.CV_FOLDS
    assert table["model_order"] == source["model_order"] and table["horizon_sessions"] == source["horizon_sessions"]
    pooled = pool_score_table(oof, POOL)
    rows = np.concatenate(list(pooled["day_rows"].values()))
    scores = pooled["score"][rows]
    ehat = serving.serving_expected_excess(table, scores)
    above = scores > curve["knot"]
    # Flat below the knot, strictly increasing in the score above it (no ties among distinct scores).
    assert len(set(np.round(ehat[~above], 15))) == 1
    order = np.argsort(scores[above])
    distinct = np.diff(scores[above][order]) > 1e-9
    assert np.all(np.diff(ehat[above][order])[distinct] > 0)
    # Never extrapolates past the largest score the fit saw.
    assert serving.serving_expected_excess(table, [curve["score_cap"] + 5])[0] == serving.serving_range(table)[1]
    diagnostics = table["diagnostics"]
    assert [c["knot_quantile"] for c in diagnostics["knot_cv"]] == list(serving.KNOT_QUANTILES)
    assert curve["knot"] == min(diagnostics["knot_cv"], key=lambda c: c["weighted_sse"])["knot"]
    assert diagnostics["purged_leave_one_day_out"]["days"] == len(pooled["day_rows"])
    assert diagnostics["purged_leave_one_day_out"]["ic_mean"] > 0


def test_hinge_finds_the_knot_and_slope_out_of_sample():
    curve, cv = serving.fit_hinge(_hinge_table())
    assert abs(curve["knot"] - 1.0) < 0.25
    assert curve["slope"] == pytest.approx(0.02, rel=0.3)
    s = np.array([1.5, 2.0])  # well above the knot the fit reproduces the true curve
    assert serving.hinge_value(curve, s) - serving.hinge_value(curve, [-1.0])[0] == pytest.approx(0.02 * (s - 1.0), abs=0.003)
    assert len(cv) == len(serving.KNOT_QUANTILES)


def test_a_falling_relation_gets_a_flat_curve_not_a_negative_slope():
    table = _hinge_table(slope=-0.02)
    curve, _ = serving.fit_hinge(table)
    assert curve["slope"] == 0.0
    assert curve["intercept"] == pytest.approx(np.average(table["excess"], weights=table["weight"]))


def test_hinge_fit_reads_only_its_own_days():
    table = _hinge_table()
    days = sorted(table["day_rows"])
    curve, _ = serving.fit_hinge(table, days[:30])
    later = dict(table, excess=table["excess"].copy())
    for d in days[30:]:
        later["excess"][table["day_rows"][d]] += 1.0
    assert serving.fit_hinge(later, days[:30])[0] == curve


@pytest.mark.parametrize("signal", [0.0, 0.03])
def test_a_cohort_without_signal_still_builds_a_flat_honest_table(signal):
    # Held-out days whose whole pool lands on the flat part give a constant prediction: IC 0, not NaN.
    oof = _oof(signal=signal)
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
    assert serving.validate_serving(table, source_checksum=source["payload_checksum"]) is table
    lodo = table["diagnostics"]["purged_leave_one_day_out"]
    assert all(np.isfinite([lodo["ic_mean"], lodo["ic_t"], lodo["mse_skill_vs_zero"]]))
    assert table["curve"]["slope"] >= 0


def test_rank_correlation_matches_spearman_with_ties():
    from scipy.stats import spearmanr
    rng = np.random.default_rng(3)
    a, b = np.round(rng.normal(size=200), 1), rng.normal(size=200)
    assert serving._spearman(a, b) == pytest.approx(spearmanr(a, b).correlation, abs=1e-12)
    assert serving._spearman(np.full(5, 0.1), b[:5]) == 0.0


def test_hinge_needs_enough_days():
    with pytest.raises(ValueError, match="r33_hinge_too_few_days"):
        serving.fit_hinge(_hinge_table(days=2 * serving.CV_FOLDS - 1))


def test_tampered_or_invalid_hinge_fails_closed():
    oof = _oof()
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
    tampered = json.loads(json.dumps(table))
    tampered["curve"]["slope"] *= 2
    with pytest.raises(ValueError, match="checksum"):
        serving.serving_expected_excess(tampered, [0.0])
    body = {k: v for k, v in json.loads(json.dumps(table)).items() if k != "payload_checksum"}
    for key, value in (("slope", -0.001), ("knot", body["curve"]["score_cap"] + 1), ("intercept", float("nan"))):
        bad = dict(body["curve"], **{key: value})
        with pytest.raises(ValueError):
            serving._build_hinge_payload(curve=bad, variant=body["variant"], horizon_sessions=5,
                                         model_order=body["model_order"], inputs=body["inputs"], diagnostics={},
                                         score_quantiles=body["score_quantiles"])
    bad = dict(body["curve"], slope=-0.001)
    with pytest.raises(ValueError, match="r33_serving_curve_invalid"):
        serving._build_hinge_payload(curve=bad, variant=body["variant"], horizon_sessions=5,
                                     model_order=body["model_order"], inputs=body["inputs"], diagnostics={},
                                         score_quantiles=body["score_quantiles"])
    # A curve whose top end overflows, a curve that is not an object, a bool horizon, and display
    # quantiles that are missing, short, decreasing, non-finite or past the cap.
    huge = dict(body["curve"], slope=1e308, knot=body["curve"]["score_cap"] - 10.0)
    q = body["score_quantiles"]
    for patch in (dict(curve=huge), dict(curve=[body["curve"]]), dict(horizon_sessions=True),
                  dict(score_quantiles=None), dict(score_quantiles=q[:-1]), dict(score_quantiles=q[::-1]),
                  dict(score_quantiles=[*q[:-1], body["curve"]["score_cap"] + 1]), dict(score_quantiles=[True] * 21)):
        bad = dict(body, **patch)
        bad["payload_checksum"] = serving.checksum(bad)
        with pytest.raises(ValueError, match="r33_serving_curve_invalid|r33_calibration_horizon_invalid"
                                             "|r33_serving_score_quantiles_invalid"):
            serving.validate_serving(bad)
    foreign = dict(body, inputs=dict(body["inputs"], estimator=serving.ESTIMATOR))
    foreign["payload_checksum"] = serving.checksum(foreign)
    with pytest.raises(ValueError, match="r33_serving_calibration_not_crossfit"):
        serving.validate_serving(foreign)
    with pytest.raises(ValueError, match="r33_serving_calibration_source_mismatch"):
        serving.validate_serving(table, source_checksum="0" * 64)


def test_legacy_step_table_still_serves_and_rebuilds_with_its_own_estimator():
    oof = _oof()
    source = _source(oof)
    step = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL, estimator=serving.ESTIMATOR)
    again = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL, estimator=serving.estimator_of(step))
    assert serving.table_bytes(step) == serving.table_bytes(again)
    assert serving.serving_range(step) == (min(b["mean_excess"] for b in step["blocks"]),
                                           max(b["mean_excess"] for b in step["blocks"]))
    # Byte for byte what c9d333ff (before the hinge) built from the same inputs.
    import hashlib
    assert hashlib.sha256(serving.table_bytes(step)).hexdigest() == \
        "69015b6b5d72d0700ea84fe61590664ef50190ed5678919ca1778668031acd75"
    hinge = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
    assert serving.table_bytes(hinge) != serving.table_bytes(step)
    with pytest.raises(ValueError, match="r33_serving_estimator_unknown"):
        serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL, estimator=None)


def test_sanity_reads_the_hinge_curve():
    oof = _oof()
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
    pooled = pool_score_table(oof, POOL)
    sanity = serving.serving_curve_sanity(table, table=pooled, round_trip_cost=0.00585)
    assert sanity["estimator"] == serving.HINGE_ESTIMATOR and sanity["blocks"] is None
    assert sanity["top_block_mean_excess"] == serving.serving_range(table)[1]
    expected = serving._above_cost(pooled, serving.hinge_value(table["curve"], pooled["score"]), 0.00585)
    assert sanity["serving_above_cost"] == expected
    # The hinge also carries its own out-of-sample cost line (purged leave-one-day-out refits).
    heldout, _ = serving.hinge_heldout(pooled)
    assert sanity["crossfit_above_cost"] == serving._above_cost(pooled, heldout, 0.00585)


def test_a_hinge_without_out_of_sample_edge_fails_its_sanity():
    # Pure noise: whatever the in-sample curve does, the held-out cost line has no positive bound.
    oof = _oof(signal=0.0)
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
    sanity = serving.serving_curve_sanity(table, table=pool_score_table(oof, POOL), round_trip_cost=0.00585)
    assert sanity["passed"] is False
    assert "crossfit_net_of_cost_lower_bound_not_positive" in sanity["reasons"]


def test_each_estimator_has_its_own_table_path_and_display_quantiles():
    assert serving.table_name(serving.ESTIMATOR) == serving.TABLE_NAME
    assert serving.table_name(serving.HINGE_ESTIMATOR) == "crossfit_serving_table.r33-purged-cv-hinge-v1.json"
    with pytest.raises(ValueError, match="r33_serving_estimator_unknown"):
        serving.table_name("other")
    oof = _oof()
    source = _source(oof)
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
    pooled = pool_score_table(oof, POOL)
    q = table["score_quantiles"]
    assert len(q) == 21 and q == sorted(q) and q[0] == pooled["score"].min() and q[-1] == table["curve"]["score_cap"]
    position = serving.score_position(table, pooled["score"])
    share_below_median = float(np.average(position < 0.5, weights=pooled["weight"]))
    assert abs(share_below_median - 0.5) < 0.05
    step = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL, estimator=serving.ESTIMATOR)
    assert serving.score_position(step, [0.0]) is None
