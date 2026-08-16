from __future__ import annotations

from types import SimpleNamespace

from services import recommendation_service


def test_existing_seed_ids_reads_ops_and_core_separately(monkeypatch):
    ops_calls = []
    core_calls = []

    def ops_query(sql, params, timeout):
        ops_calls.append((sql, params, timeout))
        return [
            {"run_id": "run-1", "symbol": "2330"},
            {"run_id": "run-1", "symbol": "2454"},
        ]

    def core_query(sql, params):
        core_calls.append((sql, params))
        return [
            {"stock_id": 1, "symbol": "2330"},
            {"stock_id": 2, "symbol": "2317"},
        ]

    monkeypatch.setattr(
        recommendation_service,
        "OPS_D1_CLIENT",
        SimpleNamespace(query=ops_query),
    )
    monkeypatch.setattr(
        recommendation_service,
        "d1_client",
        SimpleNamespace(query=core_query),
    )

    result = recommendation_service._existing_recommendation_seed_stock_ids(
        [{"stock_id": 1}, {"stock_id": 2}],
        "2026-08-16",
    )

    assert result == {1}
    assert "screener_funnel_runs" in ops_calls[0][0]
    assert "screener_funnel_items" in ops_calls[0][0]
    assert ops_calls[0][1] == ["2026-08-16"]
    assert "daily_recommendations" in core_calls[0][0]
    assert "screener_funnel" not in core_calls[0][0]
    assert core_calls[0][1] == ["2026-08-16", 1, 2]


def test_stale_cleanup_fails_closed_when_latest_run_has_no_selected_seed(monkeypatch):
    core_calls = []

    monkeypatch.setattr(
        recommendation_service,
        "OPS_D1_CLIENT",
        SimpleNamespace(
            query=lambda sql, params, timeout: [{"run_id": "run-empty", "symbol": None}]
        ),
    )
    monkeypatch.setattr(
        recommendation_service,
        "d1_client",
        SimpleNamespace(
            query=lambda *args, **kwargs: core_calls.append(("query", args, kwargs)),
            execute=lambda *args, **kwargs: core_calls.append(("execute", args, kwargs)),
        ),
    )

    deleted = recommendation_service._delete_stale_recommendation_rows(
        [{"stock_id": 1}],
        "2026-08-16",
    )

    assert deleted == 0
    assert core_calls == []


def test_stale_cleanup_deletes_only_core_rows_outside_ops_seed(monkeypatch):
    ops_calls = []
    core_queries = []
    deletes = []

    def ops_query(sql, params, timeout):
        ops_calls.append((sql, params, timeout))
        return [{"run_id": "run-1", "symbol": "2330"}]

    def core_query(sql, params, timeout):
        core_queries.append((sql, params, timeout))
        return [
            {"stock_id": 1, "symbol": "2330"},
            {"stock_id": 2, "symbol": "2317"},
        ]

    def core_execute(sql, params, timeout):
        deletes.append((sql, params, timeout))
        return {"meta": {"changes": 1}}

    monkeypatch.setattr(
        recommendation_service,
        "OPS_D1_CLIENT",
        SimpleNamespace(query=ops_query),
    )
    monkeypatch.setattr(
        recommendation_service,
        "d1_client",
        SimpleNamespace(query=core_query, execute=core_execute),
    )

    deleted = recommendation_service._delete_stale_recommendation_rows(
        [{"stock_id": 1}],
        "2026-08-16",
    )

    assert deleted == 1
    assert "screener_funnel" not in core_queries[0][0]
    assert deletes[0][1] == ["2026-08-16", 2]
    assert len(ops_calls) == 1
