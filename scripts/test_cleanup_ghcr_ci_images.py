from __future__ import annotations

import datetime as dt
import unittest

from cleanup_ghcr_ci_images import UTC, decide_version_retention


NOW = dt.datetime(2026, 7, 16, tzinfo=UTC)


def version(*tags: str, age_days: int = 0, created_at: str | None = None) -> dict:
    timestamp = created_at or (NOW - dt.timedelta(days=age_days)).isoformat()
    return {
        "id": 123,
        "created_at": timestamp,
        "metadata": {"container": {"tags": list(tags)}},
    }


class RetentionDecisionTest(unittest.TestCase):
    def test_ci_image_expires_after_seven_days(self) -> None:
        self.assertTrue(decide_version_retention(version("ci-abc", age_days=7), now=NOW).delete)

    def test_fresh_ci_image_is_retained(self) -> None:
        self.assertFalse(decide_version_retention(version("ci-abc", age_days=6), now=NOW).delete)

    def test_candidate_uses_longer_retention_for_mixed_temporary_tags(self) -> None:
        mixed = version("quarantine-abc", "candidate-abc", age_days=29)
        self.assertFalse(decide_version_retention(mixed, now=NOW).delete)
        mixed = version("quarantine-abc", "candidate-abc", age_days=30)
        self.assertTrue(decide_version_retention(mixed, now=NOW).delete)

    def test_release_and_prod_tags_are_never_deleted(self) -> None:
        self.assertFalse(decide_version_retention(version("release-20260716", age_days=400), now=NOW).delete)
        self.assertFalse(decide_version_retention(version("prod-abc", age_days=400), now=NOW).delete)

    def test_unknown_and_untagged_versions_fail_closed(self) -> None:
        self.assertFalse(decide_version_retention(version("latest", age_days=400), now=NOW).delete)
        self.assertFalse(decide_version_retention(version(age_days=400), now=NOW).delete)

    def test_invalid_timestamp_fails_closed(self) -> None:
        item = version("ci-abc", created_at="not-a-date")
        self.assertFalse(decide_version_retention(item, now=NOW).delete)


if __name__ == "__main__":
    unittest.main()
