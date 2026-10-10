from services import sector_flow_service
from services._rrg_calculator import RrgPoint
import pytest


def test_symbol_cash_flows_convert_chip_shares_to_twd_billions(monkeypatch):
    def fake_query(sql, params=None):
        if "FROM stock_prices" in sql and "SELECT DISTINCT date" in sql:
            return [{"date": f"2026-04-{day:02d}"} for day in (30, 29, 28, 27, 24)]
        if "FROM canonical_chip_daily c" in sql:
            return [{
                "symbol": "4938",
                "date": "2026-04-30",
                "foreign_net": -17_248,
                "trust_net": -447_258,
                "dealer_net": -60_587,
                "close": 82.3,
            }] + [{"symbol": "4938", "date": f"2026-04-{day:02d}",
                   "foreign_net": 0, "trust_net": 0, "dealer_net": 0} for day in (29, 28, 27, 24)]
        if "FROM stock_prices" in sql:
            return [{"stock_id": 1, "date": f"2026-04-{day:02d}", "close": 82.3} for day in (24, 27, 28, 29, 30)]
        return []

    monkeypatch.setattr(
        sector_flow_service.CORE_D1_CLIENT,
        "query",
        lambda *_args, **_kwargs: [{"id": 1, "symbol": "4938"}],
    )
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", fake_query)

    flows = sector_flow_service._load_symbol_cash_flows_5d("2026-04-30")

    assert flows["4938"]["total_net"] == pytest.approx((-17_248 - 447_258 - 60_587) * 82.3 / 1e8)
    assert flows["4938"]["foreign_net"] == pytest.approx(-17_248 * 82.3 / 1e8)
    assert flows["4938"]["trust_net"] == pytest.approx(-447_258 * 82.3 / 1e8)


def test_member_returns_reads_core_and_market_separately(monkeypatch):
    core_calls = []
    market_calls = []

    def core_query(sql, params=None):
        core_calls.append((sql, params))
        return [{"id": 1, "symbol": "2330"}]

    def market_query(sql, params=None):
        market_calls.append((sql, params))
        return [
            {"stock_id": 1, "date": f"2026-04-{day:02d}", "close": close}
            for day, close in zip(range(30, 24, -1), [106, 105, 104, 103, 102, 100])
        ]

    monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT, "query", core_query)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", market_query)

    returns = sector_flow_service._load_member_returns_5d("2026-04-30")

    assert returns == {"2330": pytest.approx(0.06)}
    assert "FROM stocks" in core_calls[0][0]
    assert "FROM stock_prices" in market_calls[0][0]
    assert "JOIN stocks" not in market_calls[0][0]


def test_sector_flow_rebuild_receipt_writes_ops_owner(monkeypatch):
    captured = []
    monkeypatch.setattr(
        sector_flow_service.OPS_D1_CLIENT,
        "execute",
        lambda sql, params: captured.append((sql, params)) or {"success": True},
    )

    sector_flow_service._persist_sector_flow_rebuild_run(
        run_id="sector-flow:2026-08-21:test",
        signal_date="2026-08-21",
        status="pass",
        reconstruction_mode="native",
        taxonomy_snapshot_ids={},
        membership_checksums={},
        rows_written=588,
        blockers=[],
    )

    assert len(captured) == 1
    assert "sector_flow_pit_rebuild_runs_v1" in captured[0][0]
    assert captured[0][1][0] == "sector-flow:2026-08-21:test"

def test_load_taxonomy_memberships_uses_finlab_as_single_owner(monkeypatch):
    def fake_query(sql, params=None):
        if "FROM finlab_taxonomy_tags" in sql:
            return [
                {"tag": "AI_SERVER", "symbol": "2330"},
                {"tag": "AI_SERVER", "symbol": "2382"},
            ]
        if "FROM stock_tags" in sql:
            return [
                {"tag": "AI_SERVER", "symbol": "2382"},
                {"tag": "MEMORY", "symbol": "3665"},
            ]
        return []

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", fake_query)

    tags = sector_flow_service._load_taxonomy_memberships("industry_theme")

    assert tags["AI_SERVER"] == ["2330", "2382"]
    assert "MEMORY" not in tags

def test_historical_taxonomy_reconstruction_requires_exact_snapshot(monkeypatch):
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", lambda *args, **kwargs: [])

    with pytest.raises(
        RuntimeError,
        match="historical_taxonomy_snapshot_missing:2026-06-20:industry_theme",
    ):
        sector_flow_service._load_taxonomy_memberships(
            "industry_theme",
            "2026-06-20",
            reconstruction_mode="historical_reconstruction",
        )


def test_native_taxonomy_load_freezes_exact_membership(monkeypatch):
    captured = {}

    def fake_query(sql, params=None):
        if "COUNT(*) row_count" in sql:
            checksum = captured["statements"][0][1][-1]
            return [{"row_count": 1, "min_checksum": checksum, "max_checksum": checksum}]
        if "sector_taxonomy_snapshot_runs_v1" in sql:
            return []
        if "sector_taxonomy_membership_snapshots_v1" in sql:
            return []
        if "FROM finlab_taxonomy_tags" in sql:
            return [{
                "tag": "AI_SERVER", "symbol": "2330", "source": "finlab.security_industry_themes",
                "source_as_of_date": "2026-07-30", "lineage_json": "{}",
            }]
        return []

    def fake_batch(statements, **kwargs):
        captured["statements"] = statements
        return {"total": len(statements)}

    def fake_execute(sql, params=None):
        captured.setdefault("execute", []).append((sql, params))
        return {"success": True}

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", fake_query)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "batch_execute", fake_batch)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "execute", fake_execute)

    tags = sector_flow_service._load_taxonomy_memberships("industry_theme", "2026-07-30")

    assert tags == {"AI_SERVER": ["2330"]}
    assert len(captured["statements"]) == 1
    sql, params = captured["statements"][0]
    assert "sector_taxonomy_membership_snapshots_v1" in sql
    assert params[0] == "2026-07-30"
    assert params[2:5] == ["industry_theme", "AI_SERVER", "2330"]
    assert len(captured["execute"]) == 2
    assert "status='ready'" in captured["execute"][1][0]


def test_ready_taxonomy_snapshot_rejects_partial_membership(monkeypatch):
    snapshot_id, checksum = sector_flow_service._taxonomy_snapshot_identity(
        "industry_theme", "2026-07-30", {"AI_SERVER": ["2330", "2382"]},
    )

    def fake_query(sql, params=None):
        if "sector_taxonomy_snapshot_runs_v1" in sql:
            return [{
                "snapshot_id": snapshot_id,
                "membership_checksum": checksum,
                "expected_row_count": 2,
                "persisted_row_count": 2,
                "status": "ready",
            }]
        if "sector_taxonomy_membership_snapshots_v1" in sql:
            return [{
                "tag": "AI_SERVER",
                "symbol": "2330",
                "source": "finlab.security_industry_themes",
            }]
        return []

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", fake_query)

    with pytest.raises(
        RuntimeError,
        match="sector_taxonomy_snapshot_integrity_failed:2026-07-30:industry_theme",
    ):
        sector_flow_service._load_persisted_taxonomy_snapshot("industry_theme", "2026-07-30")


def test_empty_ready_taxonomy_snapshot_is_valid(monkeypatch):
    snapshot_id, checksum = sector_flow_service._taxonomy_snapshot_identity(
        "subindustry", "2026-07-30", {},
    )

    def fake_query(sql, params=None):
        if "sector_taxonomy_snapshot_runs_v1" in sql:
            return [{
                "snapshot_id": snapshot_id,
                "membership_checksum": checksum,
                "expected_row_count": 0,
                "persisted_row_count": 0,
                "status": "ready",
            }]
        if "sector_taxonomy_membership_snapshots_v1" in sql:
            return []
        return []

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", fake_query)

    assert sector_flow_service._load_taxonomy_memberships(
        "subindustry", "2026-07-30", reconstruction_mode="historical_reconstruction",
    ) == {}


def test_persist_empty_taxonomy_snapshot_marks_ready(monkeypatch):
    captured = []

    def fake_query(sql, params=None):
        if "COUNT(*) row_count" in sql:
            return [{"row_count": 0, "min_checksum": None, "max_checksum": None}]
        return []

    def fake_execute(sql, params=None):
        captured.append((sql, params))
        return {"success": True}

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", fake_query)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "execute", fake_execute)

    snapshot_id, checksum = sector_flow_service._persist_taxonomy_snapshot(
        "subindustry", "2026-07-30", [], {},
    )

    assert snapshot_id.startswith("sector-taxonomy-2026-07-30-subindustry-")
    assert len(checksum) == 64
    assert len(captured) == 2
    assert "status='ready'" in captured[1][0]


def test_write_sector_flow_persists_cash_flow_fields(monkeypatch):
    captured = {}

    def fake_batch_execute(statements):
        captured["statements"] = statements
        return {"total": len(statements)}

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "batch_execute", fake_batch_execute)

    written = sector_flow_service.write_sector_flow(
        [
            RrgPoint(
                sector="PASSIVE_COMPONENT",
                rs_ratio=101.2,
                rs_momentum=0.4,
                quadrant="Leading",
                member_count=8,
                theme_return_5d=0.03,
            )
        ],
        "industry",
        "2026-04-30",
        {
            "PASSIVE_COMPONENT": {
                "foreign_net": -0.0142,
                "trust_net": -0.3681,
                "dealer_net": -0.0499,
                "total_net": -0.4322,
            }
        },
        {
            "PASSIVE_COMPONENT": {
                "stock_count": 8,
                "up_count": 6,
                "turnover_value": 12_500_000.0,
                "turnover_share": 0.125,
                "turnover_share_delta": 0.015,
            }
        },
        taxonomy_snapshot_id="snapshot-1",
        taxonomy_membership_checksum="checksum-1",
        knowledge_cutoff_date="2026-04-30",
        reconstruction_mode="native",
    )

    assert written == 1
    assert captured["statements"][0] == (
        "DELETE FROM sector_flow WHERE date=? AND classification=?",
        ["2026-04-30", "industry"],
    )
    sql = captured["statements"][1][0]
    assert "rotation_velocity" in sql
    assert "rotation_score" in sql
    assert "rotation_regime" in sql
    assert "rrg_tail_json" in sql
    assert "updated_at" in sql
    assert "pit_lineage_version" in sql
    assert "up_count" in sql
    assert "turnover_share_delta" in sql
    params = captured["statements"][1][1]
    assert params[15:20] == [8, 6, 12_500_000.0, 0.125, 0.015]
    assert params[20:23] == [-0.0142, -0.3681, -0.4322]
    assert params[-5:] == [
        sector_flow_service.SECTOR_FLOW_PIT_LINEAGE_VERSION,
        "snapshot-1", "checksum-1", "2026-04-30", "native",
    ]


def test_write_sector_flow_empty_slice_clears_prior_owner_rows(monkeypatch):
    captured = []

    def fake_batch_execute(statements):
        captured.extend(statements)
        return {"total": len(statements)}

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "batch_execute", fake_batch_execute)

    written = sector_flow_service.write_sector_flow(
        [], "subindustry", "2026-09-03", {}, {},
        taxonomy_snapshot_id="snapshot-empty",
        taxonomy_membership_checksum="checksum-empty",
        knowledge_cutoff_date="2026-09-03",
        reconstruction_mode="native",
    )

    assert written == 0
    assert captured == [(
        "DELETE FROM sector_flow WHERE date=? AND classification=?",
        ["2026-09-03", "subindustry"],
    )]


def test_load_rrg_history_builds_per_sector_tail(monkeypatch):
    def fake_query(sql, params=None):
        assert "rrg_tail_json" not in sql
        assert params == [
            "industry", sector_flow_service.SECTOR_FLOW_PIT_LINEAGE_VERSION,
            "industry", sector_flow_service.SECTOR_FLOW_PIT_LINEAGE_VERSION,
            "2026-06-20", 60,
        ]
        return [
            {"sector": "AI", "date": "2026-06-18", "rs_ratio": 98.2, "rs_momentum": 0.6, "quadrant": "Improving"},
            {"sector": "AI", "date": "2026-06-19", "rs_ratio": 101.0, "rs_momentum": 1.2, "quadrant": "Leading"},
            {"sector": "Bad", "date": "2026-06-19", "rs_ratio": 97.0, "rs_momentum": None, "quadrant": "Leading"},
        ]

    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", fake_query)

    history = sector_flow_service._load_rrg_history("industry", "2026-06-20")

    assert len(history["AI"]) == 2
    assert history["AI"][0].quadrant == "Improving"
    assert history["Bad"][0].quadrant == "Leading"


def test_write_sector_flow_stock_details_refreshes_current_date(monkeypatch):
    captured = {}

    def fake_query(sql, params=None):
        assert "FROM stocks" in sql
        return [{"symbol": "4938", "name": "Pegatron"}, {"symbol": "5871", "name": "Chailease"}]

    def fake_batch_execute(statements, **kwargs):
        captured["statements"] = statements
        captured["kwargs"] = kwargs
        return {"total": len(statements), "success_count": len(statements)}

    monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT, "query", fake_query)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "batch_execute", fake_batch_execute)

    written = sector_flow_service.write_sector_flow_stock_details(
        as_of_date="2026-05-07",
        tag_members={"AI": ["4938", "5871"]},
        symbol_flows={
            "4938": {"foreign_net": 0.56, "trust_net": -0.10, "dealer_net": 0.02, "total_net": 0.48},
            "5871": {"foreign_net": -0.20, "trust_net": 0.01, "dealer_net": 0.01, "total_net": -0.18},
        },
    )

    assert written == 1
    assert captured["statements"][0][0] == "DELETE FROM sector_flow_stocks WHERE date = ?"
    insert_params = captured["statements"][1][1]
    assert insert_params[:5] == ["2026-05-07", "AI", "4938", "Pegatron", 0.48]
    assert insert_params[-1] == "top"


def test_empty_industry_theme_details_clear_prior_rows(monkeypatch):
    captured = []
    monkeypatch.setattr(
        sector_flow_service.MARKET_D1_CLIENT,
        "execute",
        lambda sql, params=None: captured.append((sql, params)) or {"success": True},
    )
    monkeypatch.setattr(sector_flow_service, "_load_stock_names", lambda: {})

    written = sector_flow_service.write_sector_flow_stock_details(
        as_of_date="2026-09-03",
        tag_members={},
        symbol_flows={},
    )

    assert written == 0
    assert captured == [(
        "DELETE FROM sector_flow_stocks WHERE date = ?",
        ["2026-09-03"],
    )]


def test_industry_theme_tag_type_maps_to_own_sector_flow_classification():
    assert sector_flow_service._tag_type_to_classification("industry_theme") == "industry_theme"


def test_run_sector_flow_pipeline_includes_industry_theme_path(monkeypatch):
    import services.sector_flow_pit_history as history
    published = []
    def fake_publish(client, **kwargs):
        published.append(kwargs)
        return {"generation_id": kwargs["generation_id"], "row_count": kwargs["expected_rows"]}
    monkeypatch.setattr(history, "publish_sector_generation", fake_publish)
    captured_tag_types = []
    captured_classifications = []

    monkeypatch.setattr(sector_flow_service, "_load_symbol_cash_flows_5d", lambda as_of_date: {})
    monkeypatch.setattr(sector_flow_service, "_load_symbol_session_state", lambda as_of_date: {})
    monkeypatch.setattr(sector_flow_service.OPS_D1_CLIENT, "execute", lambda *args, **kwargs: {"success": True})
    monkeypatch.setattr(
        sector_flow_service,
        "_load_taxonomy_memberships",
        lambda tag_type, *args, **kwargs: {tag_type: ["2330"]},
    )
    monkeypatch.setattr(sector_flow_service, "_aggregate_tag_cash_flows", lambda tag_members, symbol_flows: {})
    monkeypatch.setattr(
        sector_flow_service,
        "_aggregate_tag_session_stats",
        lambda tag_members, symbol_state: {
            tag: {
                "stock_count": 1,
                "up_count": 1,
                "turnover_value": 1.0,
                "turnover_share": 1.0,
                "turnover_share_delta": 0.0,
            }
            for tag in tag_members
        },
    )
    monkeypatch.setattr(sector_flow_service, "write_sector_flow_stock_details", lambda **kwargs: 1)

    def fake_compute(tag_type, as_of_date, **kwargs):
        captured_tag_types.append(tag_type)
        return [RrgPoint(
            sector=tag_type,
            rs_ratio=101.0,
            rs_momentum=1.0,
            quadrant="Leading",
            member_count=1,
            theme_return_5d=0.01,
        )]

    def fake_write(points, classification, as_of_date, cash_flows=None, session_stats=None, **kwargs):
        captured_classifications.append(classification)
        return len(points)

    monkeypatch.setattr(sector_flow_service, "compute_sector_flow_for_tag_type", fake_compute)
    monkeypatch.setattr(sector_flow_service, "write_sector_flow", fake_write)

    summary = sector_flow_service.run_sector_flow_pipeline("2026-05-15")
    assert published[0]["expected_rows"] == 3
    assert set(published[0]["snapshot_ids"]) == {"industry", "industry_theme", "subindustry"}

    assert "industry_theme" in captured_tag_types
    assert "industry_theme" in captured_classifications
    assert "industry_theme" in summary
    assert "rotation_regimes" in summary["industry_theme"]
    assert "with_rotation" in summary["industry_theme"]
    assert summary["pit_lineage_version"] == sector_flow_service.SECTOR_FLOW_PIT_LINEAGE_VERSION
    assert summary["producer_position"] == "post_recommendation_for_next_decision_session"
    assert summary["same_signal_date_consumption_allowed"] is False
    assert summary["closure"]["status"] == "complete"


def test_run_sector_flow_pipeline_fails_closed_when_a_required_path_errors(monkeypatch):
    monkeypatch.setattr(sector_flow_service, "_load_symbol_cash_flows_5d", lambda as_of_date: {})
    monkeypatch.setattr(sector_flow_service, "_load_symbol_session_state", lambda as_of_date: {})
    monkeypatch.setattr(sector_flow_service.OPS_D1_CLIENT, "execute", lambda *args, **kwargs: {"success": True})
    monkeypatch.setattr(
        sector_flow_service,
        "_load_taxonomy_memberships",
        lambda tag_type, *args, **kwargs: {tag_type: ["2330"]},
    )
    monkeypatch.setattr(sector_flow_service, "_aggregate_tag_cash_flows", lambda *args: {})
    monkeypatch.setattr(
        sector_flow_service,
        "_aggregate_tag_session_stats",
        lambda tag_members, symbol_state: {
            tag: {
                "stock_count": 1,
                "up_count": 1,
                "turnover_value": 1.0,
                "turnover_share": 1.0,
                "turnover_share_delta": 0.0,
            }
            for tag in tag_members
        },
    )
    monkeypatch.setattr(sector_flow_service, "write_sector_flow_stock_details", lambda **kwargs: 1)

    def fake_compute(tag_type, as_of_date, **kwargs):
        if tag_type == "industry_theme":
            raise RuntimeError("upstream unavailable")
        return [RrgPoint(
            sector=tag_type,
            rs_ratio=101.0,
            rs_momentum=1.0,
            quadrant="Leading",
            member_count=1,
            theme_return_5d=0.01,
        )]

    monkeypatch.setattr(sector_flow_service, "compute_sector_flow_for_tag_type", fake_compute)
    monkeypatch.setattr(
        sector_flow_service,
        "write_sector_flow",
        lambda points, *args, **kwargs: len(points),
    )

    with pytest.raises(RuntimeError, match="sector_flow_pit_incomplete.*industry_theme:error"):
        sector_flow_service.run_sector_flow_pipeline("2026-05-15")

def test_aggregate_tag_session_stats_computes_daily_breadth_and_turnover_acceleration():
    stats = sector_flow_service._aggregate_tag_session_stats(
        {"AI": ["2330", "2382"], "SHIPPING": ["2603"]},
        {
            "2330": {
                "current_close": 110.0,
                "previous_close": 100.0,
                "current_turnover": 600.0,
                "previous_turnover": 400.0,
            },
            "2382": {
                "current_close": 90.0,
                "previous_close": 100.0,
                "current_turnover": 300.0,
                "previous_turnover": 400.0,
            },
            "2603": {
                "current_close": 50.0,
                "previous_close": 48.0,
                "current_turnover": 100.0,
                "previous_turnover": 200.0,
            },
        },
    )

    assert stats["AI"]["stock_count"] == 2
    assert stats["AI"]["up_count"] == 1
    assert stats["AI"]["turnover_share"] == pytest.approx(0.9)
    assert stats["AI"]["turnover_share_delta"] == pytest.approx(0.1)


def test_previous_ratios_count_distinct_sessions_not_sector_rows(monkeypatch):
    import sqlite3
    db = sqlite3.connect(':memory:')
    db.row_factory = sqlite3.Row
    db.execute('CREATE TABLE sector_flow(date TEXT, sector TEXT, classification TEXT, pit_lineage_version TEXT, rs_ratio REAL)')
    for day in ['01', '02', '05', '06', '07', '08']:
        for sector in range(8):
            db.execute('INSERT INTO sector_flow VALUES (?,?,?,?,?)',
                       (f'2026-10-{day}', str(sector), 'industry', 'sector-flow-pit-v1', int(day)*100+sector))
    # Other owners and null-only dates must not count as available sessions.
    for date, layer, version, value in [('2026-10-04','industry','other',999),
                                         ('2026-10-03','subindustry','sector-flow-pit-v1',999),
                                         ('2026-10-04','industry','sector-flow-pit-v1',None)]:
        db.execute('INSERT INTO sector_flow VALUES (?,?,?,?,?)', (date,'invalid',layer,version,value))
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, 'query',
                        lambda sql, params: [dict(row) for row in db.execute(sql, params)])
    assert sector_flow_service._load_prev_rs_ratios('industry', '2026-10-08') == {
        str(sector): 100+sector for sector in range(8)
    }
    assert sector_flow_service._load_prev_rs_ratios('industry', '2026-10-07') == {}
    db.close()


def _sector_member_sqlite_fixture(monkeypatch):
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,close REAL,PRIMARY KEY(stock_id,date))")
    for i in range(1, 9):
        db.execute("INSERT INTO stock_prices VALUES (?,?,?)", (1, f"2026-10-{i:02d}", 100 + i))
        db.execute("INSERT INTO stock_prices VALUES (?,?,?)", (2, f"2026-10-{i:02d}", 200 + i))
    monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT, "query",
        lambda *args: [{"id": 1, "symbol": "2330"}, {"id": 2, "symbol": "4169"}])
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query",
        lambda sql, params: [dict(r) for r in db.execute(sql, params)])
    return db


def test_member_return_uses_shared_sessions_across_missing_middle_quote(monkeypatch):
    with _sector_member_sqlite_fixture(monkeypatch) as db:
        db.execute("DELETE FROM stock_prices WHERE stock_id=2 AND date='2026-10-06'")
        actual = sector_flow_service._load_member_returns_5d("2026-10-08")
        assert actual == {"2330": pytest.approx(5/103), "4169": pytest.approx(5/203)}


@pytest.mark.parametrize("session,value", [
    ("2026-10-08", None), ("2026-10-03", None), ("2026-10-08", 0),
    ("2026-10-03", -1), ("2026-10-08", float("inf")),
])
def test_member_return_missing_or_invalid_endpoint_is_not_backfilled(monkeypatch, session, value):
    with _sector_member_sqlite_fixture(monkeypatch) as db:
        db.execute("UPDATE stock_prices SET close=? WHERE stock_id=2 AND date=?", (value, session))
        assert sector_flow_service._load_member_returns_5d("2026-10-08") == {"2330": pytest.approx(5/103)}


def test_member_return_requires_exact_current_and_six_market_sessions(monkeypatch):
    with _sector_member_sqlite_fixture(monkeypatch):
        assert sector_flow_service._load_member_returns_5d("2026-10-09") == {}
        assert sector_flow_service._load_member_returns_5d("2026-10-05") == {}


def test_member_return_preserves_valid_zero_and_negative_returns(monkeypatch):
    with _sector_member_sqlite_fixture(monkeypatch) as db:
        db.execute("UPDATE stock_prices SET close=203 WHERE stock_id=2 AND date='2026-10-08'")
        assert sector_flow_service._load_member_returns_5d("2026-10-08")["4169"] == 0
        db.execute("UPDATE stock_prices SET close=200 WHERE stock_id=2 AND date='2026-10-08'")
        assert sector_flow_service._load_member_returns_5d("2026-10-08")["4169"] == pytest.approx(-3/203)


def _benchmark_sqlite(monkeypatch):
    import sqlite3
    db = sqlite3.connect(":memory:"); db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE stock_prices(date TEXT)")
    db.execute("CREATE TABLE market_risk(date TEXT,twii_close REAL)")
    for day in range(1, 9):
        db.execute("INSERT INTO stock_prices VALUES (?)", (f"2026-10-{day:02d}",))
        db.execute("INSERT INTO market_risk VALUES (?,?)", (f"2026-10-{day:02d}", 100 + day))
    def query(sql, params): return [dict(r) for r in db.execute(sql, params)]
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", query)
    monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT, "query", query)
    return db


@pytest.mark.parametrize("latest,expected", [(108, 5/103), (103, 0), (100, -3/103)])
def test_benchmark_shared_endpoints_preserve_returns(monkeypatch, latest, expected):
    with _benchmark_sqlite(monkeypatch) as db:
        db.execute("DELETE FROM market_risk WHERE date='2026-10-06'")
        db.execute("UPDATE market_risk SET twii_close=? WHERE date='2026-10-08'", (latest,))
        assert sector_flow_service._load_twii_return_5d("2026-10-08") == expected


@pytest.mark.parametrize("mutation", [
    "DELETE FROM market_risk WHERE date='2026-10-08'",
    "DELETE FROM market_risk WHERE date='2026-10-03'",
    "UPDATE market_risk SET twii_close=NULL WHERE date='2026-10-08'",
    "UPDATE market_risk SET twii_close=0 WHERE date='2026-10-03'",
    "UPDATE market_risk SET twii_close=-1 WHERE date='2026-10-08'",
    "UPDATE market_risk SET twii_close=1e999 WHERE date='2026-10-08'",
    "INSERT INTO market_risk VALUES ('2026-10-08',108)",
    "DELETE FROM stock_prices WHERE date<'2026-10-04'",
    "DELETE FROM stock_prices WHERE date='2026-10-08'",
])
def test_benchmark_invalid_or_partial_is_not_zero_or_short_return(monkeypatch, mutation):
    with _benchmark_sqlite(monkeypatch) as db:
        db.execute(mutation)
        with pytest.raises(RuntimeError, match="sector_benchmark_"):
            sector_flow_service._load_twii_return_5d("2026-10-08")


def test_pipeline_missing_benchmark_prevents_sector_writes_and_complete(monkeypatch):
    with _benchmark_sqlite(monkeypatch) as db:
        db.execute("DELETE FROM market_risk WHERE date='2026-10-08'")
        monkeypatch.setattr(sector_flow_service, "_load_symbol_cash_flows_5d", lambda *_: {})
        monkeypatch.setattr(sector_flow_service, "_load_symbol_session_state", lambda *_: {})
        monkeypatch.setattr(sector_flow_service, "_load_taxonomy_memberships", lambda *a, **k: {"X": ["2330"]})
        monkeypatch.setattr(sector_flow_service, "_load_member_returns_5d", lambda *_: {"2330": .05})
        def no_sector_write(*a, **k): raise AssertionError("sector write reached")
        monkeypatch.setattr(sector_flow_service, "write_sector_flow", no_sector_write)
        monkeypatch.setattr(sector_flow_service, "write_sector_flow_stock_details", no_sector_write)
        receipts=[]
        monkeypatch.setattr(sector_flow_service, "_persist_sector_flow_rebuild_run", lambda **k: receipts.append(k))
        with pytest.raises(RuntimeError, match="sector_flow_pit_incomplete"):
            sector_flow_service.run_sector_flow_pipeline("2026-10-08")
        assert len(receipts)==1 and receipts[0]["status"]=="failed" and receipts[0]["rows_written"]==0
        assert len(receipts[0]["blockers"])==3


@pytest.mark.parametrize("requested,remove,expected", [
    ("2026-10-03", None, True),
    ("2026-10-04", None, False),
    ("2026-10-03", "2026-10-03", False),
    ("2026-10-03", "2026-10-02", False),
])
def test_session_state_requires_exact_day_and_two_issuer_quotes(monkeypatch, requested, remove, expected):
    import sqlite3
    with sqlite3.connect(":memory:") as db:
        db.row_factory=sqlite3.Row
        db.execute("CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,close REAL,volume REAL)")
        db.executemany("INSERT INTO stock_prices VALUES (?,?,?,?)", [
            (1,"2026-10-02",100,5), (1,"2026-10-03",110,0),
            (2,"2026-10-02",100,5), (2,"2026-10-03",110,5),
        ])
        if remove: db.execute("DELETE FROM stock_prices WHERE stock_id=1 AND date=?", (remove,))
        monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT,"query",lambda *a:[{"id":1,"symbol":"2330"}])
        monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT,"query",lambda sql,params:[dict(r) for r in db.execute(sql,params)])
        result=sector_flow_service._load_symbol_session_state(requested)
        if expected:
            assert result=={"2330":{"current_close":110,"previous_close":100,"current_turnover":0,"previous_turnover":500}}
        else:assert result=={}


@pytest.mark.parametrize("prices, expected", [
    ([{"stock_id": 1, "date": "2026-10-05", "close": 111.5}], None),
    ([{"stock_id": 1, "date": "2026-10-07", "close": 112.0}], None),
    ([{"stock_id": 1, "date": "2026-10-05", "close": 111.5},
      {"stock_id": 1, "date": "2026-10-06", "close": 110.0}], 110.0),
    ([], None),
])
def test_cashflow_price_requires_same_session(monkeypatch, prices, expected):
    monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT, "query",
                        lambda *_args: [{"id": 1, "symbol": "7747"}])
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", lambda *_args: prices)
    rows = [{"symbol": "7747", "date": "2026-10-06", "foreign_net": 900,
             "trust_net": -100, "dealer_net": 0}]
    sector_flow_service._attach_market_closes(rows)
    assert rows[0]["close"] == expected
    flows = {}
    sector_flow_service._accumulate_cash_flow(flows, rows[0], seen_symbol_dates=set())
    if expected is None:
        assert all(v is None for v in flows["7747"].values())
    else:
        assert flows["7747"]["foreign_net"] == pytest.approx(900 * 110 / 1e8)
        assert flows["7747"]["trust_net"] == pytest.approx(-100 * 110 / 1e8)
        assert flows["7747"]["dealer_net"] == 0


@pytest.mark.parametrize("canonical_indices, legacy_indices, expected", [
    (range(1, 6), range(5), 5.0),
    (range(5), range(1, 6), 13.0),
    ([1, 3, 4, 5], range(1, 6), 13.0),
])
def test_cashflow_sources_share_market_window(monkeypatch, canonical_indices, legacy_indices, expected):
    import sqlite3
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    dates = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]
    db.execute("CREATE TABLE stocks(id INTEGER, symbol TEXT)")
    db.execute("INSERT INTO stocks VALUES (1, '2330')")
    db.execute("CREATE TABLE stock_prices(stock_id INTEGER, date TEXT, close REAL)")
    db.executemany("INSERT INTO stock_prices VALUES (1, ?, 100)", [(d,) for d in dates])
    db.execute("CREATE TABLE canonical_chip_daily(stock_id TEXT, date TEXT, foreign_net REAL, trust_net REAL, dealer_net REAL)")
    db.execute("CREATE TABLE chip_data(symbol TEXT, date TEXT, foreign_net REAL, trust_net REAL, dealer_net REAL)")
    db.executemany("INSERT INTO canonical_chip_daily VALUES ('2330', ?, 1000000, 0, 0)", [(dates[i],) for i in canonical_indices])
    db.executemany("INSERT INTO chip_data VALUES ('2330', ?, 9000000, 0, 0)", [(dates[i],) for i in legacy_indices])
    def query(sql, params=None):
        return [dict(r) for r in db.execute(sql, params or [])]
    monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT, "query", query)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", query)
    try:
        result = sector_flow_service._load_symbol_cash_flows_5d(dates[-1])
        assert result["2330"] == {"foreign_net": expected, "trust_net": 0, "dealer_net": 0, "total_net": expected}
    finally:
        db.close()


@pytest.mark.parametrize("dates", [[], ["2026-10-07"], ["2026-10-06", "2026-10-05", "2026-10-02", "2026-10-01", "2026-09-30"]])
def test_cashflow_rejects_missing_market_window_before_chip_reads(monkeypatch, dates):
    calls = []
    def query(sql, params=None):
        calls.append(sql)
        assert "FROM stock_prices" in sql
        return [{"date": d} for d in dates]
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", query)
    with pytest.raises(RuntimeError, match="cash_flow_market_window_unavailable"):
        sector_flow_service._load_symbol_cash_flows_5d("2026-10-07")
    assert len(calls) == 1


@pytest.mark.parametrize("lookback", [0, -1, True, 2.5])
def test_cashflow_rejects_invalid_lookback_before_queries(monkeypatch, lookback):
    def query(*_args):
        raise AssertionError("unexpected query")
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", query)
    with pytest.raises(ValueError, match="cash_flow_lookback_must_be_positive_integer"):
        sector_flow_service._load_symbol_cash_flows_5d("2026-10-07", lookback)


@pytest.mark.parametrize("missing", [None, float("nan"), float("inf"), True])
def test_cashflow_unknown_component_persists_across_rows(missing):
    flows = {}; seen = set()
    for day, foreign in (("2026-10-01", missing), ("2026-10-02", 100)):
        sector_flow_service._accumulate_cash_flow(flows, dict(symbol="2330", date=day, close=100,
            foreign_net=foreign, trust_net=0, dealer_net=-100), seen_symbol_dates=seen)
    assert flows["2330"] == {"foreign_net": None, "trust_net": 0.0, "dealer_net": -0.0002, "total_net": None}
    sector_flow_service._accumulate_cash_flow(flows, dict(symbol="2330", date="2026-10-01", close=100,
        foreign_net=999, trust_net=999, dealer_net=999), seen_symbol_dates=seen)
    assert flows["2330"]["foreign_net"] is None
    assert flows["2330"]["trust_net"] == 0.0

@pytest.mark.parametrize("members", [[], ["missing"], ["2330", "missing"]])
def test_cashflow_group_missing_member_is_unknown(members):
    flow = dict(foreign_net=0.0, trust_net=-1.0, dealer_net=2.0, total_net=1.0)
    assert all(v is None for v in sector_flow_service._aggregate_tag_cash_flows({"tag": members}, {"2330": flow})["tag"].values())

def test_cashflow_group_preserves_known_components():
    flows = {"a": dict(foreign_net=None, trust_net=0.0, dealer_net=-1.0, total_net=None),
             "b": dict(foreign_net=1.0, trust_net=0.0, dealer_net=-2.0, total_net=-1.0)}
    assert sector_flow_service._aggregate_tag_cash_flows({"tag": ["a", "b"]}, flows)["tag"] == dict(
        foreign_net=None, trust_net=0.0, dealer_net=-3.0, total_net=None)


@pytest.mark.parametrize("mode", ["missing_day", "null_quantity", "missing_price"])
def test_cashflow_sql_unknown_is_not_legacy_zero_or_partial_sum(monkeypatch, mode):
    import sqlite3
    db = sqlite3.connect(":memory:"); db.row_factory = sqlite3.Row
    dates = ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07"]
    db.executescript("CREATE TABLE stocks(id INTEGER,symbol TEXT); INSERT INTO stocks VALUES(1,'2330');"
        "CREATE TABLE stock_prices(stock_id INTEGER,date TEXT,close REAL);"
        "CREATE TABLE canonical_chip_daily(stock_id TEXT,date TEXT,foreign_net REAL,trust_net REAL,dealer_net REAL);"
        "CREATE TABLE chip_data(symbol TEXT,date TEXT,foreign_net REAL,trust_net REAL,dealer_net REAL);")
    for i, day in enumerate(dates):
        db.execute("INSERT INTO stock_prices VALUES(1,?,?)", [day, None if mode == "missing_price" and i == 2 else 100])
        if mode == "missing_day" and i == 2: continue
        db.execute("INSERT INTO canonical_chip_daily VALUES('2330',?,?,0,-100)", [day, None if mode == "null_quantity" and i == 2 else 100])
        db.execute("INSERT INTO chip_data VALUES('2330',?,999,999,999)", [day])
    def query(sql, params=None): return [dict(r) for r in db.execute(sql, params or [])]
    monkeypatch.setattr(sector_flow_service.CORE_D1_CLIENT, "query", query)
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "query", query)
    try: result = sector_flow_service._load_symbol_cash_flows_5d(dates[-1])["2330"]
    finally: db.close()
    assert result["foreign_net"] is None and result["total_net"] is None
    if mode == "null_quantity":
        assert result["trust_net"] == 0 and result["dealer_net"] == pytest.approx(-0.0005)
    else: assert all(v is None for v in result.values())

@pytest.mark.parametrize("flow, expected", [
    (None, (None, None, None)),
    ({"foreign_net": None, "trust_net": 0.0, "total_net": None}, (None, 0.0, None)),
    ({"foreign_net": 0.0, "trust_net": -1.0, "total_net": -1.0}, (0.0, -1.0, -1.0)),
])
def test_cashflow_writer_preserves_sql_null_and_zero(monkeypatch, flow, expected):
    import re, sqlite3
    from pathlib import Path
    schema = (Path(__file__).resolve().parents[2] / "worker/domain-schemas/market.sql").read_text(encoding="utf-8")
    ddl = re.search(r"CREATE TABLE IF NOT EXISTS sector_flow \(.*?\n\);", schema, re.S).group()
    db = sqlite3.connect(":memory:"); db.execute(ddl)
    def batch(statements):
        with db:
            for sql, params in statements: db.execute(sql, params)
        return {"total": len(statements)}
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "batch_execute", batch)
    stats = dict(stock_count=1, up_count=0, turnover_value=0, turnover_share=0, turnover_share_delta=0)
    try:
        assert sector_flow_service.write_sector_flow(
            [RrgPoint(sector="tag", rs_ratio=100, rs_momentum=0, quadrant="Leading", member_count=3, theme_return_5d=0)],
            "industry", "2026-10-07", {"tag": flow} if flow is not None else {}, {"tag": stats},
            taxonomy_snapshot_id="fixture", taxonomy_membership_checksum="fixture",
            knowledge_cutoff_date="2026-10-07", reconstruction_mode="native") == 1
        assert db.execute("SELECT foreign_net,trust_net,total_net FROM sector_flow").fetchone() == expected
    finally: db.close()

def test_cashflow_stock_detail_excludes_unknown_total(monkeypatch):
    calls = []
    monkeypatch.setattr(sector_flow_service, "_load_stock_names", lambda: {})
    monkeypatch.setattr(sector_flow_service.MARKET_D1_CLIENT, "batch_execute",
                        lambda statements, **kwargs: calls.extend(statements) or {"total": len(statements)})
    flows = {"unknown": dict(foreign_net=None, trust_net=1, dealer_net=0, total_net=None),
             "known": dict(foreign_net=0, trust_net=1, dealer_net=0, total_net=1)}
    assert sector_flow_service.write_sector_flow_stock_details(as_of_date="2026-10-07", tag_members={"tag": list(flows)}, symbol_flows=flows) == 1
    assert calls[1][1][2] == "known" and calls[1][1][4:7] == [1, 0, 1]
