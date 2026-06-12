from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import retrain_trigger  # noqa: E402


def test_universal_retrain_request_forwards_artifact_lifecycle_fields():
    source = Path("routers/retrain_trigger.py").read_text(encoding="utf-8")

    assert "artifact_lifecycle_targets: list[str] = Field(default_factory=list)" in source
    assert "artifact_lifecycle_contracts: dict[str, str] = Field(default_factory=dict)" in source
    assert "artifact_lifecycle_only: bool = False" in source
    assert "sequence_gcs_prefix: str | None" in source
    assert "patchtst_seq_len: int | None" in source
    assert "itransformer_seq_len: int | None" in source
    assert '"artifact_lifecycle_targets": req.artifact_lifecycle_targets' in source
    assert '"artifact_lifecycle_contracts": req.artifact_lifecycle_contracts' in source
    assert '"artifact_lifecycle_only": req.artifact_lifecycle_only' in source
    assert '"sequence_gcs_prefix"] = sequence_gcs_prefix' in source
    assert "**sequence_contract" in source
    assert '@router.post("/universal/run")' in source


def test_sequence_batch_count_from_long_history_manifest():
    manifest = {
        "batch_size": 512,
        "lane_reports": [
            {"sequence_records": 2441},
            {"sequence_records": 629},
        ],
        "summary": {"symbols": 3070},
    }

    assert retrain_trigger._sequence_batch_count_from_manifest(manifest, fallback=1) == 6
