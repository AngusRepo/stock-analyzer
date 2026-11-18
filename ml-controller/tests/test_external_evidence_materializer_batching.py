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


def _receipt_database() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE theme_signals (date TEXT NOT NULL, concept TEXT, source TEXT, score REAL, generated_at TEXT)")
    conn.execute("CREATE INDEX idx_theme_signals_date_score ON theme_signals(date DESC, score DESC)")
    conn.execute("CREATE TABLE stock_theme_features (date TEXT NOT NULL, symbol TEXT, concept TEXT, score REAL, generated_at TEXT)")
    conn.execute("CREATE INDEX idx_stock_theme_features_date_score ON stock_theme_features(date DESC, score DESC)")
    conn.execute("CREATE TABLE source_quality_metrics (source TEXT, dataset TEXT, as_of_date TEXT)")
    conn.execute("CREATE INDEX idx_source_quality_metrics_source ON source_quality_metrics(source, dataset, as_of_date DESC)")
    return conn


def test_materialization_receipt_counts_this_run_by_date_index(monkeypatch) -> None:
    module = load_materializer(monkeypatch)
    conn = _receipt_database()
    run, other = "2026-08-08T01:02:03.123456+00:00", "2026-08-07T01:02:03.123456+00:00"
    theme_dates = ["2026-08-01", "2026-08-08", ""]
    for n, day in enumerate(["2026-08-01", "2026-08-08", "2026-08-08", "", "2026-08-08"]):
        conn.execute("INSERT INTO theme_signals VALUES (?, ?, 's', ?, ?)", (day, f"c{n}", n, run))
    for n in range(4):
        conn.execute("INSERT INTO theme_signals VALUES ('2026-08-08', ?, 's', 1, ?)", (f"old{n}", other))
    for n in range(7):
        conn.execute("INSERT INTO stock_theme_features VALUES ('2026-08-08', ?, 'c', 1, ?)", (f"{1000 + n}", run))
        conn.execute("INSERT INTO stock_theme_features VALUES ('2026-08-07', ?, 'c', 1, ?)", (f"{1000 + n}", other))
    for source in ("official_rss", "company_ir_rss", "gdelt_events"):
        conn.execute("INSERT INTO source_quality_metrics VALUES (?, 'd', '2026-08-08')", (source,))
    calls: list[tuple[str, list[Any]]] = []

    def query(sql: str, params: list[Any] | None = None, **_kwargs: Any) -> list[dict[str, Any]]:
        calls.append((sql, list(params or [])))
        cur = conn.execute(sql, params or [])
        return [dict(zip([c[0] for c in cur.description], row)) for row in cur.fetchall()]

    monkeypatch.setattr(module, "d1", query)
    module.TARGET_DATE = module.AS_OF_DATE = "2026-08-08"
    module.GENERATED_AT = run
    old_theme = conn.execute("SELECT COUNT(*) FROM theme_signals WHERE generated_at=?", (run,)).fetchone()[0]
    old_features = conn.execute("SELECT COUNT(*) FROM stock_theme_features WHERE generated_at=?", (run,)).fetchone()[0]

    receipt = module.build_materialization_receipt(5, 7, theme_dates=theme_dates, feature_dates=["2026-08-08"])

    assert (receipt["actual_theme_rows"], receipt["actual_feature_rows"]) == (old_theme, old_features) == (5, 7)
    assert receipt["status"] == "ready" and receipt["source_quality_rows"] == 3
    for sql, params in calls:
        plan = " ".join(row[3] for row in conn.execute("EXPLAIN QUERY PLAN " + sql, params))
        assert "SCAN" not in plan, (sql, plan)

    module.D1_MAX_BOUND_PARAMS = 3
    calls.clear()
    assert module.count_generated_rows("theme_signals", theme_dates) == 5
    assert [len(params) for _, params in calls] == [3, 2]
    assert module.count_generated_rows("theme_signals", []) == 0


def _gdelt_failures(monkeypatch, error: BaseException) -> tuple[list[str], tuple[list[Any], str]]:
    module = load_materializer(monkeypatch)
    queries: list[str] = []

    def fail(*, query: str, **_kwargs: Any) -> list[dict[str, Any]]:
        queries.append(query)
        raise error

    monkeypatch.setattr(module, "fetch_gdelt_doc_events", fail)
    monkeypatch.setattr(module.time, "sleep", lambda _seconds: None)
    module.AS_OF_DATE = "2026-11-17"
    recommendations = [{"symbol": f"{2300 + n}", "name": f"name{n}"} for n in range(6)]
    return queries, module.build_gdelt_items(recommendations, {})


def test_gdelt_stops_after_rate_limit_or_timeout(monkeypatch) -> None:
    import socket

    rate_limited = urllib.error.HTTPError("https://api.gdeltproject.org", 429, "Too Many Requests", {}, None)
    for error in (rate_limited, TimeoutError("read timed out"), socket.timeout("timed out"),
                  urllib.error.URLError(TimeoutError("connect timed out"))):
        queries, (items, status) = _gdelt_failures(monkeypatch, error)
        assert len(queries) == 1, error
        assert (items, status) == ([], "fetch_failed")


def test_gdelt_other_failures_still_try_every_query(monkeypatch) -> None:
    for error in (ValueError("not json"), urllib.error.HTTPError("https://api.gdeltproject.org", 500, "err", {}, None)):
        queries, (items, status) = _gdelt_failures(monkeypatch, error)
        assert len(queries) == 9
        assert (items, status) == ([], "fetch_failed")


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


def test_gdelt_queries_are_paced_to_the_rate_limit(monkeypatch) -> None:
    module = load_materializer(monkeypatch)
    clock = [1000.0]
    sent_at: list[float] = []
    sleeps: list[float] = []

    def fetch(*, query: str, **_kwargs: Any) -> list[dict[str, Any]]:
        sent_at.append(clock[0])
        clock[0] += 1.5  # GDELT answer time
        return []

    def sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock[0] += seconds

    monkeypatch.setattr(module, "fetch_gdelt_doc_events", fetch)
    monkeypatch.setattr(module.time, "monotonic", lambda: clock[0])
    monkeypatch.setattr(module.time, "sleep", sleep)
    module.AS_OF_DATE = "2026-11-17"
    recommendations = [{"symbol": f"{2300 + n}", "name": f"name{n}"} for n in range(6)]
    module.build_gdelt_items(recommendations, {})
    assert len(sent_at) == 9
    assert all(later - earlier >= 5.0 for earlier, later in zip(sent_at, sent_at[1:]))
    assert sleeps and all(abs(s - 3.5) < 1e-9 for s in sleeps)
