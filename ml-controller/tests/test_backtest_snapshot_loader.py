from __future__ import annotations

import json
import sys
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.backtest_engine import BacktestDataset  # noqa: E402

TEST_TMP = Path(__file__).resolve().parent.parent / ".tmp" / "backtest_snapshot_loader"
TECHNICAL_FIXTURE_PATH = Path(__file__).resolve().parents[2] / "worker" / "src" / "lib" / "technicalIndicatorsV2.fixture.json"


def _technical_fixture_expected() -> dict:
    return json.loads(TECHNICAL_FIXTURE_PATH.read_text(encoding="utf-8"))["expectedIndicators"]


def _write_component(name: str, rows: list[dict]) -> str:
    TEST_TMP.mkdir(parents=True, exist_ok=True)
    path = TEST_TMP / f"{name}.parquet"
    pl.DataFrame(rows, infer_schema_length=None).write_parquet(path)
    return str(path)


def test_backtest_dataset_loads_from_snapshot_manifest():
    technical_expected = _technical_fixture_expected()
    components = {
        "stocks": _write_component("stocks", [
            {
                "id": 1,
                "symbol": "2330",
                "name": "TSMC",
                "market": "TWSE",
                "sector": "semiconductor",
                "in_current_watchlist": 0,
                "listed_date": "2000-01-01",
                "delisted_date": None,
            },
            {
                "id": 2,
                "symbol": "9999",
                "name": "Too early",
                "market": "TWSE",
                "sector": "test",
                "in_current_watchlist": 0,
                "listed_date": "2030-01-01",
                "delisted_date": None,
            },
        ]),
        "prices": _write_component("prices", [
            {"stock_id": 1, "date": "2026-05-04", "open": 900.0, "high": 910.0, "low": 895.0, "close": 905.0, "volume": 1000, "avg_price": 903.0},
            {"stock_id": 1, "date": "2026-05-05", "open": 905.0, "high": 920.0, "low": 902.0, "close": 918.0, "volume": 1200, "avg_price": 914.0},
            {"stock_id": 2, "date": "2026-05-05", "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5, "volume": 1, "avg_price": 10.2},
        ]),
        "indicators": _write_component("indicators", [
            {
                "stock_id": 1,
                "date": "2026-05-05",
                "ma5": technical_expected["ma5"],
                "ma20": technical_expected["ma20"],
                "rsi14": technical_expected["rsi14"],
                "macd_hist": technical_expected["macdHist"],
                "atr14": technical_expected["atr14"],
                "plus_di14": technical_expected["plusDi14"],
                "minus_di14": technical_expected["minusDi14"],
                "adx14": technical_expected["adx14"],
                "parabolic_sar": technical_expected["parabolicSar"],
                "cci20": technical_expected["cci20"],
                "volume_weighted_rsi14": technical_expected["volumeWeightedRsi14"],
                "volume_momentum_divergence_13_27_10": technical_expected["volumeMomentumDivergence132710"],
                "squeeze_on": technical_expected["squeezeOn"],
                "squeeze_release": technical_expected["squeezeRelease"],
                "squeeze_momentum": technical_expected["squeezeMomentum"],
                "obv_temperature_60": technical_expected["obvTemperature60"],
                "adaptive_rsi_midline_50": technical_expected["adaptiveRsiMidline50"],
                "adaptive_rsi_upper_50": technical_expected["adaptiveRsiUpper50"],
                "adaptive_rsi_lower_50": technical_expected["adaptiveRsiLower50"],
                "adaptive_rsi_overbought": technical_expected["adaptiveRsiOverbought"],
                "adaptive_rsi_oversold": technical_expected["adaptiveRsiOversold"],
            },
        ]),
        "chips": _write_component("chips", [
            {"symbol": "2330", "date": "2026-05-05", "foreign_net": 100.0, "trust_net": 10.0, "dealer_net": 5.0},
        ]),
        "market_risk": _write_component("market_risk", [
            {"date": "2026-05-05", "risk_score": 20.0, "risk_level": "low"},
        ]),
    }
    manifest = {
        "snapshot_id": "backtest-dataset-20260505",
        "metadata_json": json.dumps({"components": components}),
        "gcs_uri": None,
    }

    dataset = BacktestDataset.load_from_snapshot_manifest(
        manifest=manifest,
        start_date="2026-05-04",
        end_date="2026-05-05",
    )

    assert dataset.trading_days == ["2026-05-04", "2026-05-05"]
    assert dataset.stocks.get_column("symbol").to_list() == ["2330"]
    assert set(dataset.get_universe_at("2026-05-05")) == {"2330"}
    assert dataset.get_price_history_np("2330", "2026-05-05", 5)["n"] == 2
    assert dataset.get_chip_history_np("2330", "2026-05-05", 5)["n"] == 1
    indicator = dataset.get_indicator("2330", "2026-05-05")
    assert indicator["adx14"] == technical_expected["adx14"]
    assert indicator["parabolic_sar"] == technical_expected["parabolicSar"]
    assert indicator["cci20"] == technical_expected["cci20"]
    assert indicator["volume_weighted_rsi14"] == technical_expected["volumeWeightedRsi14"]
    assert indicator["volume_momentum_divergence_13_27_10"] == technical_expected["volumeMomentumDivergence132710"]
    assert indicator["squeeze_on"] == technical_expected["squeezeOn"]
    assert indicator["squeeze_release"] == technical_expected["squeezeRelease"]
    assert indicator["squeeze_momentum"] == technical_expected["squeezeMomentum"]
    assert indicator["obv_temperature_60"] == technical_expected["obvTemperature60"]
    assert indicator["adaptive_rsi_upper_50"] == technical_expected["adaptiveRsiUpper50"]
    assert indicator["adaptive_rsi_overbought"] == technical_expected["adaptiveRsiOverbought"]


def test_snapshot_loader_requires_all_components():
    path = _write_component("incomplete_stocks", [{"id": 1, "symbol": "2330"}])
    manifest = {
        "snapshot_id": "incomplete",
        "metadata_json": json.dumps({"components": {"stocks": path}}),
    }

    try:
        BacktestDataset.load_from_snapshot_manifest(
            manifest=manifest,
            start_date="2026-05-04",
            end_date="2026-05-05",
        )
    except RuntimeError as exc:
        assert "backtest_snapshot_components_missing" in str(exc)
    else:
        raise AssertionError("expected missing component error")
