import copy

import numpy as np
import pytest

from services import r33_rank_pool as rank_pool
from services.active8_score_semantics import MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_TARGET_SEMANTIC_VERSION
from services.r33_calibration_job import POOL_SOURCE
from services.r33_crossfit_serving import ESTIMATOR
from services.r33_ensemble import build_ensemble, validate_ensemble
from services.r33_isotonic_calibration import checksum
from services.r33_isotonic_calibration import MODELS, build_payload, pava, pool_scores, predict

DAY = "2026-11-09"
SOURCE = "5" * 64


def _calibration(variant="mean_z"):
    blocks = pava([-1.0, -0.2, 0.3, 1.0], [-0.01, 0.0, 0.004, 0.01], [1, 1, 1, 1])
    return build_payload(blocks=blocks, variant=variant, horizon_sessions=5,
                         inputs={"estimator": ESTIMATOR, "source_calibration_checksum": SOURCE}, diagnostics={})


def _ensemble(variant="mean_z", calibration=None):
    return build_ensemble(
        cohort_id="c1", base_artifacts={m: {"artifact_id": f"{m}:c1", "version": f"{m}-v1", "checksum": "a" * 64}
                                        for m in MODELS},
        source_bundle={"path": "r33/monthly_candidates/c1/bundle.json", "sha256": "d" * 64, "manifest_checksum": "f" * 64,
                       "oof_checks_checksum": "c" * 64, "source_calibration_checksum": SOURCE},
        serving_calibration=calibration or _calibration(variant),
        validation={"decision": "PASS", "oof_checks_status": "pass", "pit_certified": True,
                    "pit_certification_sha256": "9" * 64})


def _identity(ensemble):
    return {"schema_version": "paired-nav-formal-ml-baseline-v1", **{k: ensemble[k] for k in rank_pool.IDENTITY_FIELDS}}


IDENTITY = _identity(_ensemble())


def _prediction(raw: dict, **lineage):
    body = {"schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION, "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
            "run_date": DAY, "model_order": list(MODELS), "raw_scores": raw,
            "artifact_versions": {m: f"{m}-v1" for m in raw}}
    body.update(lineage)
    return {"model_score_lineage": body}


def _book(n=12, seed=5):
    rng = np.random.default_rng(seed)
    symbols = [str(3000 + i) for i in range(n)]
    raws = {s: {m: float(v) for m, v in zip(MODELS, rng.normal(size=len(MODELS)))} for s in symbols}
    return symbols, raws


def _pool(symbols):
    return symbols, {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "run-1", "membership_sha256": "p" * 64}


def test_pool_rows_use_78_pool_scores_and_serving_table():
    symbols, raws = _book()
    raws[symbols[0]].pop("TimeXer")
    predictions = {s: _prediction(raws[s]) for s in symbols}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions,
                                         holdings=[], ensemble=_ensemble(), l3_identity=IDENTITY)
    raw = np.array([[raws[s].get(m, np.nan) for m in MODELS] for s in symbols])
    score, z, _ = pool_scores(raw, np.isfinite(raw), variant="mean_z")
    expected = predict(_calibration()["blocks"], score)
    for i, s in enumerate(symbols):
        evidence = predictions[s]["r33_rank_evidence"]
        assert evidence["role"] == "pool" and evidence["score"] == pytest.approx(score[i])
        assert [evidence["z"][m] for m in MODELS] == pytest.approx(list(z[i]))
        assert evidence["expected_excess"] == pytest.approx(expected[i])
    assert predictions[symbols[0]]["r33_rank_evidence"]["available"]["TimeXer"] is False
    assert snapshot["coverage"]["by_model"]["TimeXer"] == len(symbols) - 1
    assert rank_pool.validate_rank_pool(snapshot, predictions) is snapshot


@pytest.mark.parametrize("variant", ["mean_z", "mean_z_restandardized"])
def test_holding_outside_pool_is_placed_without_moving_the_pool(variant):
    symbols, raws = _book()
    holding = "9999"
    raws[holding] = {m: raws[symbols[3]][m] + 1e-9 for m in MODELS}
    predictions = {s: _prediction(raws[s]) for s in [*symbols, holding]}
    alone = {s: _prediction(raws[s]) for s in symbols}
    rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=alone, holdings=[], ensemble=_ensemble(variant), l3_identity=_identity(_ensemble(variant)))
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions,
                                         holdings=[holding, symbols[1]], ensemble=_ensemble(variant), l3_identity=_identity(_ensemble(variant)))
    for s in symbols:
        assert predictions[s]["r33_rank_evidence"]["z"] == alone[s]["r33_rank_evidence"]["z"]
        assert predictions[s]["r33_rank_evidence"]["score"] == alone[s]["r33_rank_evidence"]["score"]
    held = predictions[holding]["r33_rank_evidence"]
    assert held["role"] == "holding_outside_pool" and held["held"] is True
    assert predictions[symbols[1]]["r33_rank_evidence"]["role"] == "pool" and predictions[symbols[1]]["r33_rank_evidence"]["held"]
    # Inserted just above symbols[3] in every model: half a position above its pool rank.
    for m in MODELS:
        column = np.array([raws[s][m] for s in symbols])
        positions = np.argsort(np.argsort(column)) + 1.0
        place = positions[3] + 0.5
        assert held["z"][m] == pytest.approx((place - positions.mean()) / positions.std())
    plain = np.array([sum(alone[s]["r33_rank_evidence"]["z"].values()) / 7 for s in symbols])
    mine = sum(held["z"].values()) / 7
    expected = mine if variant == "mean_z" else (mine - plain.mean()) / plain.std()
    assert held["score"] == pytest.approx(expected)
    assert held["expected_excess"] == pytest.approx(predict(_calibration()["blocks"], [expected])[0])
    assert snapshot["coverage"]["holdings_outside_pool"] == 1


def test_tied_holding_takes_the_tied_average_position():
    symbols, raws = _book(n=6)
    raws["8888"] = dict(raws[symbols[2]])
    predictions = {s: _prediction(raws[s]) for s in [*symbols, "8888"]}
    rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=["8888"],
                              ensemble=_ensemble(), l3_identity=IDENTITY)
    assert predictions["8888"]["r33_rank_evidence"]["z"] == predictions[symbols[2]]["r33_rank_evidence"]["z"]


def test_unscored_rows_get_no_score_and_say_why():
    symbols, raws = _book()
    predictions = {s: _prediction(raws[s]) for s in symbols[1:]}
    predictions[symbols[2]] = _prediction({})
    predictions["7777"] = _prediction({m: 1.0 for m in MODELS})
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions,
                                         holdings=["7777", "6666"], ensemble=_ensemble(), l3_identity=IDENTITY,
                                         stale={symbols[3]: "last_bar=2026-11-06", "7777": "last_bar=2026-11-06"})
    unscored = snapshot["coverage"]["unscored"]
    assert unscored == {symbols[0]: "prediction_missing", symbols[2]: "no_model_available",
                        symbols[3]: "stale:last_bar=2026-11-06", "7777": "stale:last_bar=2026-11-06",
                        "6666": "prediction_missing"}
    for s in (symbols[2], symbols[3], "7777"):
        evidence = predictions[s]["r33_rank_evidence"]
        assert evidence["score"] is None and evidence["expected_excess"] is None
        assert set(evidence["z"].values()) == {0.0} and not any(evidence["available"].values())
    # Unscored rows never enter the pool's ranking: same z as a pool without them.
    kept = [s for s in symbols if s not in unscored]
    alone = {s: _prediction(raws[s]) for s in kept}
    rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(kept), predictions=alone, holdings=[], ensemble=_ensemble(), l3_identity=IDENTITY)
    assert all(alone[s]["r33_rank_evidence"]["z"] == predictions[s]["r33_rank_evidence"]["z"] for s in kept)
    assert snapshot["coverage"]["pool_scored_rows"] == len(kept)


def test_lineage_from_another_run_or_artifact_fails_closed():
    symbols, raws = _book()
    for bad, reason in (({"run_date": "2026-11-06"}, "r33_rank_pool_lineage_mismatch"),
                        ({"target_semantic_version": "x"}, "r33_rank_pool_lineage_mismatch"),
                        ({"model_order": list(MODELS[::-1])}, "r33_rank_pool_lineage_mismatch"),
                        ({"artifact_versions": {m: "old" for m in MODELS}}, "r33_rank_pool_artifact_version_mismatch")):
        predictions = {s: _prediction(raws[s]) for s in symbols}
        predictions[symbols[4]] = _prediction(raws[symbols[4]], **bad)
        with pytest.raises(ValueError, match=reason):
            rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                      ensemble=_ensemble(), l3_identity=IDENTITY)


def test_contract_and_calibration_mismatches_fail_closed():
    symbols, raws = _book()
    predictions = {s: _prediction(raws[s]) for s in symbols}
    ensemble = _ensemble()
    ensemble["variant"] = "mean_z_restandardized"
    with pytest.raises(ValueError, match="r33_ensemble_contract"):
        rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[], ensemble=ensemble, l3_identity=IDENTITY)
    ensemble = _ensemble()
    ensemble["source_bundle"]["source_calibration_checksum"] = "0" * 64
    with pytest.raises(ValueError, match="r33_serving_calibration_source_mismatch"):
        rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[], ensemble=ensemble, l3_identity=IDENTITY)
    symbols_, receipt = _pool(symbols)
    with pytest.raises(ValueError, match="r33_rank_pool_contract_mismatch"):
        rank_pool.build_rank_pool(signal_date=DAY, pool=(symbols_, dict(receipt, signal_date="2026-11-06")),
                                  predictions=predictions, holdings=[], ensemble=_ensemble(), l3_identity=IDENTITY)


def test_pipeline_identity_must_name_the_ensemble():
    symbols, raws = _book()
    predictions = {s: _prediction(raws[s]) for s in symbols}
    with pytest.raises(ValueError, match="r33_rank_pool_l3_identity_mismatch"):
        rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                  ensemble=_ensemble(), l3_identity={**IDENTITY, "payload_checksum": "f" * 64})
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                         ensemble=_ensemble(), l3_identity=IDENTITY)
    assert snapshot["l3_identity"] == IDENTITY


def test_validation_catches_tampered_snapshot_or_evidence():
    symbols, raws = _book()
    predictions = {s: _prediction(raws[s]) for s in symbols}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                         ensemble=_ensemble(), l3_identity=IDENTITY)
    tampered = copy.deepcopy(snapshot)
    tampered["rows"][0]["expected_excess"] = 0.5
    with pytest.raises(ValueError, match="r33_rank_pool_checksum_invalid"):
        rank_pool.validate_rank_pool(tampered)
    edited = copy.deepcopy(predictions)
    edited[symbols[0]]["r33_rank_evidence"]["expected_excess"] = 0.5
    with pytest.raises(ValueError, match="r33_rank_pool_evidence_mismatch"):
        rank_pool.validate_rank_pool(snapshot, edited)
    dropped = copy.deepcopy(predictions)
    del dropped[symbols[0]]["r33_rank_evidence"]
    with pytest.raises(ValueError, match="r33_rank_pool_evidence_mismatch"):
        rank_pool.validate_rank_pool(snapshot, dropped)
    stray = copy.deepcopy(predictions)
    stray["5555"] = {"r33_rank_evidence": predictions[symbols[0]]["r33_rank_evidence"]}
    with pytest.raises(ValueError, match="r33_rank_pool_evidence_mismatch"):
        rank_pool.validate_rank_pool(snapshot, stray)


def test_serving_pool_is_the_calibration_pool_of_the_pipeline_run():
    items = [dict(date=DAY, run_id="run-1", symbol="1", decision="selected", created_at="t1"),
             dict(date=DAY, run_id="run-1", symbol="2", decision="observe", created_at="t1")]

    def query(sql, params):
        assert "JOIN screener_funnel_runs" in sql
        return items

    symbols, receipt = rank_pool.load_serving_pool(query, signal_date=DAY, screener_run_id="run-1")
    assert symbols == ["1", "2"] and receipt["screener_run_id"] == "run-1" and receipt["source"] == POOL_SOURCE
    later = [*items, dict(date=DAY, run_id="run-2", symbol="3", decision="selected", created_at="t2")]
    with pytest.raises(ValueError, match="r33_rank_pool_screener_run_mismatch"):
        rank_pool.load_serving_pool(lambda sql, params: later, signal_date=DAY, screener_run_id="run-1")
    # An earlier run with the same members is still not the run the pool came from.
    same = [*items, *(dict(r, run_id="run-0", created_at="t0") for r in items)]
    with pytest.raises(ValueError, match="r33_rank_pool_screener_run_mismatch"):
        rank_pool.load_serving_pool(lambda sql, params: same, signal_date=DAY, screener_run_id="run-0")
    assert rank_pool.load_serving_pool(lambda sql, params: same, signal_date=DAY, screener_run_id="run-1")[0] == ["1", "2"]
    with pytest.raises(ValueError, match="r33_rank_pool_empty"):
        rank_pool.load_serving_pool(lambda sql, params: [], signal_date=DAY, screener_run_id="run-1")


def _reseal(ensemble, **changes):
    body = {k: v for k, v in ensemble.items() if k not in ("artifact_id", "payload_checksum")}
    body.update(changes)
    payload = checksum(body)
    return {**body, "artifact_id": f"r33-equal7:{body['cohort_id']}:{payload[:16]}", "payload_checksum": payload}


@pytest.mark.parametrize("mutate,error", [
    (lambda e: e["base_artifacts"]["TimeXer"].update(version="old"), "r33_ensemble_contract"),
    (lambda e: [a.update(version="old") for k in ("base_artifacts", "observation_artifacts") for a in e[k].values()],
     "r33_ensemble_artifact_set_checksum"),
    (lambda e: e.update(selected_models=list(MODELS)[:6]), "r33_ensemble_contract"),
    (lambda e: e["validation"].update(decision="FAIL"), "r33_ensemble_contract"),
    (lambda e: e["validation"].update(pit_certified=False), "r33_ensemble_contract"),
    (lambda e: e.update(extra=1), "r33_ensemble_contract"),
    (lambda e: e.update(artifact_id="r33-equal7:c1:0000000000000000"), "r33_ensemble_payload_checksum"),
    (lambda e: e["source_bundle"].update(sha256="0" * 64), "r33_ensemble_payload_checksum"),
    (lambda e: e.update(serving_calibration=build_payload(
        blocks=pava([-1.0, 1.0], [0.0, 0.01], [1, 1]), variant="mean_z", horizon_sessions=5,
        inputs={"source_calibration_checksum": SOURCE}, diagnostics={})), "r33_serving_calibration_not_crossfit"),
])
def test_rank_pool_validates_the_whole_ensemble_not_its_claimed_identity(mutate, error):
    symbols, raws = _book()
    predictions = {s: _prediction(raws[s]) for s in symbols}
    forged = copy.deepcopy(_ensemble())
    mutate(forged)
    with pytest.raises(ValueError, match=error):
        rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                  ensemble=forged, l3_identity=IDENTITY)


def test_a_resealed_ensemble_with_another_roster_is_another_identity():
    symbols, raws = _book()
    old = {m: {"artifact_id": f"{m}:c0", "version": "old", "checksum": "a" * 64} for m in MODELS}
    resealed = _reseal(_ensemble(), base_artifacts=old, observation_artifacts=old, base_artifact_set_checksum=checksum(old))
    assert validate_ensemble(resealed) is resealed
    predictions = {s: _prediction(raws[s], artifact_versions=dict.fromkeys(MODELS, "old")) for s in symbols}
    with pytest.raises(ValueError, match="r33_rank_pool_l3_identity_mismatch"):
        rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                  ensemble=resealed, l3_identity=IDENTITY)


def test_holding_missing_a_model_is_zero_over_seven_and_skips_uninformative_models():
    symbols, raws = _book()
    for s in symbols:                                   # TabM gives the pool no spread: uninformative today
        raws[s]["TabM"] = 0.25
    holding = "9999"
    raws[holding] = {m: raws[symbols[2]][m] + 1e-9 for m in MODELS if m != "TimeXer"}
    predictions = {s: _prediction(raws[s]) for s in [*symbols, holding]}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions,
                                         holdings=[holding], ensemble=_ensemble(), l3_identity=IDENTITY)
    assert snapshot["uninformative_models"] == ["TabM"]
    row = next(r for r in snapshot["rows"] if r["symbol"] == holding)
    assert row["available"]["TimeXer"] is False and row["z"]["TimeXer"] == 0.0
    assert row["available"]["TabM"] is True and row["z"]["TabM"] == 0.0
    for m in MODELS:
        if m in ("TimeXer", "TabM"):
            continue
        column = np.array([raws[s][m] for s in symbols])
        x = raws[holding][m]
        ranks = np.argsort(np.argsort(column)) + 1.0     # distinct values: average rank == ordinal rank
        position = 0.5 + np.sum(column < x) + 0.5 * np.sum(column == x)
        assert row["z"][m] == pytest.approx((position - ranks.mean()) / ranks.std())
    assert row["score"] == pytest.approx(sum(row["z"].values()) / 7)
    assert row["expected_excess"] == pytest.approx(float(predict(_calibration()["blocks"], [row["score"]])[0]))


def test_predictions_checksum_is_checked_on_its_own():
    symbols, raws = _book()
    predictions = {s: _prediction(raws[s]) for s in symbols}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                         ensemble=_ensemble(), l3_identity=IDENTITY)
    body = {k: v for k, v in snapshot.items() if k != "checksum"}
    body["predictions_checksum"] = "0" * 64
    with pytest.raises(ValueError, match="r33_rank_pool_predictions_checksum_invalid"):
        rank_pool.validate_rank_pool({**body, "checksum": checksum(body)})


def test_rebuild_drops_evidence_from_an_earlier_build():
    symbols, raws = _book()
    raws["9999"] = dict(raws[symbols[0]])
    predictions = {s: _prediction(raws[s]) for s in [*symbols, "9999"]}
    rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=["9999"],
                              ensemble=_ensemble(), l3_identity=IDENTITY)
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                         ensemble=_ensemble(), l3_identity=IDENTITY)
    assert rank_pool.EVIDENCE_KEY not in predictions["9999"]
    assert rank_pool.validate_rank_pool(snapshot, predictions) is snapshot


@pytest.mark.parametrize("changes", [
    {"schema_version": "r33-equal7-ensemble-v0"},
    {"kind": "active8"},
    {"cohort_id": ""},
    {"model_order": list(reversed(MODELS))},
    {"validation": {"decision": "PASS", "oof_checks_status": "fail", "pit_certified": True,
                    "pit_certification_sha256": "9" * 64}},
    {"validation": {"decision": "PASS", "oof_checks_status": "pass", "pit_certified": True}},
    {"validation": {"decision": "PASS", "oof_checks_status": "pass", "pit_certified": True,
                    "pit_certification_sha256": "not-a-sha"}},
], ids=["schema", "kind", "cohort", "order", "oof_checks", "pit_sha_missing", "pit_sha_format"])
def test_a_self_consistent_but_malformed_ensemble_is_rejected(changes):
    with pytest.raises(ValueError, match="r33_ensemble_contract"):
        validate_ensemble(_reseal(_ensemble(), **changes))


def _with_artifacts(mutate):
    artifacts = copy.deepcopy(_ensemble()["base_artifacts"])
    mutate(artifacts)
    return _reseal(_ensemble(), base_artifacts=artifacts, observation_artifacts=copy.deepcopy(artifacts),
                   base_artifact_set_checksum=checksum(artifacts))


@pytest.mark.parametrize("mutate", [
    lambda a: a.update(XGBoost={"artifact_id": "x", "version": "v", "checksum": "a" * 64}),
    lambda a: a.pop("GNN"),
    lambda a: a["TabM"].pop("checksum"),
    lambda a: a["TabM"].update(checksum="md5:" + "a" * 32),
    lambda a: a["TabM"].update(version=""),
], ids=["extra_model", "missing_model", "no_checksum", "checksum_format", "empty_version"])
def test_the_artifact_roster_must_be_exactly_seven_well_formed_artifacts(mutate):
    with pytest.raises(ValueError, match="r33_ensemble_contract"):
        validate_ensemble(_with_artifacts(mutate))


@pytest.mark.parametrize("mutate", [
    lambda s: s.pop("sha256"), lambda s: s.pop("manifest_checksum"), lambda s: s.update(oof_checks_checksum="x"),
    lambda s: s.update(path=""),
], ids=["no_sha", "no_manifest", "bad_checks", "no_path"])
def test_the_source_bundle_must_be_bound(mutate):
    source = copy.deepcopy(_ensemble()["source_bundle"])
    mutate(source)
    with pytest.raises(ValueError, match="r33_ensemble_contract"):
        validate_ensemble(_reseal(_ensemble(), source_bundle=source))


def test_bool_is_not_a_raw_score():
    symbols, raws = _book()
    predictions = {s: _prediction(raws[s]) for s in symbols}
    predictions[symbols[0]]["model_score_lineage"]["raw_scores"] = {m: True for m in MODELS}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=_pool(symbols), predictions=predictions, holdings=[],
                                         ensemble=_ensemble(), l3_identity=IDENTITY)
    assert snapshot["coverage"]["unscored"] == {symbols[0]: "no_model_available"}
