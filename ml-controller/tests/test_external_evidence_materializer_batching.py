from __future__ import annotations

import importlib.util
import sqlite3
import urllib.error
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
MATERIALIZER = ROOT / "tools" / "materialize_external_evidence_once.py"


def load_materializer(monkeypatch):
    monkeypatch.setenv("CF_ACCOUNT_ID", "test-account")
    monkeypatch.setenv("CF_D1_DB_ID", "test-db")
    monkeypatch.setenv("CF_API_TOKEN", "test-token")
    spec = importlib.util.spec_from_file_location("external_evidence_materializer_batch_test", MATERIALIZER)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_materializer_batches_d1_writes_under_parameter_limit(monkeypatch) -> None:
    module = load_materializer(monkeypatch)
    calls: list[tuple[str, list[Any]]] = []

    def capture(sql: str, params: list[Any] | None = None, **_kwargs: Any) -> list[dict[str, Any]]:
        calls.append((sql, params or []))
        return []

    monkeypatch.setattr(module, "d1", capture)
    module.reset_d1_stats()

    feature_rows = [
        {
            "date": "2026-08-08",
            "symbol": f"{1000 + index}",
            "concept": "theme",
            "score": 1,
            "evidence_count": 1,
            "source_breakdown_json": "{}",
            "top_titles": "[]",
            "generated_at": "2026-08-08T00:00:00Z",
        }
        for index in range(25)
    ]
    module.upsert_features(feature_rows)
    assert len(calls) == 3
    assert [len(params) for _, params in calls] == [88, 88, 24]
    assert all(len(params) <= module.D1_MAX_BOUND_PARAMS for _, params in calls)
    assert module.D1_STATS["rows_submitted"] == 25

    calls.clear()
    module.reset_d1_stats()
    external_rows = [
        {
            "source_id": "official_rss",
            "source_kind": "official",
            "title": f"event-{index}",
            "published_at": "2026-08-08",
            "source_url": f"https://example.test/{index}",
        }
        for index in range(13)
    ]
    external_rows.append(dict(external_rows[0]))
    module.upsert_external(external_rows)
    assert len(calls) == 3
    assert [len(params) for _, params in calls] == [90, 90, 15]
    assert all("WITH incoming" in sql for sql, _ in calls)
    assert module.D1_STATS["rows_submitted"] == 13


def test_d1_retries_transient_transport_failure(monkeypatch) -> None:
    module = load_materializer(monkeypatch)
    attempts = 0

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return b'{"success":true,"result":[{"success":true,"results":[{"ok":1}]}]}'

    def fake_urlopen(*_args, **_kwargs):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise urllib.error.URLError("temporary")
        return Response()

    monkeypatch.setattr(module.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)
    module.reset_d1_stats()

    assert module.d1("SELECT 1") == [{"ok": 1}]
    assert module.D1_STATS["logical_queries"] == 1
    assert module.D1_STATS["http_attempts"] == 2
    assert module.D1_STATS["retries"] == 1


def test_source_quality_freshness_is_relative_to_as_of_date(monkeypatch) -> None:
    module = load_materializer(monkeypatch)
    params_seen: list[list[Any]] = []

    def capture(_sql: str, params: list[Any] | None = None, **_kwargs: Any) -> list[dict[str, Any]]:
        params_seen.append(params or [])
        return []

    monkeypatch.setattr(module, "d1", capture)
    module.AS_OF_DATE = "2026-08-08"

    module.upsert_quality("official_rss", "official", 1, "2026-08-04", 0.9)
    module.upsert_quality("official_rss", "official", 1, "2026-08-03", 0.9)

    assert params_seen[0][3] == "present"
    assert params_seen[1][3] == "stale"


def test_materialization_receipt_tracks_the_current_generated_batch(monkeypatch) -> None:
    module = load_materializer(monkeypatch)
    params_seen: list[Any] = []

    def capture(_sql: str, params: list[Any] | None = None, **_kwargs: Any) -> list[dict[str, Any]]:
        params_seen.extend(params or [])
        return [{"theme_rows": 3, "feature_rows": 7, "quality_rows": 3}]

    monkeypatch.setattr(module, "d1", capture)
    module.TARGET_DATE = "2026-08-08"
    module.AS_OF_DATE = "2026-08-08"
    module.GENERATED_AT = "2026-08-08T01:02:03Z"

    receipt = module.build_materialization_receipt(3, 7)

    assert receipt["status"] == "ready"
    assert params_seen == [module.GENERATED_AT, module.GENERATED_AT, module.AS_OF_DATE]


def test_external_batch_sql_is_sqlite_compatible_and_idempotent(monkeypatch) -> None:
    module = load_materializer(monkeypatch)
    conn = sqlite3.connect(":memory:")
    conn.execute(
        """
        CREATE TABLE external_evidence_items (
          source_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          title TEXT NOT NULL,
          published_at TEXT NOT NULL,
          source_url TEXT NOT NULL,
          symbols_json TEXT,
          themes_json TEXT,
          allowed_use TEXT NOT NULL,
          decision_effect TEXT NOT NULL,
          source_quality_score REAL NOT NULL,
          entity_linking_confidence REAL NOT NULL,
          spam_filter_status TEXT NOT NULL,
          accepted INTEGER NOT NULL,
          packet_checksum TEXT,
          raw_json TEXT
        )
        """
    )

    def execute(sql: str, params: list[Any] | None = None, **_kwargs: Any) -> list[dict[str, Any]]:
        conn.execute(sql, params or [])
        conn.commit()
        return []

    monkeypatch.setattr(module, "d1", execute)
    rows = [
        {
            "source_id": "official_rss",
            "source_kind": "official",
            "title": f"event-{index}",
            "published_at": "2026-08-08",
            "source_url": f"https://example.test/{index}",
            "symbols_json": "[]",
            "themes_json": "[]",
            "allowed_use": "risk_context",
            "decision_effect": "risk_context_only",
            "source_quality_score": 0.9,
            "entity_linking_confidence": 0.9,
            "spam_filter_status": "clean",
            "accepted": 1,
            "packet_checksum": "checksum",
            "raw_json": "{}",
        }
        for index in range(7)
    ]

    module.upsert_external(rows)
    module.upsert_external(rows)

    assert conn.execute("SELECT COUNT(*) FROM external_evidence_items").fetchone()[0] == 7
