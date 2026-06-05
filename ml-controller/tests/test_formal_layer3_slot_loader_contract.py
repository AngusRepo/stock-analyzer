from pathlib import Path


def test_daily_pipeline_reads_formal_layer3_slots_for_status_and_ic():
    source = (Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")

    assert 'pool.get("formal_layer3_slots")' in source
    assert '"production_adapter_active"' in source
    assert 'model_status[name] = "active"' in source
    assert 'ic_weights[name] = float(ic_value)' in source


def test_modal_prediction_runtime_resolves_formal_slot_status():
    source = (Path(__file__).resolve().parents[2] / "ml-service" / "app" / "prediction_runtime.py").read_text(encoding="utf-8")

    assert 'formal_slots = (pool_snapshot or {}).get("formal_layer3_slots", {})' in source
    assert 'def _resolve_model_pool_status' in source
    assert '"production_adapter_active"' in source
    assert 'return "retired"' in source
