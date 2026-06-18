from __future__ import annotations

import importlib.util
import os
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "validate_feature_registry_local_closure.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("stockvision_feature_registry_local_closure_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_derived_freshness_errors_detect_stale_artifact(tmp_path, monkeypatch):
    module = _load_module()
    artifact = tmp_path / "artifact.json"
    source = tmp_path / "source.json"
    artifact.write_text("{}", encoding="utf-8")
    source.write_text("{}", encoding="utf-8")
    old_time = time.time() - 60
    new_time = time.time()
    os.utime(artifact, (old_time, old_time))
    os.utime(source, (new_time, new_time))
    monkeypatch.setattr(module, "FILES", {"artifact": artifact, "source": source})
    monkeypatch.setattr(module, "DERIVED_DEPENDENCIES", {"artifact": ["source"]})

    errors, summary = module._derived_freshness_errors()

    assert errors == ["artifact_artifact_older_than:source"]
    assert summary["artifact"]["fresh"] is False
    assert summary["artifact"]["stale_against"] == ["source"]


def test_derived_freshness_errors_pass_when_artifact_is_newer(tmp_path, monkeypatch):
    module = _load_module()
    artifact = tmp_path / "artifact.json"
    source = tmp_path / "source.json"
    artifact.write_text("{}", encoding="utf-8")
    source.write_text("{}", encoding="utf-8")
    old_time = time.time() - 60
    new_time = time.time()
    os.utime(source, (old_time, old_time))
    os.utime(artifact, (new_time, new_time))
    monkeypatch.setattr(module, "FILES", {"artifact": artifact, "source": source})
    monkeypatch.setattr(module, "DERIVED_DEPENDENCIES", {"artifact": ["source"]})

    errors, summary = module._derived_freshness_errors()

    assert errors == []
    assert summary["artifact"]["fresh"] is True
    assert summary["artifact"]["stale_against"] == []
