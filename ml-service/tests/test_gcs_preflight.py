from __future__ import annotations

import pytest

from app.gcs_preflight import verify_gcs_object_lifecycle


class _Blob:
    def __init__(self, *, corrupt_read: bool = False, deny_delete: bool = False):
        self.data = b""
        self.generation = 7
        self.corrupt_read = corrupt_read
        self.deny_delete = deny_delete
        self.deleted = False

    def upload_from_string(self, data, **kwargs):
        assert kwargs["if_generation_match"] == 0
        self.data = bytes(data)

    def download_as_bytes(self):
        return b"corrupt" if self.corrupt_read else self.data

    def delete(self, **kwargs):
        if self.deny_delete:
            raise PermissionError("storage.objects.delete denied")
        if kwargs:
            assert kwargs["if_generation_match"] == self.generation
        self.deleted = True

    def exists(self):
        return not self.deleted


class _Bucket:
    name = "stockvision-models-test"

    def __init__(self, blob):
        self._blob = blob
        self.object_name = None

    def blob(self, object_name):
        self.object_name = object_name
        return self._blob


def test_gcs_preflight_verifies_create_read_delete():
    blob = _Blob()
    bucket = _Bucket(blob)
    result = verify_gcs_object_lifecycle(
        bucket,
        workload="finlab-v4-backfill",
        run_id="run-1",
    )
    assert result["status"] == "pass"
    assert result["operations"] == ["create", "read", "delete"]
    assert blob.deleted is True
    assert bucket.object_name.startswith("health/preflight/finlab-v4-backfill/run-1/")


def test_gcs_preflight_fails_on_read_checksum_mismatch_and_cleans_up():
    blob = _Blob(corrupt_read=True)
    with pytest.raises(RuntimeError, match="gcs_preflight_read_checksum_mismatch"):
        verify_gcs_object_lifecycle(_Bucket(blob), workload="finlab", run_id="run-2")
    assert blob.deleted is True


def test_gcs_preflight_surfaces_delete_permission_failure():
    with pytest.raises(PermissionError, match="storage.objects.delete denied"):
        verify_gcs_object_lifecycle(
            _Bucket(_Blob(deny_delete=True)),
            workload="finlab",
            run_id="run-3",
        )
