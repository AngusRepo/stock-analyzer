from __future__ import annotations

import json

from app import gnn_training


class _FakeBlob:
    def __init__(self, text: str | None = None):
        self.text = text

    def exists(self):
        return self.text is not None

    def download_as_text(self):
        assert self.text is not None
        return self.text

    def upload_from_string(self, text: str, content_type: str | None = None):
        self.text = text
        self.content_type = content_type


class _FakeBucket:
    def __init__(self, pool: dict):
        self.blobs = {
            "universal/model_pool.json": _FakeBlob(json.dumps(pool)),
        }

    def blob(self, key: str):
        return self.blobs.setdefault(key, _FakeBlob())


def test_update_model_pool_active_clears_stale_live_ic_fields():
    bucket = _FakeBucket(
        {
            "models": {
                "GNN": {
                    "version": "old",
                    "gcs_path": "universal/gnn/old.joblib",
                    "ic_4w_avg": 0.15,
                    "weekly_ic": [0.15],
                    "rolling_ic": 0.15,
                    "last_ic_by_segment": {"LISTED": {"ic": 0.15}},
                    "model_cpcv": {"oos_ic": 0.02},
                    "artifact_backfill": {"source": "legacy_shadow"},
                }
            }
        }
    )

    result = gnn_training._update_model_pool_active(
        bucket,
        version="new",
        artifact_path="universal/gnn/new.pt",
        metadata={
            "oos_ic": 0.04,
            "daily_ic_count": 55,
            "validation_range": ["2026-02-11", "2026-05-14"],
        },
        reason="test",
    )

    updated = json.loads(bucket.blob("universal/model_pool.json").download_as_text())
    entry = updated["models"]["GNN"]
    assert result["new_version"] == "new"
    assert entry["gcs_path"] == "universal/gnn/new.pt"
    assert entry["last_ic_status"] == "awaiting_live_ic"
    for field in gnn_training.STALE_PROMOTION_FIELDS:
        assert field not in entry
    assert entry["retired_versions"][0]["ic_4w_avg_at_retire"] == 0.15
