"""R33: one symbol's row error or missing model rank is that symbol's coverage, not the day's failure
(spec §3.2 "不計分列不中止當天", HL2-1b). Structural closure stays fail-closed."""
import pytest

import test_pipeline_modal_prediction_callback_fail_closed as fx
from graphs import daily_pipeline_v2 as pipeline


@pytest.fixture
def r33(monkeypatch):
    original = fx._manifest
    monkeypatch.setattr(fx, "_manifest", lambda: {**original(), "active8_ensemble": {"kind": "r33_equal7_isotonic"}})


def test_r33_tolerates_row_errors_and_missing_model_ranks(r33):
    bundle = fx._bundle()
    bundle["predict_batch_v2_results"][0] = {"symbol": "2330", "error": "feature_context_failed:ValueError:bad"}
    bundle["predict_batch_v2_results"][1]["rank_scores"].pop("ExtraTrees")
    bundle["dlinear_raw"]["results"][1] = {"symbol": "2317", "error": "nan forecast"}
    report = pipeline._validate_pipeline_modal_feature_bundle_before_writes(fx._state(), bundle)
    assert report["row_errors"] == {"2330": "feature_context_failed:ValueError:bad"}
    assert report["missing_active_feature_ranks"] == {"2317": ["ExtraTrees"]}
    assert report["r33_unscored_not_blocking"] is True
    assert report["runtime_model_closure"]["DLinear"]["row_errors"] == {"2317": "nan forecast"}


@pytest.mark.parametrize(("mutate", "marker"), [
    (lambda b: b["predict_batch_v2_results"].pop(), "cardinality_mismatch"),
    (lambda b: b["predict_batch_v2_results"].append(fx._feature_row("2330")), "duplicate_symbols"),
    (lambda b: b["predict_batch_v2_results"].__setitem__(1, fx._feature_row("9999")), "unexpected_symbols"),
    (lambda b: b["dlinear_raw"]["results"].pop(), "pipeline_modal_dlinear_closure_failed"),
])
def test_r33_keeps_structural_closure_fail_closed(r33, mutate, marker):
    bundle = fx._bundle()
    mutate(bundle)
    with pytest.raises(RuntimeError, match=marker):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(fx._state(), bundle)


def test_non_r33_still_fails_on_one_row_error():
    bundle = fx._bundle()
    bundle["predict_batch_v2_results"][0] = {"symbol": "2330", "error": "boom"}
    with pytest.raises(RuntimeError, match="row_errors"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(fx._state(), bundle)


def test_non_r33_still_fails_on_one_runtime_model_row_error_with_full_cardinality():
    bundle = fx._bundle()
    bundle["dlinear_raw"]["results"][1] = {"symbol": "2317", "error": "nan forecast"}
    with pytest.raises(RuntimeError, match="pipeline_modal_dlinear_closure_failed.*nan forecast"):
        pipeline._validate_pipeline_modal_feature_bundle_before_writes(fx._state(), bundle)
