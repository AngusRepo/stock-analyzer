from __future__ import annotations

from routers.walk_forward import _latest_ready_oof_manifest


class Blob:
    def __init__(self, name: str, payload: dict):
        self.name = name
        self._payload = payload

    def download_as_text(self) -> str:
        import json

        return json.dumps(self._payload)


class Bucket:
    def __init__(self, rows: list[tuple[str, dict]]):
        self._rows = rows

    def list_blobs(self, prefix: str):
        assert prefix == "walk_forward/oof_cohorts/"
        return [Blob(name, payload) for name, payload in self._rows]


def _manifest(cohort_id: str, end_date: str, checksum: str) -> dict:
    return {
        "cohort_id": cohort_id,
        "end_date": end_date,
        "status": "ready",
        "generation_mode": "purged_oof",
        "manifest_checksum": checksum,
    }


def test_valid_evidence_revision_supersedes_its_base() -> None:
    base_path = "walk_forward/oof_cohorts/base/manifest.json"
    revision_path = "walk_forward/oof_cohorts/base-eabc/manifest.json"
    base = _manifest("base", "2026-07-09", "a" * 64)
    revision = {
        **_manifest("base-eabc", "2026-07-09", "b" * 64),
        "evidence_revision": {
            "schema_version": "active8-oof-evidence-revision-v1",
            "base_manifest_path": base_path,
            "base_manifest_checksum": "a" * 64,
        },
    }
    selected = _latest_ready_oof_manifest(
        Bucket([(base_path, base), (revision_path, revision)])
    )
    assert selected is not None
    assert selected[0] == revision_path


def test_checksum_mismatch_cannot_supersede_base() -> None:
    base_path = "walk_forward/oof_cohorts/base/manifest.json"
    revision_path = "walk_forward/oof_cohorts/base-eabc/manifest.json"
    base = _manifest("base", "2026-07-09", "a" * 64)
    revision = {
        **_manifest("base-eabc", "2026-07-09", "b" * 64),
        "evidence_revision": {
            "schema_version": "active8-oof-evidence-revision-v1",
            "base_manifest_path": base_path,
            "base_manifest_checksum": "c" * 64,
        },
    }
    selected = _latest_ready_oof_manifest(
        Bucket([(base_path, base), (revision_path, revision)])
    )
    assert selected is not None
    assert selected[0] == base_path


def test_newer_end_date_still_wins_over_older_revision() -> None:
    base_path = "walk_forward/oof_cohorts/base/manifest.json"
    revision_path = "walk_forward/oof_cohorts/base-eabc/manifest.json"
    newer_path = "walk_forward/oof_cohorts/newer/manifest.json"
    base = _manifest("base", "2026-07-09", "a" * 64)
    revision = {
        **_manifest("base-eabc", "2026-07-09", "b" * 64),
        "evidence_revision": {
            "schema_version": "active8-oof-evidence-revision-v1",
            "base_manifest_path": base_path,
            "base_manifest_checksum": "a" * 64,
        },
    }
    newer = _manifest("newer", "2026-07-17", "d" * 64)
    selected = _latest_ready_oof_manifest(
        Bucket([(base_path, base), (revision_path, revision), (newer_path, newer)])
    )
    assert selected is not None
    assert selected[0] == newer_path