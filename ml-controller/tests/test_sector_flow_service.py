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
        return []

    monkeypatch.setattr(sector_flow_service.d1_client, "query", fake_query)

    flows = sector_flow_service._load_symbol_cash_flows_5d("2026-04-30")

    assert flows["4938"]["total_net"] == pytest.approx((-17_248 - 447_258 - 60_587) * 82.3 / 1e8)
    assert flows["4938"]["foreign_net"] == pytest.approx(-17_248 * 82.3 / 1e8)
    assert flows["4938"]["trust_net"] == pytest.approx(-447_258 * 82.3 / 1e8)


def test_load_stock_tags_uses_finlab_taxonomy_with_stock_tags_overlay(monkeypatch):
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

    monkeypatch.setattr(sector_flow_service.d1_client, "query", fake_query)

    tags = sector_flow_service._load_stock_tags("industry_theme")

    assert tags["AI_SERVER"] == ["2330", "2382"]
    assert tags["MEMORY"] == ["3665"]


def test_write_sector_flow_persists_cash_flow_fields(monkeypatch):
    captured = {}

    def fake_batch_execute(statements):
        captured["statements"] = statements
        return {"total": len(statements)}

    monkeypatch.setattr(sector_flow_service.d1_client, "batch_execute", fake_batch_execute)

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
    )

    assert written == 1
    sql = captured["statements"][0][0]
    assert "rotation_velocity" in sql
    assert "rotation_score" in sql
    assert "rotation_regime" in sql
    assert "rrg_tail_json" in sql
    assert "updated_at" in sql
    assert "pit_lineage_version" in sql
    assert "up_count" in sql
    assert "turnover_share_delta" in sql
    params = captured["statements"][0][1]
    assert params[15:20] == [8, 6, 12_500_000.0, 0.125, 0.015]
    assert params[20:23] == [-0.0142, -0.3681, -0.4322]
    assert params[-1] == sector_flow_service.SECTOR_FLOW_PIT_LINEAGE_VERSION


def test_load_rrg_history_builds_per_sector_tail(monkeypatch):
    def fake_query(sql, params=None):
        assert "rrg_tail_json" not in sql
        assert params == ["industry", "industry", "2026-06-20", 60]
        return [
            {"sector": "AI", "date": "2026-06-18", "rs_ratio": 98.2, "rs_momentum": 0.6, "quadrant": "Improving"},
            {"sector": "AI", "date": "2026-06-19", "rs_ratio": 101.0, "rs_momentum": 1.2, "quadrant": "Leading"},
            {"sector": "Bad", "date": "2026-06-19", "rs_ratio": 97.0, "rs_momentum": None, "quadrant": "Leading"},
        ]

    monkeypatch.setattr(sector_flow_service.d1_client, "query", fake_query)

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

    monkeypatch.setattr(sector_flow_service.d1_client, "query", fake_query)
    monkeypatch.setattr(sector_flow_service.d1_client, "batch_execute", fake_batch_execute)

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


def test_industry_theme_tag_type_maps_to_own_sector_flow_classification():
    assert sector_flow_service._tag_type_to_classification("industry_theme") == "industry_theme"


def test_run_sector_flow_pipeline_includes_industry_theme_path(monkeypatch):
    captured_tag_types = []
    captured_classifications = []

    monkeypatch.setattr(sector_flow_service, "_load_symbol_cash_flows_5d", lambda as_of_date: {})
    monkeypatch.setattr(sector_flow_service, "_load_symbol_session_state", lambda as_of_date: {})
    monkeypatch.setattr(
        sector_flow_service,
        "_load_stock_tags",
        lambda tag_type: {tag_type: ["2330"]},
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

    def fake_compute(tag_type, as_of_date):
        captured_tag_types.append(tag_type)
        return [RrgPoint(
            sector=tag_type,
            rs_ratio=101.0,
            rs_momentum=1.0,
            quadrant="Leading",
            member_count=1,
            theme_return_5d=0.01,
        )]

    def fake_write(points, classification, as_of_date, cash_flows=None, session_stats=None):
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
    monkeypatch.setattr(
        sector_flow_service,
        "_load_stock_tags",
        lambda tag_type: {tag_type: ["2330"]},
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

    def fake_compute(tag_type, as_of_date):
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
