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
                {"tag": "AI伺服器", "symbol": "2330"},
                {"tag": "AI伺服器", "symbol": "2382"},
            ]
        if "FROM stock_tags" in sql:
            return [
                {"tag": "AI伺服器", "symbol": "2382"},
                {"tag": "高速傳輸", "symbol": "3665"},
            ]
        return []

    monkeypatch.setattr(sector_flow_service.d1_client, "query", fake_query)

    tags = sector_flow_service._load_stock_tags("industry_theme")

    assert tags["AI伺服器"] == ["2330", "2382"]
    assert tags["高速傳輸"] == ["3665"]


def test_write_sector_flow_persists_cash_flow_fields(monkeypatch):
    captured = {}

    def fake_batch_execute(statements):
        captured["statements"] = statements
        return {"total": len(statements)}

    monkeypatch.setattr(sector_flow_service.d1_client, "batch_execute", fake_batch_execute)

    written = sector_flow_service.write_sector_flow(
        [
            RrgPoint(
                sector="電子代工",
                rs_ratio=101.2,
                rs_momentum=0.4,
                quadrant="Leading",
                member_count=8,
                theme_return_5d=0.03,
            )
        ],
        "industry",
        "2026-04-30",
        {"電子代工": {"foreign_net": -0.0142, "trust_net": -0.3681, "dealer_net": -0.0499, "total_net": -0.4322}},
    )

    assert written == 1
    params = captured["statements"][0][1]
    assert params[-6:-3] == [-0.0142, -0.3681, -0.4322]


def test_symbol_turnover_snapshots_use_latest_two_trading_dates(monkeypatch):
    def fake_query(sql, params=None):
        if "SELECT DISTINCT date" in sql and "FROM stock_prices" in sql:
            return [{"date": "2026-05-26"}, {"date": "2026-05-25"}]
        if "FROM stock_prices sp" in sql:
            return [
                {"symbol": "2330", "date": "2026-05-26", "close": 100.0, "volume": 3000},
                {"symbol": "2317", "date": "2026-05-26", "close": 50.0, "volume": 2000},
                {"symbol": "2330", "date": "2026-05-25", "close": 80.0, "volume": 2500},
                {"symbol": "2317", "date": "2026-05-25", "close": 50.0, "volume": 4000},
            ]
        return []

    monkeypatch.setattr(sector_flow_service.d1_client, "query", fake_query)

    snapshots = sector_flow_service._load_symbol_turnover_snapshots("2026-05-26")

    assert snapshots["current_date"] == "2026-05-26"
    assert snapshots["previous_date"] == "2026-05-25"
    assert snapshots["current"]["2330"] == pytest.approx(300000.0)
    assert snapshots["previous"]["2317"] == pytest.approx(200000.0)
    assert snapshots["current_total"] == pytest.approx(400000.0)
    assert snapshots["previous_total"] == pytest.approx(400000.0)


def test_tag_turnover_shares_compute_current_share_and_delta():
    snapshots = {
        "current_date": "2026-05-26",
        "previous_date": "2026-05-25",
        "current": {"2330": 300.0, "2317": 100.0},
        "previous": {"2330": 200.0, "2317": 200.0},
        "current_total": 400.0,
        "previous_total": 400.0,
    }

    shares = sector_flow_service._compute_tag_turnover_shares(
        {"AI": ["2330"], "EMS": ["2317"]},
        snapshots,
    )

    assert shares["AI"]["turnover_value"] == pytest.approx(300.0)
    assert shares["AI"]["turnover_share"] == pytest.approx(0.75)
    assert shares["AI"]["turnover_share_delta"] == pytest.approx(0.25)
    assert shares["EMS"]["turnover_share_delta"] == pytest.approx(-0.25)


def test_write_sector_flow_persists_turnover_share_fields(monkeypatch):
    captured = {}

    def fake_batch_execute(statements):
        captured["statements"] = statements
        return {"total": len(statements)}

    monkeypatch.setattr(sector_flow_service.d1_client, "batch_execute", fake_batch_execute)

    sector_flow_service.write_sector_flow(
        [
            RrgPoint(
                sector="AI",
                rs_ratio=102.0,
                rs_momentum=1.2,
                quadrant="Leading",
                member_count=12,
                theme_return_5d=0.03,
            )
        ],
        "theme",
        "2026-05-26",
        {"AI": {"foreign_net": 0.5, "trust_net": 0.1, "dealer_net": 0.0, "total_net": 0.6}},
        {"AI": {"turnover_value": 123456789.0, "turnover_share": 0.0812, "turnover_share_delta": 0.0061}},
    )

    sql, params = captured["statements"][0]
    assert "turnover_value" in sql
    assert "turnover_share_delta" in sql
    assert params[-3:] == [123456789.0, 0.0812, 0.0061]


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
    monkeypatch.setattr(sector_flow_service, "_load_symbol_turnover_snapshots", lambda as_of_date: {
        "current_date": as_of_date,
        "previous_date": None,
        "current": {},
        "previous": {},
        "current_total": 0.0,
        "previous_total": 0.0,
    })
    monkeypatch.setattr(sector_flow_service, "_load_stock_tags", lambda tag_type: {})
    monkeypatch.setattr(sector_flow_service, "_aggregate_tag_cash_flows", lambda tag_members, symbol_flows: {})
    monkeypatch.setattr(sector_flow_service, "_compute_tag_turnover_shares", lambda tag_members, snapshots: {})
    monkeypatch.setattr(sector_flow_service, "write_sector_flow_stock_details", lambda **kwargs: 0)

    def fake_compute(tag_type, as_of_date):
        captured_tag_types.append(tag_type)
        return []

    def fake_write(points, classification, as_of_date, cash_flows=None, turnover_shares=None):
        captured_classifications.append(classification)
        return 0

    monkeypatch.setattr(sector_flow_service, "compute_sector_flow_for_tag_type", fake_compute)
    monkeypatch.setattr(sector_flow_service, "write_sector_flow", fake_write)

    summary = sector_flow_service.run_sector_flow_pipeline("2026-05-15")

    assert "industry_theme" in captured_tag_types
    assert "industry_theme" in captured_classifications
    assert "industry_theme" in summary
