from __future__ import annotations

import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_modal_training_cache_is_generation_bound_and_performance_only() -> None:
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    io_source = (ROOT / "ml-service" / "app" / "gcs_batch_io.py").read_text(encoding="utf-8")

    assert 'modal.Volume.from_name(' in source
    assert '"stockvision-training-input-cache-v1"' in source
    assert '"source_authority": "gcs_generation"' in source
    assert '"cache_role": "performance_only"' in source
    assert '"production_effect": False' in source
    assert 'source_authority": "gcs_direct"' in source
    assert '"identity_schema_version": "stockvision-gcs-generation-cache-v1"' in source
    assert '"generation": generation' in io_source
    assert 'download_as_bytes(if_generation_match=int(generation))' in io_source
    assert 'hashlib.sha256(raw).hexdigest() != metadata.get("sha256")' in io_source


def test_orchestrator_commits_cache_before_training_fanout() -> None:
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    orchestrator = source.split("def retrain_orchestrator(payload: dict) -> dict:", 1)[1]
    orchestrator = orchestrator.split("def finlab_prep_batch", 1)[0]

    assert orchestrator.index('result["stages"]["training_input_cache"]') < orchestrator.index("sequence_records =")
    assert orchestrator.index('result["stages"]["training_input_cache"]') < orchestrator.index('handles: dict[str, object] = {}')
    prewarm = source.split("def _prewarm_training_input_cache", 1)[1].split("def _prepare_training_input_cache_for_payload", 1)[0]
    assert prewarm.index("download_existing_blobs") < prewarm.index("training_input_cache_volume.commit()")


def test_all_repeated_tabular_downloaders_mount_shared_cache() -> None:
    source = (ROOT / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    required = (
        "retrain_orchestrator",
        "train_universal_from_gcs",
        "train_tree_model",
        "train_tree_models",
        "train_wf_tree_window",
        "train_gnn_graphsage_universal",
        "train_tabm_universal",
    )
    for function_name in required:
        pattern = re.compile(
            r"@app\.function\(\s*volumes=TRAINING_INPUT_CACHE_VOLUMES,[\s\S]{0,220}?"
            rf"def {function_name}\(",
        )
        assert pattern.search(source), f"shared training cache missing on {function_name}"

    assert "for key, raw in download_existing_blobs(bucket, keys, max_workers=4):" in (
        ROOT / "ml-service" / "app" / "gnn_training.py"
    ).read_text(encoding="utf-8")
