from __future__ import annotations

import asyncio
import json
import sys
import types
from pathlib import Path

import pytest
from fastapi import HTTPException

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if "httpx" not in sys.modules:
    httpx_stub = types.ModuleType("httpx")
    httpx_stub.RequestError = RuntimeError

    class AsyncClient:  # pragma: no cover - lifecycle tests do not call HTTP.
        pass

    httpx_stub.AsyncClient = AsyncClient
    sys.modules["httpx"] = httpx_stub

if "google.cloud.storage" not in sys.modules:
    google_stub = sys.modules.setdefault("google", types.ModuleType("google"))
    cloud_stub = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
    storage_stub = types.ModuleType("google.cloud.storage")

    class Client:  # pragma: no cover - tests monkeypatch this client.
        pass

    storage_stub.Client = Client
    cloud_stub.storage = storage_stub
    google_stub.cloud = cloud_stub
    sys.modules["google.cloud.storage"] = storage_stub

from routers import model_pool  # noqa: E402


class _FakeBlob:
    def __init__(self, text: str | None = None):
        self._text = text

    def exists(self) -> bool:
        return self._text is not None

    def download_as_text(self) -> str:
        if self._text is None:
            raise RuntimeError("blob not found")
        return self._text

    def upload_from_string(self, text: str, content_type: str = "application/json") -> None:
        self._text = text


class _FakeBucket:
    def __init__(self, pool: dict):
        self.pool_blob = _FakeBlob(json.dumps(pool))

    def blob(self, path: str) -> _FakeBlob:
        assert path == "universal/model_pool.json"
        return self.pool_blob


class _FakeStorageClient:
    def __init__(self, bucket: _FakeBucket):
        self._bucket = bucket

    def bucket(self, name: str) -> _FakeBucket:
        assert name == "stockvision-models-test"
        return self._bucket


def _install_fake_gcs(monkeypatch, pool: dict) -> _FakeBucket:
    from google.cloud import storage

    bucket = _FakeBucket(pool)
    monkeypatch.setenv("GCS_BUCKET_NAME", "stockvision-models-test")
    monkeypatch.setattr(storage, "Client", lambda: _FakeStorageClient(bucket))
    monkeypatch.setattr(model_pool.discord_alert, "alert_lifecycle", lambda **_: None)
    return bucket


def _entry(
    status: str = "active",
    family: str = "feature",
    ic_4w_avg: float | None = 0.02,
    consecutive_negative_weeks: int = 0,
    weekly_ic: list[float] | None = None,
    challenger: dict | None = None,
) -> dict:
    row = {
        "status": status,
        "version": "v1",
        "gcs_path": "universal/x/v1.joblib",
        "balance_family": family,
        "ic_4w_avg": ic_4w_avg,
        "weekly_ic": weekly_ic or [],
        "consecutive_negative_weeks": consecutive_negative_weeks,
    }
    if challenger:
        row["challenger"] = challenger
    return row


def test_promote_check_apply_requires_confirm():
    with pytest.raises(HTTPException) as exc:
        asyncio.run(model_pool.promote_check(model_pool.PromoteCheckRequest(apply=True)))

    assert exc.value.status_code == 400
    assert "confirm=true" in exc.value.detail


def test_promote_check_blocks_demote_when_family_min_would_break(monkeypatch):
    pool = {
        "schema_version": "1.0",
        "models": {
            "Chronos": _entry(family="time_series"),
            "DLinear": _entry(family="time_series", consecutive_negative_weeks=3),
            "PatchTST": _entry(status="degraded", family="time_series", consecutive_negative_weeks=6),
        },
    }
    _install_fake_gcs(monkeypatch, pool)

    result = asyncio.run(model_pool.promote_check(model_pool.PromoteCheckRequest()))

    demote_blocks = [a for a in result["actions"] if a["transition"] == "demote_blocked"]
    assert demote_blocks
    assert demote_blocks[0]["model"] == "DLinear"
    assert "family balance guard" in demote_blocks[0]["reason"]


def test_promote_check_discards_mature_failed_challenger(monkeypatch):
    challenger = {
        "version": "v2",
        "gcs_path": "universal/xgboost/v2.joblib",
        "shadow_since": "2026-01-01",
        "weekly_ic": [-0.02, -0.03, -0.01, -0.04],
        "ic_4w_avg": -0.025,
        "consecutive_negative_weeks": 4,
    }
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": _entry(ic_4w_avg=0.03, challenger=challenger),
            "CatBoost": _entry(),
            "ExtraTrees": _entry(),
        },
    }
    bucket = _install_fake_gcs(monkeypatch, pool)

    result = asyncio.run(
        model_pool.promote_check(model_pool.PromoteCheckRequest(apply=True, confirm=True))
    )

    assert result["applied_count"] == 1
    saved = json.loads(bucket.pool_blob.download_as_text())
    assert "challenger" not in saved["models"]["XGBoost"]
    assert saved["lifecycle_events"][0]["transition"] == "discard_challenger"


def test_promote_check_blocks_promote_when_shadow_ab_missing(monkeypatch):
    challenger = {
        "version": "v2",
        "gcs_path": "universal/xgboost/v2.joblib",
        "shadow_since": "2026-01-01",
        "weekly_ic": [0.04, 0.05, 0.04, 0.05],
        "ic_4w_avg": 0.045,
        "consecutive_negative_weeks": 0,
        "model_cpcv": {
            "decision": "PASS",
            "method": "purged_cpcv_rank_ic",
            "failed_gates": [],
            "folds": 15,
            "oos_ic_mean": 0.03,
        },
    }
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": _entry(ic_4w_avg=0.01, challenger=challenger),
            "CatBoost": _entry(),
            "ExtraTrees": _entry(),
        },
    }
    _install_fake_gcs(monkeypatch, pool)

    import services.shadow_ab_service as shadow_ab_service

    monkeypatch.setattr(shadow_ab_service, "load_shadow_ab_by_model", lambda lookback_days=90: {})

    result = asyncio.run(
        model_pool.promote_check(
            model_pool.PromoteCheckRequest(
                require_promotion_gate=False,
                require_shadow_ab=True,
                require_paper_order_ab=False,
            )
        )
    )

    blocked = [a for a in result["actions"] if a["transition"] == "promote_blocked"]
    assert blocked
    assert "missing_shadow_ab:XGBoost" in blocked[0]["preconditions_failed"]
    packet = result["lifecycle_review_packet"]
    assert packet["summary"]["blocked_promotions"] == 1
    assert packet["required_evidence"]["shadow_ab"]
    assert packet["blocked"][0]["model"] == "XGBoost"


def test_promote_check_allows_promote_when_shadow_ab_passes(monkeypatch):
    challenger = {
        "version": "v2",
        "gcs_path": "universal/xgboost/v2.joblib",
        "shadow_since": "2026-01-01",
        "weekly_ic": [0.04, 0.05, 0.04, 0.05],
        "ic_4w_avg": 0.045,
        "consecutive_negative_weeks": 0,
        "model_cpcv": {
            "decision": "PASS",
            "method": "purged_cpcv_rank_ic",
            "failed_gates": [],
            "folds": 15,
            "oos_ic_mean": 0.03,
        },
    }
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": _entry(ic_4w_avg=0.01, challenger=challenger),
            "CatBoost": _entry(),
            "ExtraTrees": _entry(),
        },
    }
    _install_fake_gcs(monkeypatch, pool)

    import services.shadow_ab_service as shadow_ab_service
    import services.paper_order_ab_service as paper_order_ab_service

    monkeypatch.setattr(shadow_ab_service, "load_shadow_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {
            "decision": "PASS",
            "failed_gates": [],
            "samples": 80,
            "active_ic": 0.01,
            "challenger_ic": 0.04,
            "ic_lift": 0.03,
        }
    })
    monkeypatch.setattr(paper_order_ab_service, "load_paper_order_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {
            "decision": "PASS",
            "failed_gates": [],
            "orders": 25,
            "active_ic": 0.01,
            "challenger_ic": 0.04,
            "ic_lift": 0.03,
        }
    })

    result = asyncio.run(
        model_pool.promote_check(
            model_pool.PromoteCheckRequest(require_promotion_gate=False, require_shadow_ab=True)
        )
    )

    promotes = [a for a in result["actions"] if a["transition"] == "promote"]
    assert promotes
    assert result["shadow_ab_by_model"]["XGBoost"]["decision"] == "PASS"
    assert result["paper_order_ab_by_model"]["XGBoost"]["decision"] == "PASS"
    assert result["lifecycle_review_packet"]["summary"]["promote_candidates"] == 1
    assert result["lifecycle_review_packet"]["shadow_ab_by_model"]["XGBoost"]["decision"] == "PASS"


def test_promote_check_blocks_promote_when_model_cpcv_missing(monkeypatch):
    challenger = {
        "version": "v2",
        "gcs_path": "universal/xgboost/v2.joblib",
        "shadow_since": "2026-01-01",
        "weekly_ic": [0.04, 0.05, 0.04, 0.05],
        "ic_4w_avg": 0.045,
        "consecutive_negative_weeks": 0,
    }
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": _entry(ic_4w_avg=0.01, challenger=challenger),
            "CatBoost": _entry(),
            "ExtraTrees": _entry(),
        },
    }
    _install_fake_gcs(monkeypatch, pool)

    import services.shadow_ab_service as shadow_ab_service
    import services.paper_order_ab_service as paper_order_ab_service

    monkeypatch.setattr(shadow_ab_service, "load_shadow_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {"decision": "PASS", "failed_gates": [], "samples": 80}
    })
    monkeypatch.setattr(paper_order_ab_service, "load_paper_order_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {"decision": "PASS", "failed_gates": [], "orders": 25}
    })

    result = asyncio.run(
        model_pool.promote_check(model_pool.PromoteCheckRequest(require_promotion_gate=False))
    )

    blocked = [a for a in result["actions"] if a["transition"] == "promote_blocked"]
    assert blocked
    assert "missing_model_cpcv:XGBoost" in blocked[0]["preconditions_failed"]
    assert result["model_cpcv_by_model"] == {}
    assert result["lifecycle_review_packet"]["required_evidence"]["model_cpcv"]


def test_promote_check_apply_rejects_disabled_promotion_governance(monkeypatch):
    challenger = {
        "version": "v2",
        "gcs_path": "universal/xgboost/v2.joblib",
        "shadow_since": "2026-01-01",
        "weekly_ic": [0.04, 0.05, 0.04, 0.05],
        "ic_4w_avg": 0.045,
        "consecutive_negative_weeks": 0,
        "model_cpcv": {
            "decision": "PASS",
            "method": "purged_cpcv_rank_ic",
            "failed_gates": [],
            "folds": 15,
            "oos_ic_mean": 0.03,
        },
    }
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": _entry(ic_4w_avg=0.01, challenger=challenger),
            "CatBoost": _entry(),
            "ExtraTrees": _entry(),
        },
    }
    _install_fake_gcs(monkeypatch, pool)

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            model_pool.promote_check(
                model_pool.PromoteCheckRequest(
                    apply=True,
                    confirm=True,
                    require_promotion_gate=False,
                )
            )
        )

    assert exc.value.status_code == 400
    assert "cannot disable production promotion governance" in exc.value.detail
    assert "promotion_gate" in exc.value.detail


def test_promote_check_allows_promote_when_model_cpcv_passes(monkeypatch):
    challenger = {
        "version": "v2",
        "gcs_path": "universal/xgboost/v2.joblib",
        "shadow_since": "2026-01-01",
        "weekly_ic": [0.04, 0.05, 0.04, 0.05],
        "ic_4w_avg": 0.045,
        "consecutive_negative_weeks": 0,
        "model_cpcv": {
            "decision": "PASS",
            "method": "purged_cpcv_rank_ic",
            "failed_gates": [],
            "folds": 15,
            "oos_ic_mean": 0.03,
        },
    }
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": _entry(ic_4w_avg=0.01, challenger=challenger),
            "CatBoost": _entry(),
            "ExtraTrees": _entry(),
        },
    }
    _install_fake_gcs(monkeypatch, pool)

    import services.shadow_ab_service as shadow_ab_service
    import services.paper_order_ab_service as paper_order_ab_service
    monkeypatch.setattr(shadow_ab_service, "load_shadow_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {"decision": "PASS", "failed_gates": [], "samples": 80}
    })
    monkeypatch.setattr(paper_order_ab_service, "load_paper_order_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {"decision": "PASS", "failed_gates": [], "orders": 25}
    })

    result = asyncio.run(
        model_pool.promote_check(model_pool.PromoteCheckRequest(require_promotion_gate=False))
    )

    promotes = [a for a in result["actions"] if a["transition"] == "promote"]
    assert promotes
    assert result["model_cpcv_by_model"]["XGBoost"]["decision"] == "PASS"


def test_promote_check_apply_preserves_model_cpcv_on_active_entry(monkeypatch):
    cpcv = {
        "decision": "PASS",
        "method": "purged_cpcv_rank_ic",
        "failed_gates": [],
        "folds": 15,
        "oos_ic_mean": 0.03,
    }
    challenger = {
        "version": "v2",
        "gcs_path": "universal/xgboost/v2.joblib",
        "shadow_since": "2026-01-01",
        "weekly_ic": [0.04, 0.05, 0.04, 0.05],
        "ic_4w_avg": 0.045,
        "consecutive_negative_weeks": 0,
        "model_cpcv": cpcv,
    }
    pool = {
        "schema_version": "1.0",
        "models": {
            "XGBoost": _entry(ic_4w_avg=0.01, challenger=challenger),
            "CatBoost": _entry(),
            "ExtraTrees": _entry(),
        },
    }
    bucket = _install_fake_gcs(monkeypatch, pool)

    import services.shadow_ab_service as shadow_ab_service
    import services.paper_order_ab_service as paper_order_ab_service
    import services.promotion_service as promotion_service

    monkeypatch.setattr(shadow_ab_service, "load_shadow_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {"decision": "PASS", "failed_gates": [], "samples": 80}
    })
    monkeypatch.setattr(paper_order_ab_service, "load_paper_order_ab_by_model", lambda lookback_days=90: {
        "XGBoost": {"decision": "PASS", "failed_gates": [], "orders": 25}
    })
    monkeypatch.setattr(promotion_service, "evaluate_latest_promotion_gate", lambda source="backtest", pbo_source=None: {
        "decision": "PASS",
        "passed": True,
        "failed_gates": [],
        "warnings": [],
        "validation_packet": {"decision": "PASS", "failed_gates": []},
    })

    result = asyncio.run(
        model_pool.promote_check(model_pool.PromoteCheckRequest(apply=True, confirm=True))
    )

    assert result["applied_count"] == 1
    saved = json.loads(bucket.pool_blob.download_as_text())
    active = saved["models"]["XGBoost"]
    assert active["version"] == "v2"
    assert active["last_model_cpcv"]["decision"] == "PASS"
    assert "challenger" not in active
