from pathlib import Path


def test_daily_pipeline_formal_layer3_slots_cannot_activate_missing_artifacts():
    source = (Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert 'pool.get("formal_layer3_slots")' in source
    assert '"production_adapter_active"' in source
    assert 'status[name] = "retired"' in source
    assert 'model_status[name] = "retired"' in source
    assert 'production inference requires model_pool.models artifact path' in source
    assert 'production ensemble weight requires model_pool.models artifact path' in source


def test_modal_prediction_runtime_retire_formal_slot_without_model_artifact():
    source = (Path(__file__).resolve().parents[2] / "ml-service" / "app" / "prediction_runtime.py").read_text(encoding="utf-8")

    assert 'formal_slots = (pool_snapshot or {}).get("formal_layer3_slots", {})' in source
    assert 'def _resolve_model_pool_status' in source
    assert '"production_adapter_active"' in source
    assert 'return "retired"' in source
    assert 'controller-owned direct adapter' not in source
