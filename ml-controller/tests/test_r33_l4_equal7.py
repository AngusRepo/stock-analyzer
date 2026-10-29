from copy import deepcopy
from datetime import datetime, timezone

import numpy as np
import pytest

from services import l3_equal_weight_bundle as equal7
from services import r33_rank_pool as rank_pool
from services.active8_score_semantics import MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_TARGET_SEMANTIC_VERSION
from services.l4_distribution import digest, validate_bundle
from services.l4_distribution_lifecycle import ACCEPTANCE_CHECKS, prepare_paper_release
from services.l4_distribution_runtime import run
from services.r33_calibration_job import POOL_SOURCE
from services.r33_crossfit_serving import ESTIMATOR
from services.r33_ensemble import build_ensemble
from services.r33_isotonic_calibration import MODELS, build_payload, pava

DAY = "2026-11-10"
POOL = ["P1", "P2", "P3", "P4", "P5", "P6"]


def _calibration(xs=(-1.0, -0.2, 0.3, 1.0), ys=(-0.02, 0.0, 0.01, 0.03)):
    return build_payload(blocks=pava(list(xs), list(ys), [1] * len(xs)), variant="mean_z", horizon_sessions=5,
                         inputs={"estimator": ESTIMATOR, "source_calibration_checksum": "5" * 64}, diagnostics={})


def _ensemble(calibration=None):
    return build_ensemble(
        cohort_id="c1", base_artifacts={m: {"artifact_id": f"{m}:c1", "version": m + "-v1", "checksum": "sha256:" + "a" * 64}
                                        for m in MODELS},
        source_bundle={"path": "r33/monthly_candidates/c1/bundle.json", "sha256": "d" * 64, "manifest_checksum": "f" * 64,
                       "oof_checks_checksum": "c" * 64, "source_calibration_checksum": "5" * 64},
        serving_calibration=calibration or _calibration(),
        validation={"decision": "PASS", "oof_checks_status": "pass", "pit_certified": True,
                    "pit_certification_sha256": "9" * 64})


IDENTITY = {"schema_version": "paired-nav-formal-ml-baseline-v1",
            **{k: _ensemble()[k] for k in rank_pool.IDENTITY_FIELDS}}


def _prediction(value):
    raw = {m: value + 0.01 * i for i, m in enumerate(MODELS)}
    return {"model_score_lineage": {"schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION,
                                    "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION, "run_date": DAY,
                                    "model_order": list(MODELS), "raw_scores": raw,
                                    "artifact_versions": {m: m + "-v1" for m in MODELS}}}


def _bundle(model_changes=None, l4plus=None):
    candidate = equal7.build_bundle(l3_identity=IDENTITY, ensemble=_ensemble(), training_label_known_max="2026-10-30")
    if model_changes:                                   # a bundle sealed over other bindings
        candidate["model"].update(model_changes)
        candidate["model_checksum"] = digest(candidate["model"])
    if l4plus is not None:
        candidate["l4plus"] = l4plus
    receipt = {"schema_version": "l4-paper-acceptance-v1", "model_checksum": candidate["model_checksum"],
               "l3_identity_checksum": digest(IDENTITY), "feature_schema": equal7.FEATURE_SCHEMA,
               "checks": dict.fromkeys(ACCEPTANCE_CHECKS, True), "source_evidence_checksum": "c" * 64,
               "acceptance_mode": "paper_experiment", "efficacy_status": "unproven",
               "experiment_authorization": {"scope": "paper", "approved": True, "source_reference": "test-fixture",
                                            "model_checksum": candidate["model_checksum"]}}
    return prepare_paper_release(candidate, receipt, signal_date=DAY)


def fixture(holdings=(), candidates=("P1", "P2", "P3", "P4", "P5", "P6"), extra_predictions=None, stale=None):
    predictions = {s: _prediction(v) for s, v in zip(POOL, (-0.5, -0.1, 0.2, 0.6, 1.0, 1.4))}
    predictions.update(extra_predictions or {})
    receipt = {"source": POOL_SOURCE, "signal_date": DAY, "screener_run_id": "run-1", "membership_sha256": "p" * 64}
    snapshot = rank_pool.build_rank_pool(signal_date=DAY, pool=(POOL, receipt), predictions=predictions,
                                         holdings=[h["symbol"] for h in holdings], ensemble=_ensemble(),
                                         l3_identity=IDENTITY, stale=stale)
    recs = [{"symbol": s, "signal": "HOLD", "eligible_for_pending_buy": 1, "score_components": {}} for s in candidates]
    nav = 1_000_000
    policy = {"scope": "paper", "artifact": _bundle(),
              "constraints": {"exposure_cap": .9, "name_cap": .3, "min_weight": .03, "max_positions": 3,
                              "buy_cost": .001, "sell_cost": .004},
              "runtime": {"signal_date": DAY, "l3_identity": IDENTITY, "predictions": predictions,
                          "r33_rank_pool": snapshot,
                          "account": {"schema_version": "l4-account-context-v1", "account_id": 1, "signal_date": DAY,
                                      "active_plan_id": None, "observed_at": datetime.now(timezone.utc).isoformat(),
                                      "nav": nav, "available_cash": nav - sum(h["market_value"] for h in holdings),
                                      "complete": True, "holdings": list(holdings), "forbidden_buys": []}}}
    symbols = set(candidates) | {h["symbol"] for h in holdings}
    history = {s: (np.sin(np.arange(30) + i) * .01).tolist() for i, s in enumerate(sorted(symbols))}
    return recs, policy, history


def test_bundle_binds_ensemble_and_calibration_and_passes_paper_release():
    bundle = _bundle()
    validate_bundle(bundle, l3_identity=IDENTITY, signal_date=DAY)
    assert bundle["model"]["feature_names"] == [*(f"{m}_{k}" for m in MODELS for k in ("z", "available")), "score"]
    assert bundle["model"]["calibration_checksum"] == _ensemble()["serving_calibration"]["payload_checksum"]
    for mutate, error in ((lambda b: b["model"].update(calibration_checksum="0" * 64), "r33_bundle_model_checksum"),
                          (lambda b: b.update(feature_schema="full-l3-30-timexer-signals-v4"), "r33_bundle_contract"),
                          (lambda b: b["model"].update(heads={}), "r33_bundle_contract"),
                          (lambda b: b.update(training_label_known_max=DAY), "r33_bundle_training_after_signal")):
        broken = deepcopy(bundle)
        mutate(broken)
        with pytest.raises(ValueError, match=error):
            validate_bundle(broken, l3_identity=IDENTITY, signal_date=DAY)
    with pytest.raises(ValueError, match="r33_bundle_l3_identity"):
        validate_bundle(bundle, l3_identity={**IDENTITY, "artifact_id": "other"}, signal_date=DAY)
    unreleased = {k: v for k, v in bundle.items() if k != "release"}
    with pytest.raises(ValueError, match="paper_release_missing"):
        validate_bundle(unreleased, l3_identity=IDENTITY, signal_date=DAY)


def test_allocator_reads_rank_pool_ehat_as_pool_relative_excess():
    recs, policy, history = fixture()
    rows = run(deepcopy(recs), deepcopy(policy), return_history=history)
    plan = rows[0]["_l4_portfolio_plan"]
    snapshot = policy["runtime"]["r33_rank_pool"]
    ehat = {r["symbol"]: r["expected_excess"] for r in snapshot["rows"]}
    for row in rows:
        allocation = row["alpha_allocation"]
        assert allocation["expected_return"] == ehat[row["symbol"]]
        assert allocation["expected_return_semantic"] == "five_session_relative_pool_decimal"
        assert allocation["expected_return_source"] == equal7.MODEL_SCHEMA
        assert allocation["r33"]["score"] == next(r["score"] for r in snapshot["rows"] if r["symbol"] == row["symbol"])
    assert plan["r33_projection"]["rank_pool_checksum"] == snapshot["checksum"]
    assert plan["input_attribution"]["model_feature_names"] == list(equal7.FEATURE_NAMES)
    assert plan["prediction_coverage"]["unavailable"] == {}
    chosen = {s for s, w in plan["weights"].items() if w > 1e-7}
    assert chosen and all(ehat[s] > 0 for s in chosen)
    assert run(deepcopy(recs), deepcopy(policy), return_history=history)[0]["_l4_portfolio_plan"]["plan_id"] == plan["plan_id"]


def test_unscored_or_unpooled_candidate_is_unavailable_for_the_day_not_the_plan():
    recs, policy, history = fixture(candidates=("P1", "P2", "P3", "P4", "P5", "P6", "X9"), stale={"P6": "last_bar=2026-11-07"},
                                    extra_predictions={"X9": _prediction(0.3)})
    rows = run(deepcopy(recs), deepcopy(policy), return_history=history)
    plan = rows[0]["_l4_portfolio_plan"]
    assert plan["prediction_coverage"]["unavailable"] == {"P6": ["r33_unscored:stale:last_bar=2026-11-07"],
                                                         "X9": ["r33_rank_pool_missing"]}
    assert {"P6", "X9"} <= set(plan["forbidden_buys"]) and plan["weights"]["P6"] == plan["weights"]["X9"] == 0
    by_symbol = {r["symbol"]: r for r in rows}
    assert by_symbol["P6"]["alpha_allocation"]["expected_return"] is None
    assert by_symbol["P6"]["alpha_allocation"]["ehat_missing_reason"] == "stale:last_bar=2026-11-07"
    assert by_symbol["X9"]["alpha_allocation"]["ehat_missing_reason"] == "r33_rank_pool_missing"


def test_holding_outside_pool_is_locked_but_carries_its_ehat():
    holding = {"symbol": "H1", "market_value": 100_000}
    recs, policy, history = fixture(holdings=[holding], extra_predictions={"H1": _prediction(-0.4)})
    plan = run(deepcopy(recs), deepcopy(policy), return_history=history)[0]["_l4_portfolio_plan"]
    target = plan["targets"]["H1"]
    row = next(r for r in policy["runtime"]["r33_rank_pool"]["rows"] if r["symbol"] == "H1")
    assert target["locked"] and plan["weights"]["H1"] == pytest.approx(.1)
    assert row["role"] == "holding_outside_pool" and target["expected_return_gross"] == row["expected_excess"]
    assert target["r33"]["role"] == "holding_outside_pool" and target["ehat_missing_reason"] is None


def test_held_name_without_ehat_is_locked_with_reason():
    holding = {"symbol": "H2", "market_value": 100_000}
    recs, policy, history = fixture(holdings=[holding])
    plan = run(deepcopy(recs), deepcopy(policy), return_history=history)[0]["_l4_portfolio_plan"]
    target = plan["targets"]["H2"]
    assert target["locked"] and target["expected_return_gross"] is None
    assert target["ehat_missing_reason"] == "prediction_missing"


@pytest.mark.parametrize("mutate,error", [
    (lambda p: p["runtime"].pop("r33_rank_pool"), "r33_rank_pool_checksum_invalid"),
    (lambda p: p["runtime"]["predictions"]["P2"]["r33_rank_evidence"].update(expected_excess=0.5),
     "r33_rank_pool_evidence_mismatch"),
    (lambda p: p["runtime"].update(l3_identity={**IDENTITY, "cohort_id": "c2"}), "r33_bundle_l3_identity"),
])
def test_rank_pool_must_be_attested_for_this_run(mutate, error):
    recs, policy, history = fixture()
    mutate(policy)
    with pytest.raises(ValueError, match=error):
        run(deepcopy(recs), policy, return_history=history)


def test_rank_pool_from_another_calibration_is_rejected():
    recs, policy, history = fixture()
    other = _calibration((0.0, 1.0), (0.0, 0.05))
    policy["artifact"] = _bundle({"calibration_checksum": other["payload_checksum"]})
    with pytest.raises(ValueError, match="r33_rank_pool_identity_mismatch"):
        run(deepcopy(recs), policy, return_history=history)


def test_r2_shadow_cannot_share_the_equal7_bundle():
    recs, policy, history = fixture()
    with pytest.raises(ValueError, match="r33_multiple_model_owners"):
        run(deepcopy(recs), policy, return_history=history, r2_shadow={"forecast": {}})


def test_opb_v2_envelope_owns_the_position_count_for_equal7():
    from services.l4_allocation_contract import policy_v2_from_v1
    recs, value, history = fixture()
    runtime = value.pop("runtime")
    value["constraints"]["risk_aversion"] = 2.
    value["opb"] = {"enabled": True, "exploration": .01, "approved_policy_identity": "d" * 64,
                    "arms": [{"id": "base", "constraints": {}}]}
    v2 = policy_v2_from_v1(value, lookback=252, cost_objective="entry_round_trip_v1")
    for cap in (1, 2):
        account = dict(runtime["account"], risk_limits={"exposure_cap": .9, "name_cap": .5, "max_positions": cap,
                                                        "min_trade_value": 30000, "buys_halted": False},
                       fees={"buy_cost": .001, "sell_cost": .004})
        plan = run(deepcopy(recs), {**deepcopy(v2), "runtime": {**runtime, "account": account}},
                   return_history=history)[0]["_l4_portfolio_plan"]
        assert plan["opb"]["effective_constraints"]["max_positions"] == cap
        assert 1 <= sum(w > 1e-7 for w in plan["weights"].values()) <= cap


def _prepare(policy, predictions, **kw):
    from services.l4_distribution_context import prepare_runtime_policy
    manifest = {"active8_ensemble": dict(IDENTITY),
                "active8_action_authority": {"mode": "paper_ensemble", "execution_scope": "paper",
                                             "buy_authorized": False, "live_buy_authorized": False,
                                             "paper_buy_authorized": True, "production_effect": True,
                                             **{k: IDENTITY[k] for k in ("artifact_id", "cohort_id", "payload_checksum")}}}
    account = {**policy["runtime"]["account"], "risk_limits": {"max_positions": 3}, "fees": {"buy_cost": .001}}
    return prepare_runtime_policy(policy={k: v for k, v in policy.items() if k != "runtime"}, signal_date=DAY,
                                  predictions=predictions, manifest=manifest,
                                  account_reader=lambda _: {**account, "observed_at": datetime.now(timezone.utc).isoformat()},
                                  reward_reader=lambda: [], **kw)


def test_prepare_freezes_the_attested_rank_pool_into_runtime():
    _, policy, _ = fixture()
    snapshot, predictions = policy["runtime"]["r33_rank_pool"], policy["runtime"]["predictions"]
    frozen = _prepare(policy, predictions, r33_rank_pool=snapshot)
    assert frozen["runtime"]["r33_rank_pool"] == snapshot
    assert frozen["runtime"]["r33_rank_pool"] is not snapshot
    assert frozen["runtime"]["l3_identity"] == IDENTITY


@pytest.mark.parametrize("case,error", [
    ("missing", "r33_rank_pool_required"),
    ("forged_evidence", "r33_rank_pool_evidence_mismatch:P3"),
    ("other_day", "r33_rank_pool_identity_mismatch"),
    ("other_identity", "r33_rank_pool_identity_mismatch"),
    ("tampered", "r33_rank_pool_checksum_invalid"),
])
def test_prepare_rejects_an_equal7_policy_without_this_runs_rank_pool(case, error):
    _, policy, _ = fixture()
    snapshot, predictions = deepcopy(policy["runtime"]["r33_rank_pool"]), deepcopy(policy["runtime"]["predictions"])
    if case == "missing":
        snapshot = None
    elif case == "forged_evidence":
        predictions["P3"][rank_pool.EVIDENCE_KEY]["expected_excess"] = 0.5
    elif case == "other_day":
        # A pool attested for the next day, with its own predictions: internally consistent, wrong run.
        other = "2026-11-11"
        predictions = {s: _prediction(v) for s, v in zip(POOL, (-0.5, -0.1, 0.2, 0.6, 1.0, 1.4))}
        for p in predictions.values():
            p["model_score_lineage"]["run_date"] = other
        receipt = {"source": POOL_SOURCE, "signal_date": other, "screener_run_id": "run-2", "membership_sha256": "p" * 64}
        snapshot = rank_pool.build_rank_pool(signal_date=other, pool=(POOL, receipt), predictions=predictions,
                                             holdings=[], ensemble=_ensemble(), l3_identity=IDENTITY)
    elif case == "other_identity":
        body = {k: v for k, v in snapshot.items() if k != "checksum"}
        body["l3_identity"] = {**body["l3_identity"], "cohort_id": "c2"}
        snapshot = {**body, "checksum": rank_pool.checksum(body)}
    else:
        snapshot["rows"][0]["score"] = 9.0
    with pytest.raises(ValueError, match=error):
        _prepare(policy, predictions, r33_rank_pool=snapshot)


def test_prepare_rejects_a_rank_pool_for_a_non_equal7_bundle(monkeypatch):
    from services import l4_distribution
    _, policy, _ = fixture()
    # Any other (already validated) bundle: the rank pool would have no owner.
    monkeypatch.setattr(l4_distribution, "validate_bundle", lambda *a, **kw: None)
    policy["artifact"] = {**policy["artifact"], "model": {**policy["artifact"]["model"], "schema_version": "other"}}
    with pytest.raises(ValueError, match="r33_rank_pool_without_equal7_bundle"):
        _prepare(policy, policy["runtime"]["predictions"], r33_rank_pool=policy["runtime"]["r33_rank_pool"])


def test_bundle_must_name_the_l3_ensemble_and_own_calibration_alone():
    with pytest.raises(ValueError, match="r33_bundle_ensemble_mismatch"):
        validate_bundle(_bundle({"ensemble_payload_checksum": "0" * 64}), l3_identity=IDENTITY, signal_date=DAY)
    with pytest.raises(ValueError, match="r33_multiple_calibration_owners"):
        validate_bundle(_bundle(l4plus={"enabled": True}), l3_identity=IDENTITY, signal_date=DAY)
    validate_bundle(_bundle(l4plus={"enabled": False}), l3_identity=IDENTITY, signal_date=DAY)


def test_bundle_is_built_only_from_a_valid_ensemble():
    forged = _ensemble()
    forged["base_artifacts"]["TabM"]["version"] = "old"
    with pytest.raises(ValueError, match="r33_ensemble_contract"):
        equal7.build_bundle(l3_identity=IDENTITY, ensemble=forged, training_label_known_max="2026-10-30")


def test_candidate_without_any_prediction_is_unavailable_not_a_failed_plan():
    recs, policy, history = fixture(candidates=("P1", "P2", "P3", "P4", "P5", "P6", "X8"))
    history["X8"] = history["P1"]
    rows = run(deepcopy(recs), deepcopy(policy), return_history=history)
    plan = rows[0]["_l4_portfolio_plan"]
    assert plan["prediction_coverage"]["unavailable"] == {"X8": ["r33_rank_pool_missing"]}
    assert "X8" in plan["forbidden_buys"] and plan["weights"]["X8"] == 0


def test_prepare_warns_about_a_holding_the_rank_pool_never_saw(caplog):
    _, policy, _ = fixture()
    policy["runtime"]["account"]["holdings"] = [{"symbol": "H7", "market_value": 1000}]
    with caplog.at_level("WARNING"):
        _prepare(policy, policy["runtime"]["predictions"], r33_rank_pool=policy["runtime"]["r33_rank_pool"])
    assert "['H7']" in caplog.text
