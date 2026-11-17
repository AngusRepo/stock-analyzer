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
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
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
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
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
    table = serving.build_serving_table(source=source, oof=oof, pool_by_date=POOL)
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
