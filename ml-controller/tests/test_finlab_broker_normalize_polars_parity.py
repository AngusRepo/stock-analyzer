"""R33-NEW-42: the polars broker normalization is bit-identical to the pandas reference it replaced."""
import importlib.util
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

TOOL_PATH = Path(__file__).resolve().parents[2] / "tools" / "finlab_v4_remote_backfill.py"

# Verbatim pandas implementation at f6ce3eb8 (the reference oracle).
LEGACY = '''
def normalize_broker_transactions_daily(frame: pd.DataFrame, start: str) -> pd.DataFrame:
    """Normalize FinLab broker_transactions into daily symbol broker-flow evidence."""
    if frame.empty:
        return pd.DataFrame()
    date_col = _first_existing_column(frame, ("date", "日期", "trade_date"))
    stock_col = _first_existing_column(frame, ("stock_id", "symbol", "股票代號", "證券代號"))
    broker_col = _first_existing_column(frame, ("broker", "broker_code", "securities_broker", "分點", "券商", "證券商"))
    buy_col = _first_existing_column(frame, ("buy_shares", "buy_volume", "buy_qty", "buy", "買進股數", "買進張數"))
    sell_col = _first_existing_column(frame, ("sell_shares", "sell_volume", "sell_qty", "sell", "賣出股數", "賣出張數"))
    if not date_col or not stock_col or not buy_col or not sell_col:
        missing = {
            "date": not bool(date_col),
            "stock_id": not bool(stock_col),
            "buy_shares": not bool(buy_col),
            "sell_shares": not bool(sell_col),
        }
        print(f"[finlab-backfill] broker_transactions schema unsupported missing={missing} columns={list(frame.columns)[:12]}", flush=True)
        return pd.DataFrame()

    out = frame.copy()
    out["date"] = pd.to_datetime(out[date_col], errors="coerce")
    out = out[out["date"] >= pd.Timestamp(start)]
    out["stock_id"] = [
        _clean_symbol(row.get(stock_col), row)
        for row in out.to_dict(orient="records")
    ]
    out["broker_code"] = out[broker_col].astype(str).str.strip() if broker_col else "unknown"
    out["buy_shares_raw"] = pd.to_numeric(out[buy_col], errors="coerce").fillna(0)
    out["sell_shares_raw"] = pd.to_numeric(out[sell_col], errors="coerce").fillna(0)
    out["broker_net"] = out["buy_shares_raw"] - out["sell_shares_raw"]
    out = out[(out["stock_id"] != "") & out["date"].notna()]
    if out.empty:
        return pd.DataFrame()

    broker_daily = out.groupby(["date", "stock_id", "broker_code"], observed=True).agg(
        broker_buy_shares=("buy_shares_raw", "sum"),
        broker_sell_shares=("sell_shares_raw", "sum"),
        broker_net=("broker_net", "sum"),
    ).reset_index()
    broker_daily["abs_broker_net"] = broker_daily["broker_net"].abs()
    dominant = (
        broker_daily.sort_values(["date", "stock_id", "abs_broker_net"], ascending=[True, True, False])
        .groupby(["date", "stock_id"], observed=True)
        .head(1)[["date", "stock_id", "broker_code", "broker_net", "abs_broker_net"]]
        .rename(columns={
            "broker_code": "dominant_broker_code",
            "broker_net": "dominant_net_shares",
            "abs_broker_net": "dominant_abs_net_shares",
        })
    )
    pressure = broker_daily.groupby(["date", "stock_id"], observed=True).agg(
        gross_imbalance_shares=("abs_broker_net", "sum"),
        directional_broker_count=("abs_broker_net", lambda values: int((values > 0).sum())),
    ).reset_index()
    grouped = out.groupby(["date", "stock_id"], observed=True).agg(
        buy_shares=("buy_shares_raw", "sum"),
        sell_shares=("sell_shares_raw", "sum"),
        broker_count=("broker_code", "nunique"),
    ).reset_index()
    grouped = grouped.merge(dominant, on=["date", "stock_id"], how="left").merge(pressure, on=["date", "stock_id"], how="left")
    grouped["buy_sell_net"] = grouped["dominant_net_shares"].fillna(0)
    grouped["source"] = "finlab.broker_transactions"
    grouped["market_segment"] = "LISTED_OTC"
    grouped.attrs["broker_rank_daily"] = build_broker_rank_daily(
        broker_daily,
        market_segment="LISTED_OTC",
        source="finlab.broker_transactions",
    )
    return grouped
'''


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("finlab_v4_remote_backfill_tool", TOOL_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def legacy(tool):
    namespace = dict(vars(tool))
    exec(LEGACY, namespace)
    return namespace["normalize_broker_transactions_daily"]


@pytest.fixture
def check(tool, legacy, tmp_path, monkeypatch):
    """Compare against the reference and assert which path (polars or pandas) ran."""
    calls = []
    reference = tool._normalize_broker_transactions_daily_pandas
    monkeypatch.setattr(tool, "_normalize_broker_transactions_daily_pandas",
                        lambda *args: calls.append(1) or reference(*args))

    def run(frame, start, path):
        calls.clear()
        expected = legacy(frame.copy(), start)
        before = frame.copy()
        actual = tool.normalize_broker_transactions_daily(frame, start)
        assert ("pandas" if calls else "polars") == path
        pd.testing.assert_frame_equal(frame, before)  # the input is not mutated
        assert list(actual.columns) == list(expected.columns)
        pd.testing.assert_frame_equal(actual, expected, check_exact=True, check_index_type=True, check_column_type=True)
        assert actual.attrs.keys() == expected.attrs.keys()
        if "broker_rank_daily" in expected.attrs:
            pd.testing.assert_frame_equal(actual.attrs["broker_rank_daily"], expected.attrs["broker_rank_daily"],
                                          check_exact=True, check_index_type=True, check_column_type=True)
        if not expected.empty:
            for name, rows in (("daily", lambda df: df), ("rank", lambda df: df.attrs["broker_rank_daily"])):
                tool.write_parquet(tmp_path / f"new-{name}.parquet", rows(actual))
                tool.write_parquet(tmp_path / f"old-{name}.parquet", rows(expected))
                assert (tmp_path / f"new-{name}.parquet").read_bytes() == (tmp_path / f"old-{name}.parquet").read_bytes()
        return actual
    return run


def native_frame(rows=6000, seed=0, buy_dtype="float64"):
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2026-09-01", periods=12)
    symbols = np.array(["2330", "0050", "00631L", "6488", "1101B", "2330 台積電", "abc", "12345678",
                        "", "3008", "２３３０", "8069"], dtype=object)
    brokers = np.array(["9200", " 9268", "1020 ", "凱基-台北", "Z999", "1480", "9A00", "9100"], dtype=object)
    lots = rng.integers(0, 40, rows) * 1000
    frame = pd.DataFrame({
        "date": days[rng.integers(0, len(days), rows)],
        "symbol": symbols[rng.integers(0, len(symbols), rows)],
        "broker": brokers[rng.integers(0, len(brokers), rows)],
        "buy": lots,
        "sell": rng.permutation(lots),  # many equal |net| ties across brokers
    })
    frame.loc[rng.integers(0, rows, 40), "broker"] = None
    frame.loc[rng.integers(0, rows, 25), "symbol"] = None
    return frame.astype({"buy": buy_dtype, "sell": buy_dtype})


@pytest.mark.parametrize("dtype,path", [("float64", "polars"), ("int64", "polars"), ("Int64", "pandas"),
                                        ("Float64", "pandas"), ("int32", "pandas"), ("int16", "pandas"),
                                        ("int8", "pandas"), ("uint32", "pandas"), ("float32", "pandas")])
@pytest.mark.parametrize("start", ["2026-09-01", "2026-09-10", "2026-09-16"])
def test_native_finlab_shape_is_bit_identical(check, dtype, path, start):
    out = check(native_frame(buy_dtype=dtype), start, path)
    assert len(out) and out["date"].min() >= pd.Timestamp(start)


def test_mixed_integer_and_float_shares(check):
    frame = native_frame(seed=1)
    check(frame.astype({"sell": "int64"}), "2026-09-01", "polars")


def test_fractional_and_non_finite_shares_keep_the_pandas_path(check):
    frame = native_frame(rows=20000, seed=3)
    rng = np.random.default_rng(4)
    frame["buy"] = rng.random(len(frame)) * 1e5
    frame["sell"] = rng.random(len(frame)) * 1e5
    check(frame, "2026-09-01", "pandas")
    check(frame.astype({"buy": "float32", "sell": "float32"}), "2026-09-01", "pandas")
    whole = native_frame(rows=200, seed=5)
    whole.loc[[5, 9, 11, 13], ["symbol", "broker"]] = ["2330", "9200"]
    for col, at, value in (("buy", 5, np.inf), ("sell", 5, np.inf), ("sell", 9, -np.inf), ("buy", 11, np.nan)):
        whole.loc[at, col] = value  # row 5 nets inf - inf = NaN
    check(whole, "2026-09-01", "pandas")
    check(native_frame(rows=200, seed=6).assign(buy=2.0 ** 53), "2026-09-01", "pandas")



@pytest.mark.parametrize("col", ["buy", "sell"])
def test_signed_zero_shares_keep_the_pandas_path(check, col):
    frame = pd.DataFrame({"date": pd.to_datetime(["2026-09-01"]), "symbol": ["2330"], "broker": ["a"],
                          "buy": [0.0], "sell": [0.0]})
    frame[col] = -0.0  # the parquet byte check catches the sign of a zero sum
    check(frame, "2026-09-01", "pandas")


@pytest.mark.parametrize("seed", range(8))
def test_random_frames(check, seed):
    rng = np.random.default_rng(100 + seed)
    frame = native_frame(rows=int(rng.integers(1, 30000)), seed=seed)
    frame["buy"] = rng.integers(0, 5, len(frame)) * rng.choice([1, 1000, 999999937], len(frame))
    check(frame, str(pd.bdate_range("2026-09-01", periods=12)[seed].date()), "polars")


def test_coerced_text_shares_and_string_dates(check):
    frame = pd.DataFrame({
        "日期": ["2026-09-21", "2026-09-21", "bad", None, "2026-09-22", "2026/09/22", "2026-09-20"],
        "股票代號": ["2330", "2330", "2330", "2330", "00878 國泰永續", "2317", "2330"],
        "券商": ["1020", "1020", "1020", "1020", None, "9A00", "1020"],
        "買進股數": ["1,000", "12", "5", "7", None, "3", "9"],
        "賣出股數": ["0", "x", "1", "2", "4", "1", "1"],
    })
    check(frame, "2026-09-21", "polars")
    check(frame.assign(買進股數=["1", "12.5", "5", "7", None, "3", "9"]), "2026-09-21", "pandas")


def test_explicit_symbol_fields_must_agree(check):
    frame = pd.DataFrame({
        "date": ["2026-09-21"] * 8,
        "stock_id": pd.array([2330, "2330", 2330.0, True, "2317", None, "1101", np.nan], dtype=object),
        "symbol": ["2330", "2317", "2330", "2330", "2317", "2603", None, "2330"],
        "code": [None, None, None, "2330", "2318", None, "1101", 2330],
        "broker": ["1", "2", "3", "4", "5", "6", "7", "8"],
        "buy": [1, 2, 3, 4, 5, 6, 7, 8],
        "sell": [0, 0, 0, 0, 0, 0, 0, 0],
    })
    out = check(frame, "2026-09-21", "polars")
    assert out["stock_id"].tolist() == ["1101", "2330", "2603"]


def test_categorical_columns_and_missing_broker_field(check):
    frame = native_frame(rows=3000, seed=7)
    check(frame.astype({"symbol": "category", "broker": "category"}), "2026-09-05", "polars")
    check(frame.drop(columns=["broker"]), "2026-09-05", "polars")


def test_inputs_outside_the_polars_path(check):
    frame = native_frame(rows=3000, seed=8)
    check(frame.astype({"date": "timestamp[ns][pyarrow]"}), "2026-09-05", "pandas")
    check(frame.astype({"buy": "double[pyarrow]", "sell": "double[pyarrow]"}), "2026-09-05", "pandas")
    duplicated = pd.concat([frame, frame[["symbol"]].rename(columns={"symbol": "code"})] * 1, axis=1)
    duplicated.columns = ["date", "symbol", "broker", "buy", "sell", "symbol"]
    check(duplicated, "2026-09-05", "pandas")


def test_all_broker_codes_missing_and_empty_targets(check, tool):
    frame = native_frame(rows=500, seed=9)
    check(frame.assign(broker=None), "2026-09-01", "polars")
    assert tool.normalize_broker_transactions_daily(frame, "2027-01-01").empty
    assert tool.normalize_broker_transactions_daily(frame.assign(symbol="abc"), "2026-09-01").empty
    assert tool.normalize_broker_transactions_daily(frame.iloc[:0], "2026-09-01").empty


def test_integral_float_sums_over_large_groups(check):
    rng = np.random.default_rng(11)
    rows = 400_000
    frame = pd.DataFrame({"date": pd.Timestamp("2026-09-01") + pd.to_timedelta(rng.integers(0, 2, rows), "D"),
                          "symbol": rng.choice(["2330", "2317"], rows), "broker": rng.choice(["a", "b"], rows),
                          "buy": rng.integers(0, 10**7, rows).astype(float),
                          "sell": rng.integers(0, 10**7, rows).astype(float)})
    check(frame, "2026-09-01", "polars")
    check(frame.assign(buy=frame["buy"] + 0.25), "2026-09-01", "pandas")


def test_timezone_aware_dates_fail_like_the_reference(tool, legacy):
    frame = native_frame(rows=50).assign(date=lambda df: df["date"].dt.tz_localize("Asia/Taipei"))
    with pytest.raises(TypeError):
        legacy(frame.copy(), "2026-09-01")
    with pytest.raises(TypeError):
        tool.normalize_broker_transactions_daily(frame, "2026-09-01")
