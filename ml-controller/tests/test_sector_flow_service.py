from services import sector_flow_service
from services._rrg_calculator import RrgPoint
import pytest


def test_symbol_cash_flows_convert_chip_shares_to_twd_billions(monkeypatch):
    def fake_query(sql, params=None):
        if "FROM canonical_chip_daily" in sql and "SELECT DISTINCT date" in sql:
            return [{"date": "2026-04-30"}]
        if "FROM canonical_chip_daily c" in sql:
            return [{
                "symbol": "4938",
                "date": "2026-04-30",
                "foreign_net": -17_248,
                "trust_net": -447_258,
                "dealer_net": -60_587,
                "close": 82.3,
            }]
        if "FROM stock_prices" in sql:
            return [{"stock_id": 1, "date": "2026-04-30", "close": 82.3}]
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
