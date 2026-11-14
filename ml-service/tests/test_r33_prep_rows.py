"""R33-NEW-11: under R33 the feature models read the sealed prep row (train = serve)."""
import hashlib
import io
import json

import numpy as np
import pytest

from app import batch_prediction, r33_prep_rows
from app.features import FEATURE_COLS

DAY = "2026-10-05"


class Bucket:
    def __init__(self, objects):
        self.objects = objects

    def blob(self, path):
        objects = self.objects

        class Blob:
            def download_as_bytes(self):
                return objects[path]
        return Blob()


def _source(objects, *, tag="base", rows=(("2330", DAY, 1.0), ("2317", DAY, 2.0), ("2330", "2026-10-02", 9.0)),
            pit_version=None, width=None):
    prefix = f"universal/oof_forward_prep_v2/{DAY}-{tag}"
    shard_path, names_path = f"{prefix}/prep/batch_0.npz", f"{prefix}/prep/feature_names.json"
    shard = io.BytesIO()
    np.savez_compressed(shard, symbols=np.array([r[0] for r in rows]), dates=np.array([r[1] for r in rows]),
                        X=np.stack([np.full(width or len(FEATURE_COLS), r[2], dtype=np.float32) for r in rows]))
    names = json.dumps(list(FEATURE_COLS)).encode()
    receipt = {"business_date": DAY, "output_gcs_prefix": prefix, "status": "ready", "training_dispatched": False,
               "feature_semantic_version": "formal137-pit-asof-source-quality-v3",
               "feature_imputation_semantic": "prior_252_row_median_then_zero_v2", "batch_count": 1,
               "feature_names_path": names_path,
               "output_checksums": {shard_path: hashlib.sha256(shard.getvalue()).hexdigest(),
                                    names_path: hashlib.sha256(names).hexdigest()},
               **({"pit_contract_version": pit_version} if pit_version else {})}
    receipt["receipt_checksum"] = hashlib.sha256(json.dumps(receipt, sort_keys=True).encode()).hexdigest()
    objects.update({f"{prefix}/prep/immutable_receipt.json": json.dumps(receipt).encode(),
                    shard_path: shard.getvalue(), names_path: names})
    return {"schema_version": "timexer-feature-source-v1", "signal_date": DAY, "status": "ready",
            "training_dispatched": False, "source_gcs_prefix": prefix,
            "source_receipt_checksum": receipt["receipt_checksum"]}


def test_view_reads_only_signal_date_rows_for_the_requested_symbols():
    objects = {}
    view = r33_prep_rows.load_view(Bucket(objects), _source(objects), signal_date=DAY, symbols=["2330", "9999"])
    assert set(view["rows"]) == {"2330"} and view["names"] == list(FEATURE_COLS)
    assert view["rows"]["2330"].shape == (1, len(FEATURE_COLS)) and float(view["rows"]["2330"][0, 0]) == 1.0


def test_tampered_shard_and_duplicate_rows_fail_the_view():
    objects = {}
    source = _source(objects)
    shard = next(k for k in objects if k.endswith(".npz"))
    objects[shard] = objects[shard] + b"x"
    with pytest.raises(ValueError, match="r33_prep_shard_checksum_mismatch"):
        r33_prep_rows.load_view(Bucket(objects), source, signal_date=DAY, symbols=["2330"])
    objects = {}
    source = _source(objects, rows=(("2330", DAY, 1.0), ("2330", DAY, 2.0)))
    with pytest.raises(ValueError, match="r33_prep_duplicate_row:2330"):
        r33_prep_rows.load_view(Bucket(objects), source, signal_date=DAY, symbols=["2330"])


def test_a_failed_pit_view_is_that_version_only_and_the_base_must_load():
    objects = {}
    base, pit = _source(objects), _source(objects, tag="pit", pit_version="pit-v1")
    views = r33_prep_rows.load_views(Bucket(objects), {"base": base, "pit": {"pit-v1": pit, "pit-v2": pit}},
                                     signal_date=DAY, symbols=["2330"])
    assert set(views[None]["rows"]) == {"2330"} and set(views["pit-v1"]["rows"]) == {"2330"}
    assert views["pit-v2"].startswith("r33_prep_view_failed:pit-v2:ValueError:pit_contract_version_serving_mismatch")
    with pytest.raises(ValueError, match="r33_prep_source_missing"):
        r33_prep_rows.load_views(Bucket(objects), {"pit": {}}, signal_date=DAY, symbols=["2330"])
    with pytest.raises(ValueError, match="r33_prep_base_source_not_legacy"):
        r33_prep_rows.load_views(Bucket(objects), {"base": pit}, signal_date=DAY, symbols=["2330"])


def _views():
    objects = {}
    return r33_prep_rows.load_views(Bucket(objects), {"base": _source(objects)}, signal_date=DAY,
                                    symbols=["2330", "2317"])


def _request(symbol):
    from types import SimpleNamespace
    return SimpleNamespace(symbol=symbol, pit_contract_version=None)


def test_context_comes_from_the_prep_row_and_never_from_a_rebuild(monkeypatch):
    monkeypatch.setattr(batch_prediction, "_latest_feature_row", lambda *a: pytest.fail("per-stock rebuild"))
    token = r33_prep_rows.PREP_VIEWS.set(_views())
    try:
        ctx = batch_prediction._build_feature_batch_context(_request("2317"))
        assert ctx.prep_only and float(ctx.x_latest[0, 0]) == 2.0 and ctx.feature_names == list(FEATURE_COLS)
        with pytest.raises(ValueError, match="r33_prep_source_missing:pit-v9"):
            batch_prediction._feature_view(ctx, "pit-v9")
        with pytest.raises(ValueError, match="r33_prep_row_missing:None"):
            batch_prediction._build_feature_batch_context(_request("9999"))
    finally:
        r33_prep_rows.PREP_VIEWS.reset(token)


def test_without_r33_the_context_is_built_per_stock_as_before(monkeypatch):
    calls = []
    monkeypatch.setattr(batch_prediction, "_latest_feature_row",
                        lambda req, version: calls.append(version) or (np.zeros((1, 2)), ["a", "b"]))
    ctx = batch_prediction._build_feature_batch_context(_request("2330"))
    assert calls == [None] and not ctx.prep_only and ctx.feature_names == ["a", "b"]


def test_feature_model_scores_the_prep_row_and_a_missing_symbol_is_its_own_error(monkeypatch):
    from test_l3_serving_robustness import _Model, _requests, _setup
    from app.prediction_runtime import _BATCH_FEATURE_RANK_SCORES_KEY
    model = _Model([0.7])
    _setup(monkeypatch, model, {"feature_names": [], "feature_medians": {}})
    monkeypatch.setattr(batch_prediction, "_latest_feature_row", lambda *a: pytest.fail("per-stock rebuild"))
    token = r33_prep_rows.PREP_VIEWS.set(_views())
    try:
        overrides = batch_prediction._build_feature_model_batch_runtime_overrides(_requests("2330", "4904"))
    finally:
        r33_prep_rows.PREP_VIEWS.reset(token)
    assert overrides[0][_BATCH_FEATURE_RANK_SCORES_KEY]["XGBoost"] == pytest.approx(0.7)
    assert model.calls == [(1, len(FEATURE_COLS))]
    assert batch_prediction._feature_core_coverage_error(overrides[1]) == \
        "feature_context_failed:ValueError:r33_prep_row_missing:None"


def test_stage_runner_loads_once_for_both_stages_and_a_failed_load_fails_both():
    objects, opened = {}, []
    payload = {"run_date": DAY, "r33_feature_prep_sources": {"base": _source(objects)}}
    pool = {"active8_ensemble": {"kind": "r33_roster_isotonic"}}
    run = r33_prep_rows.stage_runner(pool, payload, [{"symbol": "2330"}, {"symbol": None}, "x"],
                                     bucket_factory=lambda: opened.append(1) or Bucket(objects))
    assert set(run(lambda: r33_prep_rows.PREP_VIEWS.get())[None]["rows"]) == {"2330"}
    assert run(lambda: r33_prep_rows.PREP_VIEWS.get()) is not None and opened == [1]
    assert r33_prep_rows.PREP_VIEWS.get() is None
    broken = r33_prep_rows.stage_runner(pool, {"run_date": DAY}, [], bucket_factory=lambda: opened.append(2))
    for _ in range(2):
        with pytest.raises(ValueError, match="r33_prep_source_missing"):
            broken(lambda: pytest.fail("stage ran without its rows"))
    assert opened == [1, 2]


def test_stage_runner_outside_r33_reads_nothing():
    run = r33_prep_rows.stage_runner({"active8_ensemble": {"kind": "other"}}, {}, [],
                                     bucket_factory=lambda: pytest.fail("bucket"))
    assert run(lambda: r33_prep_rows.PREP_VIEWS.get()) is None
    run = r33_prep_rows.stage_runner({}, {}, [], bucket_factory=lambda: pytest.fail("bucket"))
    assert run(lambda: "ok") == "ok"


# ---- B-1: the Modal bundle keeps a symbol's error as that symbol's coverage under R33 ----
def _rows():
    return [{"symbol": "A", "rank_scores": {"LightGBM": 0.5, "TabM": 0.4}},
            {"symbol": "B", "error": "feature_context_failed:ValueError:r33_prep_row_missing:None"},
            {"symbol": "C", "rank_scores": {"LightGBM": 0.5, "TabM": float("nan")}}]


def test_bundle_rows_under_r33_keep_row_errors_and_missing_ranks_but_not_structure():
    import modal_app
    check = lambda rows, **kw: modal_app._assert_pipeline_bundle_rows(
        "feature", rows, expected=["A", "B", "C"], feature_models=["LightGBM", "TabM"], require_rank=True, **kw)
    check(_rows(), r33=True)
    with pytest.raises(ValueError, match="pipeline_modal_feature_row_error:B"):
        check(_rows(), r33=False)
    with pytest.raises(ValueError, match="pipeline_modal_feature_rank_missing:C:TabM"):
        check([r for r in _rows() if r["symbol"] != "B"] + [{"symbol": "B", "rank_scores": {"LightGBM": 1, "TabM": 1}}],
              r33=False)
    for expected in ([], ["A", "A", "C"]):
        with pytest.raises(ValueError, match="pipeline_modal_feature_expected_symbol_contract_invalid"):
            modal_app._assert_pipeline_bundle_rows("feature", _rows(), expected=expected, feature_models=["LightGBM"],
                                                   require_rank=True, r33=True)
    for broken, reason in ((_rows()[:2], "cardinality_mismatch"), (_rows() + [_rows()[0]], "cardinality_mismatch"),
                           ([*_rows()[:2], {"symbol": "Z"}], "cardinality_mismatch"),
                           ([*_rows()[:2], {"error": "x"}], "row_error:<missing>"),
                           ([*_rows()[:2], "C"], "row_invalid"), ({"results": []}, "results_not_list")):
        with pytest.raises(ValueError, match=reason):
            check(broken, r33=True)


def test_feature_and_gnn_stages_refuse_an_r33_pool_without_prep_views(monkeypatch):
    pool = {"active8_ensemble": {"kind": "r33_roster_isotonic"}}
    monkeypatch.setattr(batch_prediction, "predict_stock_v2_batch_with_metrics",
                        lambda *a, **k: pytest.fail("rebuilt per stock"))
    with pytest.raises(ValueError, match="r33_prep_views_not_bound"):
        batch_prediction.predict_stock_v2_chunked_with_metrics([{"symbol": "2330"}], chunk_size=1, pool_snapshot=pool)
    with pytest.raises(ValueError, match="r33_prep_views_not_bound"):
        batch_prediction.predict_gnn_graphsage_batch([{"symbol": "2330"}], pool_snapshot=pool)
    with pytest.raises(ValueError, match="r33_prep_views_not_bound"):
        batch_prediction._build_feature_model_batch_runtime_overrides([], pool_snapshot=pool)
    r33_prep_rows.require_bound({"active8_ensemble": {"kind": "other"}})
    r33_prep_rows.require_bound(None)
    token = r33_prep_rows.PREP_VIEWS.set({})
    try:
        r33_prep_rows.require_bound(pool)
    finally:
        r33_prep_rows.PREP_VIEWS.reset(token)


def test_modal_bundle_runs_the_feature_and_gnn_stages_inside_the_prep_views():
    import inspect
    import modal_app
    source = inspect.getsource(modal_app._compute_pipeline_prediction_bundle)
    assert "_with_r33_prep = stage_runner(frozen_pool, payload, payloads, bucket_factory=_get_bucket)" in source
    assert "return _with_r33_prep(_feature_rows)" in source
    assert "return _with_r33_prep(lambda: predict_gnn_graphsage_batch(payloads, pool_snapshot=frozen_pool))" in source
    assert "feature_models=feature_models, require_rank=require_rank, r33=r33_bundle" in source
    assert 'r33_bundle = (frozen_pool.get("active8_ensemble") or {}).get("kind") == R33_KIND' in source
    from app.active8_ensemble_runtime import R33_KIND
    assert R33_KIND == "r33_roster_isotonic"


def test_view_width_and_dtype_and_a_pit_request_serves_only_its_own_version():
    objects = {}
    source = _source(objects, width=len(FEATURE_COLS) - 1)
    with pytest.raises(ValueError, match="r33_prep_width_invalid"):
        r33_prep_rows.load_view(Bucket(objects), source, signal_date=DAY, symbols=["2330"])
    objects = {}
    pit = _source(objects, tag="pit", pit_version="pit-v1")
    views = r33_prep_rows.load_views(Bucket(objects), {"base": _source(objects), "pit": {"pit-v1": pit}},
                                     signal_date=DAY, symbols=["2330"])
    assert views[None]["rows"]["2330"].dtype == np.float64
    from types import SimpleNamespace
    token = r33_prep_rows.PREP_VIEWS.set(views)
    try:
        ctx = batch_prediction._build_feature_batch_context(SimpleNamespace(symbol="2330", pit_contract_version="pit-v1"))
        assert not ctx.serve_artifact_versions and ctx.pit_contract_version == "pit-v1"
        with pytest.raises(ValueError, match="pit_contract_version_serving_mismatch"):
            batch_prediction._feature_view(ctx, None)
    finally:
        r33_prep_rows.PREP_VIEWS.reset(token)
