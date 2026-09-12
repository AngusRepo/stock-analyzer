import pytest
from tools.verify_cloud_run_release import release_tag_url, verify_health, verify_traffic


EXPECTED = {"sourceSha": "new", "sourceTreeSha": "tree", "sourceBranch": "main", "schedulerManifestSha256": "scheduler"}


def test_tagged_candidate_does_not_claim_pinned_old_production_is_updated():
    service = {"status": {"traffic": [
        {"revisionName": "old", "percent": 100},
        {"revisionName": "new", "tag": "candidate", "url": "https://candidate.example"},
    ]}}
    assert release_tag_url(service, "candidate", "new") == "https://candidate.example"
    with pytest.raises(ValueError, match="production_traffic_not_on_exact"):
        verify_traffic(service, "new")


@pytest.mark.parametrize("field", list(EXPECTED))
def test_http_provenance_rejects_old_runtime_even_when_template_was_updated(field):
    actual = {**EXPECTED, field: "old"}
    with pytest.raises(ValueError, match="http_provenance_mismatch"):
        verify_health({"status": "ok", "provenance": actual}, EXPECTED)


def test_verified_release_requires_matching_tag_http_and_full_traffic():
    service = {"status": {"traffic": [
        {"revisionName": "new", "percent": 100, "tag": "candidate", "url": "https://candidate.example"},
        {"revisionName": "old", "tag": "rollback", "url": "https://old.example"},
    ]}}
    assert release_tag_url(service, "candidate", "new") == "https://candidate.example"
    verify_health({"status": "ok", "provenance": EXPECTED}, EXPECTED)
    verify_traffic(service, "new")


def test_partial_rollout_cannot_claim_full_production_closure():
    with pytest.raises(ValueError):
        verify_traffic({"status": {"traffic": [{"revisionName": "new", "percent": 90}, {"revisionName": "old", "percent": 10}]}}, "new")


def test_tag_must_point_to_exact_requested_revision():
    with pytest.raises(ValueError):
        release_tag_url({"status": {"traffic": [{"revisionName": "old", "tag": "candidate", "url": "https://old.example"}]}}, "candidate", "new")
