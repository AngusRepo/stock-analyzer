from __future__ import annotations

import importlib.util
import json
import os
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "unified137_materialization_audit.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("stockvision_unified137_materialization_audit_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_registry(path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "features": [
                    {"feature_id": "factor_a", "eligible_for_alpha_mining": True},
                    {"feature_id": "factor_b", "eligible_for_alpha_mining": True},
                    {"feature_id": "ignored", "eligible_for_alpha_mining": False},
                ]
            }
        ),
        encoding="utf-8",
    )


def _write_artifact(path: Path, registry_path: Path) -> None:
    path.write_text(
        json.dumps(
            {
                "schema_version": "stockvision-unified137-materialization-audit-v1",
                "registry": str(registry_path),
                "date_range": {
                    "start_date": "2023-01-01",
                    "end_date": "2026-06-15",
                    "universe": "sii",
                    "max_symbols": 0,
                },
                "counts": {
                    "eligible_for_alpha_mining": 2,
                    "mapped_factor_count": 2,
                    "missing_expected_count": 0,
                    "unavailable_count": 0,
                    "zero_coverage_count": 0,
                },
                "panel_mapping_pass": True,
                "coverage_pass": True,
                "pass": True,
            }
        ),
        encoding="utf-8",
    )


def test_existing_materialization_artifact_validation_allows_zero_counts(tmp_path):
    module = _load_module()
    registry_path = tmp_path / "registry.json"
    artifact_path = tmp_path / "artifact.json"
    _write_registry(registry_path)
    _write_artifact(artifact_path, registry_path)

    exit_code, summary = module._validate_existing_artifact(
        artifact_path=artifact_path,
        registry_path=registry_path,
        registry=module._load_registry(registry_path),
        start_date="2023-01-01",
        end_date="2026-06-15",
        universe="sii",
        max_symbols=0,
        started_at=time.time(),
    )

    assert exit_code == 0
    assert summary["pass"] is True
    assert summary["errors"] == []
    assert summary["mode"] == "artifact_validation"


def test_existing_materialization_artifact_validation_fails_when_stale(tmp_path):
    module = _load_module()
    registry_path = tmp_path / "registry.json"
    artifact_path = tmp_path / "artifact.json"
    _write_registry(registry_path)
    _write_artifact(artifact_path, registry_path)
    old_time = time.time() - 60
    os.utime(artifact_path, (old_time, old_time))
    new_time = time.time()
    os.utime(registry_path, (new_time, new_time))

    exit_code, summary = module._validate_existing_artifact(
        artifact_path=artifact_path,
        registry_path=registry_path,
        registry=module._load_registry(registry_path),
        start_date="2023-01-01",
        end_date="2026-06-15",
        universe="sii",
        max_symbols=0,
        started_at=time.time(),
    )

    assert exit_code == 2
    assert summary["pass"] is False
    assert "materialization_artifact_older_than_registry" in summary["errors"]
