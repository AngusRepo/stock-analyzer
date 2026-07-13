from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import retrain_trigger  # noqa: E402


def test_universal_retrain_request_forwards_artifact_lifecycle_fields():
    source = Path("routers/retrain_trigger.py").read_text(encoding="utf-8")

    assert "artifact_lifecycle_targets: list[str] = Field(default_factory=list)" in source
    assert "artifact_lifecycle_contracts: dict[str, str] = Field(default_factory=dict)" in source
    assert "artifact_lifecycle_only: bool = False" in source
    assert "require_exact_dataset_snapshot: bool" in source
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


def _snapshot_maps(*, business_date: str, components: list[str]) -> tuple:
    return ({}, {}, {}, {}, {}, {
        "snapshot_id": f"snapshot:{business_date}",
        "business_date": business_date,
        "components": components,
    })


def test_exact_snapshot_accepts_matching_date_and_canonical_fundamentals():
    rejection = retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=_snapshot_maps(
            business_date="2026-07-09",
            components=["prices", "canonical_fundamentals"],
        ),
    )

    assert rejection is None


def test_exact_snapshot_rejects_missing_snapshot_component_or_wrong_date():
    assert retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=None,
    ) == {
        "reason": "exact_dataset_snapshot_missing",
        "required_business_date": "2026-07-09",
    }
    assert retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=_snapshot_maps(
            business_date="2026-07-08",
            components=["prices", "canonical_fundamentals"],
        ),
    )["reason"] == "exact_dataset_snapshot_business_date_mismatch"
    assert retrain_trigger._exact_dataset_snapshot_rejection(
        require_exact=True,
        run_date="2026-07-09",
        snapshot_maps=_snapshot_maps(
            business_date="2026-07-09",
            components=["prices"],
        ),
    )["reason"] == "exact_dataset_snapshot_feature_component_missing"
