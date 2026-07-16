import json
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))


def _native_rows(count=20):
    return [
        {
            "symbol": f"S{idx:04d}",
            "prediction_date": "2026-07-15",
            "forecast_data": json.dumps({"ensemble_v2": {"avg_rank": 0.6}}),
            "score_components": json.dumps({"version": "score_v2"}),
            "alpha_context": json.dumps({"market_heat_expected_return": 0.001}),
            "alpha_allocation": json.dumps({"s12_trade_ev": {"expected_return": 0.002}}),
        }
        for idx in range(count)
    ]


def _patch_materializers(monkeypatch, parity_module, *, serving_value=1.0):
    monkeypatch.setattr(parity_module, "FEATURE_NAMES", ("feature_a",))
    monkeypatch.setattr(parity_module, "_feature_vector", lambda row: {"feature_a": 1.0})
    monkeypatch.setattr(
        parity_module,
        "_feature_value",
        lambda name, row, prediction: serving_value,
    )
    monkeypatch.setattr(
        parity_module,
        "materialize_l4_alpha_ev",
        lambda *args, **kwargs: {"status": "loaded", "expected_return": 0.01},
    )
    monkeypatch.setattr(
        parity_module,
        "extract_l4_alpha_ev",
        lambda row: (0.01, "artifact", {"status": "loaded"}),
    )
    monkeypatch.setattr(
        parity_module,
        "extract_s12_trade_ev",
        lambda row: (0.002, "direct", {"status": "loaded"}),
    )
    monkeypatch.setattr(
        parity_module,
        "materialize_allocator_ev_fusion",
        lambda *args, **kwargs: {"status": "loaded", "expected_return": 0.008},
    )


def test_operational_parity_passes_without_future_labels(monkeypatch):
    from services import ev_operational_parity as parity

    _patch_materializers(monkeypatch, parity)
    result = parity.assess_ev_operational_parity(
        l4_artifact={"model_version": "l4-oof"},
        fusion_artifact={"model_version": "fusion-oof"},
        native_rows=_native_rows(),
    )

    assert result["decision"] == "PASS"
    assert result["labels_required"] is False
    assert result["comparable_rows"] == 20
    assert result["l4_serving_coverage"] == 1.0
    assert result["fusion_serving_coverage"] == 1.0


def test_operational_parity_rejects_training_serving_feature_drift(monkeypatch):
    from services import ev_operational_parity as parity

    _patch_materializers(monkeypatch, parity, serving_value=2.0)
    result = parity.assess_ev_operational_parity(
        l4_artifact={"model_version": "l4-oof"},
        fusion_artifact={"model_version": "fusion-oof"},
        native_rows=_native_rows(),
    )

    assert result["decision"] == "FAIL"
    assert "training_serving_feature_mismatch" in result["failed_gates"]
    assert result["feature_mismatch_count"] == 20
