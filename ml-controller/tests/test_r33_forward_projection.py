"""L4-FWD-P1: roster-invariant R33 forward projection (plan l4-roster-agnostic-20261123 §6.2/§6.3).

Synthetic frozen allocation contexts built by the real producers (rank pool, ensemble,
serving view, L4 bundle). No prod data."""
from copy import deepcopy

import numpy as np
import pytest

from services import alpha_model_roster, r33_isotonic_calibration as calibration
from services import l4_forward_refresh as refresh_module
from services import r33_forward_projection as projection
from services.active8_score_semantics import MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_TARGET_SEMANTIC_VERSION
from services.alpha_model_roster import R33_MODELS, TIMEXER_MODELS
from services.l3_equal_weight_bundle import build_bundle
from services.l4_forward_materialization import digest, materialize
from services.r33_calibration_job import POOL_SOURCE
from services.r33_crossfit_serving import ESTIMATOR, HINGE_ESTIMATOR, _build_hinge_payload, hinge_value
from services.r33_ensemble import build_ensemble, serving_view
from services.r33_rank_pool import IDENTITY_FIELDS, build_rank_pool

DAY = "2026-10-01"
SOURCE = "5" * 64
CORE4 = ("LightGBM", "ExtraTrees", "TabM", "GNN")
ROSTERS = [("GNN",), ("LightGBM", "TabM", "GNN"), CORE4, tuple(n for n in TIMEXER_MODELS if n != "XGBoost")]


# What PR #255 serves: E = a + b * max(min(score, cap) - knot, 0), flat below the knot.
HINGE_CURVE = dict(kind="hinge", intercept=-0.001, slope=0.02, knot=0.2, knot_quantile=0.85, score_cap=1.5)


def _serving_table(roster, estimator):
    if estimator == HINGE_ESTIMATOR:
        return _build_hinge_payload(curve=dict(HINGE_CURVE), variant="mean_z", horizon_sessions=5,
                                    model_order=list(roster), diagnostics={},
                                    score_quantiles=[-1.5 + 0.15 * i for i in range(21)],
                                    inputs={"estimator": HINGE_ESTIMATOR, "source_calibration_checksum": SOURCE})
    saved = calibration.MODELS
    calibration.MODELS = tuple(roster)   # what a cohort trained on this roster sealed
    try:
        blocks = calibration.pava([-1.0, -0.2, 0.3, 1.0], [-0.01, 0.0, 0.004, 0.01], [1, 1, 1, 1])
        return calibration.build_payload(blocks=blocks, variant="mean_z", horizon_sessions=5,
                                         inputs={"estimator": ESTIMATOR, "source_calibration_checksum": SOURCE},
                                         diagnostics={})
    finally:
        calibration.MODELS = saved


def r33_context(roster=CORE4, *, signal_date=DAY, snapshot_id="r33", n=10, seed=7, holdings=(), unscored=(),
                cohort="c1", frozen_at=None, estimator=ESTIMATOR):
    """(frozen, identity) for one R33 allocation_context, sealed under `roster` with a serving
    table of `estimator` (the legacy step table, or the hinge served since PR #255)."""
    table = _serving_table(roster, estimator)
    ensemble = build_ensemble(
        cohort_id=cohort, base_artifacts={m: {"artifact_id": f"{m}:{cohort}", "version": f"{m}-v1", "checksum": "a" * 64}
                                          for m in roster},
        source_bundle={"path": f"r33/monthly_candidates/{cohort}/bundle.json", "sha256": "d" * 64,
                       "manifest_checksum": "f" * 64, "oof_checks_checksum": "c" * 64,
                       "source_calibration_checksum": SOURCE},
        serving_calibration=table,
        validation={"decision": "PASS", "oof_checks_status": "pass", "pit_certified": True,
                    "pit_certification_sha256": "9" * 64})
    identity = {"schema_version": "paired-nav-formal-ml-baseline-v1", **{k: ensemble[k] for k in IDENTITY_FIELDS}}
    rng = np.random.default_rng(seed)
    symbols = [str(3000 + i) for i in range(n)]
    predictions = {}
    for s in [*symbols, *holdings]:
        raw = {} if s in unscored else {m: float(v) for m, v in zip(roster, rng.normal(size=len(roster)))}
        predictions[s] = {"model_score_lineage": {
            "schema_version": MODEL_SCORE_LINEAGE_SCHEMA_VERSION, "target_semantic_version": MODEL_TARGET_SEMANTIC_VERSION,
            "run_date": signal_date, "model_order": list(roster), "raw_scores": raw,
            "artifact_versions": {m: f"{m}-v1" for m in raw}}}
    pool = (symbols, {"source": POOL_SOURCE, "signal_date": signal_date, "screener_run_id": "run-1",
                      "membership_sha256": "p" * 64})
    rank_pool = build_rank_pool(signal_date=signal_date, pool=pool, predictions=predictions, holdings=list(holdings),
                                ensemble=ensemble, l3_identity=identity)
    for prediction in predictions.values():
        prediction["ensemble_v2"] = serving_view(prediction, ensemble, cost=0.00585)
    bundle = build_bundle(l3_identity=identity, ensemble=ensemble, training_label_known_max="2026-09-24")
    manifest = dict(snapshot_id=snapshot_id, signal_date=signal_date, snapshot_kind="allocation_context",
                    payload_checksum="c" * 64, frozen_at=frozen_at or f"{signal_date}T23:00:00+08:00")
    runtime = dict(signal_date=signal_date, l3_identity=identity, predictions=deepcopy(predictions),
                   r33_rank_pool=rank_pool)
    content = dict(model_predictions=deepcopy(predictions),
                   inputs=dict(alpha_policy=dict(l4Distribution=dict(artifact=bundle, runtime=runtime))))
    return dict(manifest=manifest, payload=dict(content=content)), identity


def _policy(frozen):
    return frozen["payload"]["content"]["inputs"]["alpha_policy"]["l4Distribution"]


@pytest.mark.parametrize("roster", ROSTERS)
def test_r33_forward_projection_is_roster_size_invariant(monkeypatch, roster):
    frozen, identity = r33_context(roster)
    # The checkout's training roster is never read: change it and nothing moves.
    monkeypatch.setattr(alpha_model_roster, "R33_MODELS", ("GNN",))
    monkeypatch.setattr(calibration, "MODELS", ("GNN",))
    snapshot = refresh_module.project(deepcopy(frozen))
    assert snapshot["feature_schema"] == projection.FEATURE_SCHEMA
    assert snapshot["pool_contract"] == projection.POOL_CONTRACT
    assert snapshot["l3_identity"] == identity and snapshot["l3_training_label_known_max"] == "2026-09-24"
    assert snapshot["r33_lineage"]["model_order"] == list(roster) and snapshot["r33_lineage"]["roster_size"] == len(roster)
    assert snapshot["features_checksum"] == digest(snapshot["feature_rows"])
    pool_rows = {r["symbol"]: r for r in _policy(frozen)["runtime"]["r33_rank_pool"]["rows"]}
    for row in snapshot["feature_rows"]:
        assert tuple(row["features"]) == projection.FEATURE_NAMES
        assert set(row["evidence"]["z"]) == set(roster) == set(row["evidence"]["available"])
        source = pool_rows[row["symbol"]]
        assert row["features"]["ehat"] == source["expected_excess"] and row["features"]["score"] == source["score"]
        z = [source["z"][m] for m in roster if source["available"][m]]
        assert row["features"]["z_mean"] == pytest.approx(np.mean(z))
        assert row["features"]["z_sd"] == pytest.approx(np.std(z))
        assert row["features"]["z_range"] == pytest.approx(max(z) - min(z))
        assert row["features"]["available_fraction"] == row["features"]["available_count"] / len(roster)
        assert row["l3_baseline"]["model_order"] == list(roster)
    monkeypatch.undo()
    assert refresh_module.project(deepcopy(frozen)) == snapshot


def test_only_scored_pool_rows_are_projected_and_unscored_ones_are_reported():
    frozen, _ = r33_context(holdings=("9999",), unscored=("3001",))
    snapshot = projection.project_r33(frozen)
    assert "9999" not in snapshot["eligible_symbols"] and "3001" not in snapshot["eligible_symbols"]
    assert snapshot["coverage_exclusions"] == [dict(symbol="3001", reason="r33_unscored", details=["no_model_available"])]
    assert snapshot["r33_lineage"]["holdings_outside_pool"] == 1
    assert len(snapshot["feature_rows"]) == 9


@pytest.mark.parametrize("tamper,error", [
    (lambda f: _policy(f)["runtime"]["predictions"]["3000"]["ensemble_v2"].update(model_order=["GNN"]),
     "l4_forward_r33_roster_disagreement"),
    (lambda f: f["payload"]["content"]["model_predictions"]["3002"]["ensemble_v2"].update(calibration_checksum="0" * 64),
     "l4_forward_r33_roster_disagreement"),
    (lambda f: _policy(f).pop("artifact"), "l4_forward_r33_bundle_missing"),
    (lambda f: _policy(f)["runtime"].update(l3_identity={**_policy(f)["runtime"]["l3_identity"], "cohort_id": "c2"}),
     "l4_forward_r33_identity_mismatch"),
    (lambda f: _policy(f)["runtime"]["r33_rank_pool"]["rows"][0].update(score=9.0), "r33_rank_pool_checksum_invalid"),
])
def test_model_order_disagreement_is_integrity_failure(tamper, error):
    frozen, _ = r33_context()
    tamper(frozen)
    with pytest.raises(ValueError, match=error):
        projection.project_r33(frozen)


def test_a_bundle_sealed_for_another_roster_is_refused():
    frozen, _ = r33_context()
    other, _ = r33_context(("LightGBM", "TabM", "GNN"), cohort="c2")
    _policy(frozen)["artifact"] = _policy(other)["artifact"]
    with pytest.raises(ValueError, match="r33_bundle"):
        projection.project_r33(frozen)


CALENDAR = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]


def _prices(symbols, *, missing=()):
    out = {}
    for i, s in enumerate(symbols):
        if s in missing:
            continue
        out[("2026-10-02", s)] = dict(adj_open=100.0, source_sha256="b" * 64)
        out[("2026-10-08", s)] = dict(adj_close=100.0 + i, source_sha256="b" * 64)
    return out


def test_prior_identity_snapshot_still_matures_after_roster_change():
    """Q4: identity A (core4) snapshot, live bundle now identity B (three models): rows still mature with A."""
    frozen, identity_a = r33_context(CORE4)
    _, identity_b = r33_context(("LightGBM", "TabM", "GNN"), cohort="c2")
    assert identity_a != identity_b
    snapshot = projection.project_r33(frozen)
    manifest = frozen["manifest"]
    result = refresh_module.refresh(
        query=lambda *a: [manifest], bucket=_Bucket(), price_capture={}, expected_identity=identity_b,
        cutoff="2026-10-09T10:00:00+08:00", snapshot_reader=lambda sid: deepcopy(frozen),
        price_loader=lambda *a, **k: (CALENDAR, _prices(snapshot["eligible_symbols"]), {"verified": True}))
    item = result["items"][0]
    assert result["status"] == "refreshed" and item["status"] == "ready"
    assert item["l3_identity"] == identity_a and item["rows"] == 10
    assert item["training_eligible"] is False and item["training_blocker"] == "pool_contract_mismatch_evaluation_only"
    assert result["latest_mature_evaluation_date"] == DAY and result["latest_training_eligible_date"] is None


def test_pool_relative_labels_only_on_complete_days():
    frozen, identity = r33_context()
    snapshot = projection.project_r33(frozen)
    symbols = snapshot["eligible_symbols"]
    kwargs = dict(calendar=CALENDAR, cutoff="2026-10-09T10:00:00+08:00", expected_identity=identity,
                  pool_contract=refresh_module.NATIVE_POOL)
    rows, receipt = materialize(snapshot, prices=_prices(symbols), **kwargs)
    labels = projection.pool_relative_labels(rows, receipt)
    returns = {r["symbol"]: r["gross_return"] for r in rows}
    mean = sum(returns.values()) / len(returns)
    assert labels["pool_relative_excess"] == pytest.approx({s: v - mean for s, v in returns.items()})
    assert sum(labels["pool_relative_excess"].values()) == pytest.approx(0.0, abs=1e-12)
    assert labels["rows_checksum"] == receipt["rows_checksum"] and labels["n"] == 10
    rows, receipt = materialize(snapshot, prices=_prices(symbols, missing=(symbols[0],)), **kwargs)
    assert receipt["status"] == "incomplete_labels" and projection.pool_relative_labels(rows, receipt) is None


class _Blob:
    generation = 1

    def __init__(self, owner, key):
        self.owner, self.key, self.name = owner, key, key

    def exists(self):
        return self.key in self.owner.data

    def download_as_bytes(self, **kwargs):
        return self.owner.data[self.key]

    def upload_from_string(self, raw, **kwargs):
        if self.exists():
            from google.api_core.exceptions import PreconditionFailed
            raise PreconditionFailed("already exists")
        self.owner.data[self.key] = raw.encode() if isinstance(raw, str) else raw


class _Bucket:
    def __init__(self):
        self.data = {}

    def blob(self, key):
        return _Blob(self, key)

    def list_blobs(self, prefix):
        return [_Blob(self, k) for k in sorted(self.data) if k.startswith(prefix)]


def test_refresh_publishes_labels_and_registry_keeps_r33_out_of_training():
    import json
    from services.l4_forward_training import load_current_registry, merge_materializations
    frozen, identity = r33_context()
    bucket = _Bucket()
    symbols = projection.project_r33(frozen)["eligible_symbols"]
    refresh_module.refresh(query=lambda *a: [frozen["manifest"]], bucket=bucket, price_capture={},
                           expected_identity=identity, cutoff="2026-10-09T10:00:00+08:00",
                           snapshot_reader=lambda sid: deepcopy(frozen),
                           price_loader=lambda *a, **k: (CALENDAR, _prices(symbols), {"verified": True}))
    bodies, registry = load_current_registry(bucket, cutoff="2026-10-09T10:00:00+08:00")
    assert registry["status"] == "verified" and registry["excluded"] == [] and len(bodies) == 1
    body = bodies[0]
    assert body["pool_relative_labels"]["n"] == 10 and body["receipt"]["feature_schema"] == projection.FEATURE_SCHEMA
    assert {r["l3_baseline"]["calibration_checksum"] for r in body["rows"]} == {
        _policy(frozen)["runtime"]["r33_rank_pool"]["calibration_checksum"]}
    projected = json.loads(bucket.data[body["projection"]["path"]])
    assert set(projected["feature_rows"][0]["evidence"]["z"]) == set(CORE4)
    # Evaluation-only: no trainer admits it, even under its own identity and schema.
    _, _, ledger = merge_materializations([], bodies, identity=identity, feature_schema=projection.FEATURE_SCHEMA,
                                          as_of="2026-10-09")
    assert ledger == [dict(snapshot_id="r33", date=DAY, status="excluded", reason="pool_contract_mismatch_evaluation_only")]


def test_uninformative_model_is_available_but_not_z_evidence():
    frozen, _ = r33_context()
    rows = {r["symbol"]: r for r in _policy(frozen)["runtime"]["r33_rank_pool"]["rows"]}
    stats = projection._z_stats(rows["3000"]["z"], rows["3000"]["available"], CORE4, {"TabM"})
    z = [rows["3000"]["z"][m] for m in CORE4 if m != "TabM"]
    assert stats == pytest.approx(dict(z_mean=np.mean(z), z_sd=np.std(z), z_range=max(z) - min(z)))
    assert projection._z_stats(rows["3000"]["z"], rows["3000"]["available"], CORE4, set(CORE4)) == dict(
        z_mean=0.0, z_sd=0.0, z_range=0.0)


def test_a_foreign_runtime_view_is_a_disagreement_not_skipped():
    frozen, _ = r33_context()
    _policy(frozen)["runtime"]["predictions"]["3004"]["ensemble_v2"]["schema_version"] = "active8-v2"
    with pytest.raises(ValueError, match="l4_forward_r33_roster_disagreement"):
        projection.project_r33(frozen)


def _refresh(frozen, bucket, symbols, *, identity):
    return refresh_module.refresh(
        query=lambda *a: [frozen["manifest"]], bucket=bucket, price_capture={}, expected_identity=identity,
        cutoff="2026-10-09T10:00:00+08:00", snapshot_reader=lambda sid: deepcopy(frozen),
        price_loader=lambda *a, **k: (CALENDAR, _prices(symbols), {"verified": True}))


def test_unscored_pool_rows_keep_the_evaluation_only_blocker():
    frozen, identity = r33_context(unscored=("3001",))
    symbols = projection.project_r33(frozen)["eligible_symbols"]
    bucket = _Bucket()
    result = _refresh(frozen, bucket, symbols, identity=identity)
    item = result["items"][0]
    assert (item["training_blocker"], item["coverage_blocker"]) == (
        "pool_contract_mismatch_evaluation_only", "incomplete_original_l3_coverage")
    assert refresh_module.callback_summary(result)["coverage_blocker_counts"] == {"incomplete_original_l3_coverage": 1}
    # The rows matured, but the pool had an unscored name: no honest pool mean, no labels.
    assert item["status"] == "ready"
    import json
    body = json.loads(next(v for k, v in bucket.data.items() if "/materializations/" in k))
    assert body["pool_relative_labels"] is None


def test_pool_relative_labels_need_two_names():
    rows = [dict(symbol="3000", gross_return=0.01)]
    receipt = dict(status="ready", signal_date=DAY, rows_checksum="r" * 64)
    assert projection.pool_relative_labels(rows, receipt) is None
    two = [*rows, dict(symbol="3001", gross_return=0.03)]
    assert projection.pool_relative_labels(two, receipt)["pool_relative_excess"] == pytest.approx(
        {"3000": -0.01, "3001": 0.01})
    assert projection.pool_relative_labels(two, {**receipt, "coverage_blocker": "incomplete_original_l3_coverage"}) is None


def test_a_cached_projection_of_another_schema_version_still_uses_its_own_identity():
    import hashlib
    import json
    frozen, identity_a = r33_context()
    _, identity_b = r33_context(("LightGBM", "TabM", "GNN"), cohort="c2")
    bucket = _Bucket()
    symbols = projection.project_r33(frozen)["eligible_symbols"]
    _refresh(frozen, bucket, symbols, identity=identity_a)
    key = next(k for k in bucket.data if "/projections/" in k)
    index = next(k for k in bucket.data if "/projection_index/" in k)
    cached = json.loads(bucket.data[key])
    cached["feature_schema"] = "r33-forward-roster-invariant-v0"   # what a previous deploy cached
    raw = json.dumps(cached, sort_keys=True, separators=(",", ":")).encode()
    bucket.data[key] = raw
    bucket.data[index] = json.dumps(dict(path=key, sha256=hashlib.sha256(raw).hexdigest()), sort_keys=True).encode()
    item = _refresh(frozen, bucket, symbols, identity=identity_b)["items"][0]
    assert (item["status"], item["l3_identity"]) == ("ready", identity_a)


# --- Hinge period (PR #255 onwards): the serving table is a hinge curve, not step blocks. ---

HINGE_CALENDAR = [*CALENDAR, "2026-10-12"]
HINGE_CUTOFF = "2026-10-13T10:00:00+08:00"


def _matured_prices(signal_date, symbols):
    """Entry open the session after `signal_date`, exit close five sessions later (HINGE_CALENDAR)."""
    pos = HINGE_CALENDAR.index(signal_date)
    entry, exit_day = HINGE_CALENDAR[pos + 1], HINGE_CALENDAR[pos + 5]
    out = {}
    for i, s in enumerate(symbols):
        out[(entry, s)] = dict(adj_open=100.0, source_sha256="b" * 64)
        out[(exit_day, s)] = dict(adj_close=100.0 + i, source_sha256="b" * 64)
    return out


@pytest.mark.parametrize("roster", ROSTERS)
def test_hinge_period_snapshot_projects_with_the_hinge_ehat(roster):
    frozen, identity = r33_context(roster, estimator=HINGE_ESTIMATOR, n=30)
    calibration_payload = _serving_table(roster, HINGE_ESTIMATOR)
    pool = _policy(frozen)["runtime"]["r33_rank_pool"]
    assert pool["calibration_checksum"] == calibration_payload["payload_checksum"]
    # The hinge serving view carries the display edge fields; the projection must not trip on them.
    view = next(iter(_policy(frozen)["runtime"]["predictions"].values()))["ensemble_v2"]
    assert view["edge_position_semantic"] == "r33_score_in_oof_pool_distribution"
    snapshot = refresh_module.project(deepcopy(frozen))
    assert snapshot["feature_schema"] == projection.FEATURE_SCHEMA and snapshot["l3_identity"] == identity
    lineage = snapshot["r33_lineage"]
    assert lineage["calibration_checksum"] == calibration_payload["payload_checksum"]
    assert lineage["source_calibration_checksum"] == SOURCE and lineage["model_order"] == list(roster)
    rows = snapshot["feature_rows"]
    scores = [r["features"]["score"] for r in rows]
    ehat = [r["features"]["ehat"] for r in rows]
    assert ehat == pytest.approx(list(hinge_value(HINGE_CURVE, scores)))
    flat = [e for e, s in zip(ehat, scores) if s <= HINGE_CURVE["knot"]]
    rising = sorted((s, e) for e, s in zip(ehat, scores) if HINGE_CURVE["knot"] < s < HINGE_CURVE["score_cap"])
    capped = [e for e, s in zip(ehat, scores) if s >= HINGE_CURVE["score_cap"]]
    top = HINGE_CURVE["intercept"] + HINGE_CURVE["slope"] * (HINGE_CURVE["score_cap"] - HINGE_CURVE["knot"])
    assert flat and set(flat) == {HINGE_CURVE["intercept"]}     # the flat part ties, as served
    assert all(e == pytest.approx(top) for e in capped)         # no extrapolation past the cap
    if len(roster) > 1:
        # Between knot and cap E-hat is strictly increasing in the score (names tie only on a tied score).
        assert len({s for s, _ in rising}) > 1
        assert all((e2 > e1) == (s2 > s1) for (s1, e1), (s2, e2) in zip(rising, rising[1:]))
    assert all(HINGE_CURVE["intercept"] <= e <= top + 1e-12 for e in ehat)
    for row in rows:
        assert row["l3_baseline"]["calibration_checksum"] == calibration_payload["payload_checksum"]
        assert row["l3_baseline"]["expected_excess"] == row["features"]["ehat"]


def test_step_and_hinge_period_snapshots_mature_side_by_side():
    """The hinge recalibration changes the ensemble checksum, hence the L3 identity: a step-period
    snapshot and a hinge-period one each mature under their own identity and calibration."""
    step, identity_step = r33_context(signal_date="2026-10-01", snapshot_id="step")
    hinge, identity_hinge = r33_context(signal_date="2026-10-02", snapshot_id="hinge", estimator=HINGE_ESTIMATOR)
    assert identity_step != identity_hinge
    assert identity_step["cohort_id"] == identity_hinge["cohort_id"] == "c1"
    frozen = {"step": step, "hinge": hinge}
    projected = {k: projection.project_r33(deepcopy(v)) for k, v in frozen.items()}
    prices = {**_matured_prices("2026-10-01", projected["step"]["eligible_symbols"]),
              **_matured_prices("2026-10-02", projected["hinge"]["eligible_symbols"])}
    bucket = _Bucket()
    result = refresh_module.refresh(
        query=lambda *a: [step["manifest"], hinge["manifest"]], bucket=bucket, price_capture={},
        expected_identity=identity_hinge, cutoff=HINGE_CUTOFF,
        snapshot_reader=lambda sid: deepcopy(frozen[sid]),
        price_loader=lambda *a, **k: (HINGE_CALENDAR, prices, {"verified": True}))
    by = {i["snapshot_id"]: i for i in result["items"]}
    assert result["status"] == "refreshed"
    assert (by["step"]["status"], by["hinge"]["status"]) == ("ready", "ready")
    assert (by["step"]["l3_identity"], by["hinge"]["l3_identity"]) == (identity_step, identity_hinge)
    assert all(i["training_eligible"] is False and i["training_blocker"] == "pool_contract_mismatch_evaluation_only"
               for i in by.values())
    from services.l4_forward_training import load_current_registry
    bodies, registry = load_current_registry(bucket, cutoff=HINGE_CUTOFF)
    assert registry["status"] == "verified" and len(bodies) == 2
    checksums = {b["receipt"]["snapshot_id"]: {r["l3_baseline"]["calibration_checksum"] for r in b["rows"]}
                 for b in bodies}
    assert checksums == {k: {_policy(v)["runtime"]["r33_rank_pool"]["calibration_checksum"]} for k, v in frozen.items()}
    assert checksums["step"] != checksums["hinge"]
    for body in bodies:
        assert body["pool_relative_labels"]["n"] == 10
        assert sum(body["pool_relative_labels"]["pool_relative_excess"].values()) == pytest.approx(0.0, abs=1e-12)


def _step_checksum():
    return _serving_table(CORE4, ESTIMATOR)["payload_checksum"]


@pytest.mark.parametrize("tamper,error", [
    # A view priced by the step table left in a hinge-period context.
    (lambda f: _policy(f)["runtime"]["predictions"]["3000"]["ensemble_v2"].update(calibration_checksum=_step_checksum()),
     "l4_forward_r33_roster_disagreement"),
    # The bundle still names the step table while the pool was ranked with the hinge.
    (lambda f: _policy(f)["artifact"]["model"].update(calibration_checksum=_step_checksum()),
     "r33_bundle|l4_forward_r33_roster_disagreement"),
])
def test_hinge_period_calibration_disagreement_fails_closed(tamper, error):
    frozen, _ = r33_context(estimator=HINGE_ESTIMATOR)
    tamper(frozen)
    with pytest.raises(ValueError, match=error):
        projection.project_r33(frozen)
