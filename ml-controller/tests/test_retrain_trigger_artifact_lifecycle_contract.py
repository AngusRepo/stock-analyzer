from pathlib import Path


def test_universal_retrain_request_forwards_artifact_lifecycle_fields():
    source = Path("routers/retrain_trigger.py").read_text(encoding="utf-8")

    assert "artifact_lifecycle_targets: list[str] = Field(default_factory=list)" in source
    assert "artifact_lifecycle_contracts: dict[str, str] = Field(default_factory=dict)" in source
    assert "artifact_lifecycle_only: bool = False" in source
    assert '"artifact_lifecycle_targets": req.artifact_lifecycle_targets' in source
    assert '"artifact_lifecycle_contracts": req.artifact_lifecycle_contracts' in source
    assert '"artifact_lifecycle_only": req.artifact_lifecycle_only' in source
    assert '@router.post("/universal/run")' in source
