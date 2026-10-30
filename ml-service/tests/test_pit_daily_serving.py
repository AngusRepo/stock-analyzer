"""C28-02 P2: serve PIT-trained artifacts daily next to legacy ones (A, T1, Q4, Q7)."""
import io
import json
import sys
from datetime import date, timedelta
from types import SimpleNamespace

import numpy as np
import polars as pl
import pytest

from app import batch_prediction as bp
from app import pit_contract
from tests.test_pit_lag_contract import DAYS, VERSION, _chips, _prices

LEGACY = {"feature_names": [], "feature_medians": {}}
PIT = {**LEGACY, "dataset": {"deployment_fit": {"input_scope": {"pit_contract_version": VERSION}}}}


def _request(version=None, *, history=True, symbol="2330"):
    return SimpleNamespace(prices=_prices(), indicators=[], chips=_chips(), sentiment_scores=[],
                           market_env={"per_stock_ts": {}} if history else {}, barrier_params=None,
                           stock_meta=None, market="TWSE", pit_contract_version=version, symbol=symbol,
                           runtime_options={})


def _margin(ctx):
    return ctx.feature_names.index("margin_balance")


@pytest.fixture
def builds(monkeypatch):
    calls = []
    real = bp._latest_feature_row
    monkeypatch.setattr(bp, "_latest_feature_row", lambda req, version: calls.append(version) or real(req, version))
    return calls


def test_legacy_only_serving_builds_one_view_and_reads_it_unchanged(builds):
    ctx = bp._build_feature_batch_context(_request())
    assert bp._align_latest_features(ctx, LEGACY) is ctx.x_latest
    assert builds == [None] and ctx.pit_views == {}
    assert bp._pit_serving_metrics([ctx]) == {}


def test_a_mixed_bundle_serves_each_artifact_its_own_lags_and_builds_each_view_once(builds):
    ctx = bp._build_feature_batch_context(_request())
    lagged = bp._build_feature_batch_context(_request(VERSION))
    builds.clear()
    for _ in range(3):
        np.testing.assert_array_equal(bp._align_latest_features(ctx, PIT), lagged.x_latest)
        assert bp._align_latest_features(ctx, LEGACY) is ctx.x_latest
    assert builds == [VERSION]
    column = _margin(ctx)
    assert ctx.x_latest[0, column] == 1000.0 + len(DAYS) - 1
    assert ctx.pit_views[VERSION][0][0, column] == 1000.0 + len(DAYS) - 2


@pytest.mark.parametrize("meta, reason", [
    ({**LEGACY, "input_scope": {"pit_contract_version": "pit-availability-contract-v0"}},
     "pit_feature_view_failed:pit-availability-contract-v0:ValueError:pit_contract_version_unknown"),
    ({**LEGACY, "a": {"pit_contract_version": VERSION}, "b": [{"pit_contract_version": "v0"}]},
     "pit_contract_version_ambiguous"),
])
def test_unknown_or_ambiguous_versions_fail_only_that_artifact(meta, reason):
    good = SimpleNamespace(predict=lambda x: np.full(len(x), 0.5))
    ctx = bp._build_feature_batch_context(_request())
    bp._apply_artifact_batch_predictions([ctx], "LightGBM", good, meta)
    bp._apply_artifact_batch_predictions([ctx], "ExtraTrees", good, LEGACY)
    assert ctx.rank_scores == {"ExtraTrees": 0.5}
    assert len(ctx.model_errors) == 1 and ctx.model_errors[0].startswith("LightGBM: " + reason)


def test_missing_lagged_history_fails_the_pit_artifact_for_that_stock_only(builds):
    model = SimpleNamespace(predict=lambda x: np.full(len(x), 0.25))
    ok, bare = bp._build_feature_batch_context(_request()), bp._build_feature_batch_context(_request(history=False))
    for name in ("LightGBM", "XGBoost"):
        bp._apply_artifact_batch_predictions([ok, bare], name, model, PIT)
    bp._apply_artifact_batch_predictions([ok, bare], "ResidualMLP", model, LEGACY, challenger=True)
    assert ok.rank_scores == {"LightGBM": 0.25, "XGBoost": 0.25} and not ok.model_errors
    assert bare.rank_scores == {} and all("pit_lagged_history_missing" in e for e in bare.model_errors)
    assert bare.challenger_rank_scores == {"ResidualMLP": 0.25}
    # The failed view is cached: the second PIT model did not rebuild it.
    assert builds.count(VERSION) == 2


def test_a_request_that_names_a_version_keeps_the_strict_phase1_rule(builds):
    ctx = bp._build_feature_batch_context(_request(VERSION))
    with pytest.raises(ValueError, match="pit_contract_version_serving_mismatch"):
        bp._align_latest_features(ctx, LEGACY)
    assert builds == [VERSION] and ctx.pit_views == {}


def test_tabm_and_gnn_batches_read_the_view_of_their_artifact(monkeypatch):
    seen = {}

    def tabm_scores(artifact, features):
        seen["TabM"] = features
        return [0.4] * len(features)

    def gnn_scores(artifact, node_features, **_):
        seen["GNN"] = node_features
        return [0.6] * len(node_features), {}
    monkeypatch.setitem(sys.modules, "app.tabm_batch_runtime", SimpleNamespace(
        load_tabm_artifact=lambda pool: SimpleNamespace(metadata=PIT), predict_tabm_scores=tabm_scores))
    monkeypatch.setitem(sys.modules, "app.gnn_batch_runtime", SimpleNamespace(
        load_graphsage_artifact=lambda pool: SimpleNamespace(metadata=LEGACY), predict_graphsage_scores=gnn_scores))
    monkeypatch.setattr(bp, "_require_runtime_artifact_identity", lambda *a: None)
    ctx = bp._build_feature_batch_context(_request())
    bp._apply_tabm_torch_batch_predictions([ctx], {}, {"TabM": "active"})
    bp._apply_gnn_batch_context_predictions([ctx], {}, {"GNN": "active"})
    assert ctx.rank_scores == {"TabM": 0.4, "GNN": 0.6}, ctx.model_errors
    column = _margin(ctx)
    assert seen["TabM"][0, column] == 1000.0 + len(DAYS) - 2
    assert seen["GNN"][0, column] == 1000.0 + len(DAYS) - 1


@pytest.mark.parametrize("metadata", [LEGACY, PIT])
def test_gnn_metrics_report_pit_serving_only_for_a_pit_artifact(monkeypatch, metadata):
    monkeypatch.setitem(sys.modules, "app.gnn_batch_runtime", SimpleNamespace(
        load_graphsage_artifact=lambda pool: SimpleNamespace(metadata=metadata),
        predict_graphsage_scores=lambda artifact, node_features, **_: ([0.6] * len(node_features), {})))
    monkeypatch.setattr(bp, "_require_runtime_artifact_identity", lambda *a: None)
    monkeypatch.setattr(bp, "_runtime", lambda: (lambda **kw: _request(), None))
    monkeypatch.setattr(bp, "_model_pool_status", lambda pool: {"GNN": "active"})
    result = bp.predict_gnn_graphsage_batch([{}], pool_snapshot={"models": {"GNN": {"status": "active"}}})
    assert result["n_success"] == 1, result
    if metadata is LEGACY:
        assert "pit_serving" not in result["metrics"]
    else:
        assert result["metrics"]["pit_serving"]["feature_views"][VERSION]["built"] == 1


@pytest.mark.parametrize("day, quarter", [
    ("2026-01-02", "2025-Q3"), ("2026-03-30", "2025-Q3"), ("2026-03-31", "2025-Q4"),
    ("2026-05-14", "2025-Q4"), ("2026-05-15", "2026-Q1"), ("2026-08-14", "2026-Q2"),
    ("2026-11-13", "2026-Q2"), ("2026-11-14", "2026-Q3"), ("2026-12-31", "2026-Q3")])
def test_reported_quarter_follows_the_statutory_deadlines(day, quarter):
    assert pit_contract.reported_quarter(day) == quarter


def test_q4_metric_counts_pit_served_stocks_whose_current_quarter_is_masked():
    cells = pit_contract.revision_mask_cells(VERSION, "eps")
    assert ("2327", "2026-Q2") in cells and ("2330", "2026-Q2") not in cells
    view = (np.zeros((1, 1)), ["f"])

    def ctx(symbol, day, views):
        return bp._FeatureBatchContext(req=SimpleNamespace(symbol=symbol, prices=[{"date": day}]),
                                       x_latest=np.zeros((1, 1)), feature_names=["f"], pit_views=views)
    metrics = bp._pit_serving_metrics([
        ctx("2327", "2026-10-05", {VERSION: view}), ctx("2327.TW", "2026-10-06", {VERSION: view}),
        ctx("2327", "2026-11-16", {VERSION: view}), ctx("2330", "2026-10-05", {VERSION: view}),
        ctx("2327", "2026-10-05", {VERSION: "pit_feature_view_failed:x"}), ctx("2327", "2026-10-05", {})])
    assert metrics == {"feature_views": {VERSION: {
        "built": 4, "failed": 1, "eps_revision_mask_current_quarter_stocks": 2}}}


def test_the_mask_is_read_only_at_the_contract_pinned_sha(monkeypatch, tmp_path):
    original = pit_contract._registry_file("pit_eps_revision_mask_v1.json")
    changed = tmp_path / "pit_eps_revision_mask_v1.json"
    changed.write_bytes(original.read_bytes().replace(b'"2327"', b'"9999"'))
    real = pit_contract._registry_file
    monkeypatch.setattr(pit_contract, "_registry_file",
                        lambda name: changed if name == changed.name else real(name))
    pit_contract.revision_mask_cells.cache_clear()
    try:
        with pytest.raises(ValueError, match="pit_revision_mask_changed"):
            pit_contract.revision_mask_cells(VERSION, "eps")
    finally:
        pit_contract.revision_mask_cells.cache_clear()


def test_with_metrics_reports_pit_serving_only_when_a_pit_view_was_used(monkeypatch):
    def fake_batch(payloads, pool_snapshot=None):
        ctx = bp._build_feature_batch_context(_request())
        if payloads:
            bp._align_latest_features(ctx, PIT)
        bp._record_pit_views([ctx])
        return []
    monkeypatch.setattr(bp, "preload_batch_artifacts", lambda payloads, pool_snapshot=None: {})
    monkeypatch.setattr(bp, "predict_stock_v2_batch", fake_batch)
    assert "pit_serving" not in bp.predict_stock_v2_batch_with_metrics([], pool_snapshot={})["metrics"]
    metrics = bp.predict_stock_v2_batch_with_metrics([{}], pool_snapshot={})["metrics"]
    assert metrics["pit_serving"]["feature_views"][VERSION]["built"] == 1
    assert bp._PIT_SERVING_TELEMETRY.get() is None


# --- T1: PIT variants of the daily feature-only prep -------------------------------------

class MemoryBucket:
    def __init__(self):
        self.files = {}

    def blob(self, name):
        bucket = self

        class Blob:
            def upload_from_file(self, stream, **kwargs):
                bucket.files[name] = stream.read()

            def upload_from_string(self, value, **kwargs):
                bucket.files[name] = value
        return Blob()


PREFIX = "universal/oof_forward_prep_v2/2026-10-05-x"
SHA = pit_contract.content_sha256(pit_contract.load(VERSION))
SPEC = {"gcs_prefix": PREFIX + "-pit-" + VERSION, "pit_contract_version": VERSION, "pit_contract_sha256": SHA}


def _prep_request(**overrides):
    from app.universal_training import UniversalPrepRequest
    dates = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(65)]
    payload = {"symbol": "TEST", "stock_id": 1, "market": "OTHER",
               "prices": [{"date": day, "open": 100.0, "close": 100.0} for day in dates]}
    values = dict(payloads=[payload], gcs_prefix=PREFIX, retain_unlabeled_features=True,
                  per_stock_ts_map={"1": {}}, pit_variants=[SPEC])
    return UniversalPrepRequest(**{**values, **overrides})


@pytest.fixture
def prep_env(monkeypatch):
    from app import features, universal_training
    bucket = MemoryBucket()
    dates = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(65)]
    monkeypatch.setattr(universal_training, "_get_bucket", lambda: bucket)
    monkeypatch.setattr(features, "FEATURE_COLS", ["return_1d"])
    monkeypatch.setattr(features, "TIMESFM_L175_FEATURE_COLS", [])
    # The lag reaches the feature layer as the version argument; give it a visible value.
    monkeypatch.setattr(features, "build_feature_matrix", lambda *a, **k: pl.DataFrame({
        "date": dates, "return_1d": [2.0 if k.get("pit_contract_version") else 1.0] * 65,
        "target_5d": [0.01] * 60 + [None] * 5}))
    return bucket


def _saved(bucket, prefix):
    with np.load(io.BytesIO(bucket.files[f"{prefix}/prep/batch_0.npz"]), allow_pickle=True) as saved:
        return {key: saved[key].copy() for key in ("X", "dates", "symbols")}


def test_variants_reproduce_standalone_preps_and_leave_the_legacy_batch_unchanged(prep_env):
    from app.universal_training import prep_universal_batch, prep_universal_batch_with_variants
    result = prep_universal_batch_with_variants(_prep_request())
    combined = {p: _saved(prep_env, p) for p in (PREFIX, SPEC["gcs_prefix"])}
    names = prep_env.files[f"{PREFIX}/prep/feature_names.json"]
    assert prep_env.files[f"{SPEC['gcs_prefix']}/prep/feature_names.json"] == names
    assert result["pit_variants"] == {SPEC["gcs_prefix"]: {
        "rows": 65, "pit_contract_version": VERSION, "pit_contract_sha256": SHA}}
    prep_env.files.clear()
    legacy = prep_universal_batch(_prep_request(pit_variants=[]))
    assert {k: v for k, v in result.items() if k not in ("pit_variants", "elapsed_s")} == \
        {k: v for k, v in legacy.items() if k != "elapsed_s"}
    standalone = prep_universal_batch(_prep_request(pit_variants=[], gcs_prefix=SPEC["gcs_prefix"],
                                                    pit_contract_version=VERSION, pit_contract_sha256=SHA))
    assert standalone["cleaning_report"]["pit_contract_version"] == VERSION
    for prefix in (PREFIX, SPEC["gcs_prefix"]):
        for key, value in _saved(prep_env, prefix).items():
            np.testing.assert_array_equal(combined[prefix][key], value)
    assert combined[PREFIX]["X"][0, 0] == 1.0 and combined[SPEC["gcs_prefix"]]["X"][0, 0] == 2.0


def test_without_variants_the_wrapper_is_the_legacy_call(monkeypatch):
    from app import universal_training
    sentinel = {"rows": 1}
    calls = []
    monkeypatch.setattr(universal_training, "prep_universal_batch", lambda req: calls.append(req) or sentinel)
    request = _prep_request(pit_variants=[])
    assert universal_training.prep_universal_batch_with_variants(request) is sentinel and calls == [request]


@pytest.mark.parametrize("overrides, deadline, reason", [
    ({"per_stock_ts_map": {}}, None, "daily_prep_pit_history_missing"),
    ({"pit_variants": [{**SPEC, "gcs_prefix": PREFIX}]}, None, "pit_variant_spec_invalid"),
    ({"pit_variants": [{**SPEC, "gcs_prefix": "elsewhere/x"}]}, None, "pit_variant_spec_invalid"),
    ({"pit_variants": [{**SPEC, "pit_contract_version": None}]}, None, "pit_variant_spec_invalid"),
    ({"pit_variants": [{**SPEC, "pit_contract_sha256": "0" * 64}]}, None, "pit_contract_sha256_mismatch"),
    ({}, -1.0, "pit_variant_time_budget_exceeded"),
])
def test_a_failing_variant_never_touches_the_legacy_batch(prep_env, overrides, deadline, reason):
    import time
    from app.universal_training import prep_universal_batch_with_variants
    result = prep_universal_batch_with_variants(
        _prep_request(**overrides), deadline=None if deadline is None else time.monotonic() + deadline)
    assert result["rows"] == 65 and not result.get("error")
    assert _saved(prep_env, PREFIX)["X"][0, 0] == 1.0
    (variant,) = result["pit_variants"].values()
    assert reason in variant["error"]
    assert not any(name.startswith(PREFIX + "-pit-") and name.endswith(".npz") for name in prep_env.files)


def test_a_failed_legacy_batch_runs_no_variant(monkeypatch):
    from app import universal_training
    calls = []
    monkeypatch.setattr(universal_training, "prep_universal_batch",
                        lambda req: calls.append(req.gcs_prefix) or {"error": "no valid stocks"})
    assert universal_training.prep_universal_batch_with_variants(_prep_request()) == {"error": "no valid stocks"}
    assert calls == [PREFIX]


# --- T1: TimeXer reads only its own version's daily source -------------------------------

def test_timexer_request_carries_pit_sources_only_when_present():
    source = (open(__file__.replace("tests/test_pit_daily_serving.py", "modal_app.py")).read())
    start = source.index("    def _timexer_predict(**kwargs):")
    block = source[start:source.index("    def _timexer() -> dict:", start)]
    assert 'if payload.get("timexer_pit_feature_sources"):' in block
    assert 'gpu_input["pit_feature_sources"] = payload["timexer_pit_feature_sources"]' in block


def test_both_prep_functions_bound_pit_variants_by_their_own_timeout():
    source = (open(__file__.replace("tests/test_pit_daily_serving.py", "modal_app.py")).read())
    sync = source[source.index("def prep_universal_batch(payload: dict)"):source.index("def prep_universal_batch_event(")]
    event = source[source.index("def prep_universal_batch_event("):]
    event = event[:event.index("\n\n\n")]
    assert "deadline = time.monotonic() + 600 * 0.9" in sync and "_prep(req, deadline=deadline)" in sync
    assert "deadline = time.monotonic() + 1900 * 0.9" in event and "deadline=deadline)" in event
    assert "timeout=1900" in source[source.rindex("@app.function", 0, source.index("def prep_universal_batch_event(")):
                                    source.index("def prep_universal_batch_event(")]


# --- Q7: NeuralForecast PatchTST/iTransformer see price-only frames ----------------------

def test_neuralforecast_train_and_serve_frames_hold_only_unique_id_ds_y(monkeypatch):
    pd = pytest.importorskip("pandas")
    from app import neuralforecast_sequence_runtime as nf_runtime
    frames = []

    class FakeNF:
        def __init__(self, models, freq):
            self.models = models

        def fit(self, df):
            frames.append(("fit", set(df.columns)))

        def predict(self, df):
            frames.append(("predict", set(df.columns)))
            last = df.groupby("unique_id").tail(1)
            return pd.DataFrame({"unique_id": last["unique_id"], "ds": last["ds"] + 1,
                                 "PatchTST": [1.0] * len(last)}).set_index("unique_id")

    monkeypatch.setitem(sys.modules, "neuralforecast", SimpleNamespace(NeuralForecast=FakeNF))
    monkeypatch.setattr(nf_runtime, "_configure_neuralforecast_runtime", lambda: None)
    monkeypatch.setattr(nf_runtime, "_make_nf_model", lambda *a, **k: SimpleNamespace())
    # Feature columns next to the prices must never reach NeuralForecast.
    records = [{"symbol": s, "close": [100.0 + i for i in range(40)], "open": [100.0] * 40,
                "dates": [f"d{i:02d}" for i in range(40)], "margin_balance": [1.0] * 40,
                "eps": [2.0] * 40, "features": {"margin_balance": 1.0}} for s in ("A", "B")]
    train_rows, _eval, _ = nf_runtime._panel_train_eval_rows(records, seq_len=20, pred_len=5, max_series=10)
    full_rows, _ = nf_runtime._panel_full_train_rows(records, seq_len=20, pred_len=5, max_series=10)
    for rows in (train_rows, full_rows):
        nf_runtime._train_nf(rows, model_name="PatchTST", pred_len=5, seq_len=20, max_steps=1,
                             batch_size=1, seed=0, n_series=2, training_options={})
    monkeypatch.setattr(nf_runtime, "load_neuralforecast_artifact",
                        lambda *a, **k: (FakeNF([], 1), {"seq_len": 20, "pred_len": 5}))
    served = nf_runtime.neuralforecast_batch_predict(model_name="PatchTST", series_list=records)
    assert served and all(not row.get("error") for row in served)
    assert frames == [("fit", {"unique_id", "ds", "y"})] * 2 + [("predict", {"unique_id", "ds", "y"})]
