from tools.verify_production_provenance import verify_production_provenance


SOURCE_SHA = "a" * 40
MANIFEST_SHA = "b" * 64


def valid_snapshot() -> dict:
    return {
        "cloud_run": {
            "source_sha": SOURCE_SHA,
            "image_digest": "asia-east1-docker.pkg.dev/project/repo/image@sha256:" + "c" * 64,
            "scheduler_manifest_sha256": MANIFEST_SHA,
        },
        "modal": {"source_sha": SOURCE_SHA},
        "worker": {"source_sha": SOURCE_SHA, "version_id": "version-123"},
        "pages": {"source_sha": SOURCE_SHA, "scheduler_manifest_sha256": MANIFEST_SHA},
        "scheduler": {"manifest_sha256": MANIFEST_SHA},
    }


def test_production_provenance_accepts_one_source_and_manifest() -> None:
    assert verify_production_provenance(valid_snapshot()) == []


def test_production_provenance_rejects_split_source_and_scheduler() -> None:
    snapshot = valid_snapshot()
    snapshot["worker"]["source_sha"] = "d" * 40
    snapshot["pages"]["scheduler_manifest_sha256"] = "e" * 64

    errors = verify_production_provenance(snapshot)

    assert any(error.startswith("source SHA split:") for error in errors)
    assert any(error.startswith("scheduler manifest split:") for error in errors)
