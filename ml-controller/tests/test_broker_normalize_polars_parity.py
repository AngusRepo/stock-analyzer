"""R33-NEW-42: polars broker normalization must match the legacy pandas row-dict path exactly."""
from __future__ import annotations

import importlib.util
import sys
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd
import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL_PATH = ROOT / "tools" / "finlab_v4_remote_backfill.py"


def _load_tool_module():
    spec = importlib.util.spec_from_file_location("finlab_v4_remote_backfill_tool", TOOL_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


tool = _load_tool_module()


def legacy_normalize(frame: pd.DataFrame, start: str) -> pd.DataFrame:
    """The pre-polars body, verbatim apart from module references."""
    if frame.empty:
        return pd.DataFrame()
    date_col = tool._first_existing_column(frame, ("date", "日期", "trade_date"))
    stock_col = tool._first_existing_column(frame, ("stock_id", "symbol", "股票代號", "證券代號"))
    broker_col = tool._first_existing_column(frame, ("broker", "broker_code", "securities_broker", "分點", "券商", "證券商"))
    buy_col = tool._first_existing_column(frame, ("buy_shares", "buy_volume", "buy_qty", "buy", "買進股數", "買進張數"))
    sell_col = tool._first_existing_column(frame, ("sell_shares", "sell_volume", "sell_qty", "sell", "賣出股數", "賣出張數"))
    if not date_col or not stock_col or not buy_col or not sell_col:
        return pd.DataFrame()
    out = frame.copy()
    out["date"] = pd.to_datetime(out[date_col], errors="coerce")
    out = out[out["date"] >= pd.Timestamp(start)]
    out["stock_id"] = [tool._clean_symbol(row.get(stock_col), row) for row in out.to_dict(orient="records")]
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
    grouped.attrs["broker_rank_daily"] = tool.build_broker_rank_daily(
        broker_daily, market_segment="LISTED_OTC", source="finlab.broker_transactions")
    return grouped


def legacy_stock_ids(frame: pd.DataFrame, stock_col: str) -> list[str]:
    return [tool._clean_symbol(row.get(stock_col), row) for row in frame.to_dict(orient="records")]


def assert_identical(left: pd.DataFrame, right: pd.DataFrame) -> None:
    assert list(left.columns) == list(right.columns)
    assert list(left.dtypes) == list(right.dtypes)
    pd.testing.assert_frame_equal(left, right, check_exact=True, check_dtype=True,
                                  check_index_type=True, check_column_type=True)
    assert left.attrs.keys() == right.attrs.keys()
    for key in left.attrs:
        assert list(left.attrs[key].dtypes) == list(right.attrs[key].dtypes)
        pd.testing.assert_frame_equal(left.attrs[key], right.attrs[key], check_exact=True, check_dtype=True)


KIRAT_RAI_DIGITS = "".join(chr(code) for code in range(0x16D70, 0x16D74))  # Unicode 16 Nd

SYMBOL_TEXTS = [
    "2330", " 2330 ", "2330 台積電", "2330\t台積電", "2330  台積電", "00878", "006208", "2330A", "2330AB",
    "2330A1", "2330ABC", "2330a", "1234567", "123", "2330.0", "2330 5", "2330 5x", "２３３０", "٢٣٣٠",
    "　2330　", "\x1c2330\x1f", "\xa02330\x85", "2330\n", "\n2330", "2330 a\nb", "2330 \nb",
    "", "  ", "nan", "None", "2024-01-01", "https://x/2330", "[2330]", "2330,台積電", "2330:TW",
    "123456", "12345A", "1234AB", "12345AB", KIRAT_RAI_DIGITS, "2330 " + KIRAT_RAI_DIGITS[0],
    "2330 ", " 2330", "2330  x",
]


def _base_frame(stock_values, n_rep=3) -> pd.DataFrame:
    rows = []
    days = ["2026-09-28", "2026-09-29", "bad-date", None, "2026-09-01", "2026-09-30"]
    brokers = ["A", " A ", "B", None, 1001, "C"]
    buys = [1000, "200", "x", None, 3.5, 0]
    sells = [500, "800", 7, "nan", None, 0]
    for rep in range(n_rep):
        for index, value in enumerate(stock_values):
            rows.append({
                "date": days[(index + rep) % len(days)],
                "stock_id": value,
                "broker": brokers[(index * 7 + rep) % len(brokers)],
                "buy": buys[(index + 2 * rep) % len(buys)],
                "sell": sells[(index * 3 + rep) % len(sells)],
            })
    return pd.DataFrame(rows)


def _frames():
    yield "strings", _base_frame(SYMBOL_TEXTS + [None, np.nan])
    yield "mixed_objects", _base_frame([2330, "2330", b"2330", Decimal("2330"), 2330.0, True, None,
                                        pd.Timestamp("2026-09-28"), "\ud800", "2330\ud800", ["2330"], "1101 台泥"])
    ints = _base_frame(list(range(6)))
    ints["stock_id"] = np.array([2330, 50, 1234567, 6208, -2330, 1101], dtype=np.int64)[np.arange(len(ints)) % 6]
    yield "int64", ints
    nullable = ints.copy()
    nullable["stock_id"] = pd.array([2330, None, 1101, 50, None, 6208] * (len(nullable) // 6), dtype="Int64")
    yield "nullable_int", nullable
    floats = ints.copy()
    floats["stock_id"] = floats["stock_id"].astype(float).where(floats.index % 4 != 0)
    yield "float", floats
    category = _base_frame(SYMBOL_TEXTS)
    category["stock_id"] = category["stock_id"].astype("category")
    yield "category", category
    string_dtype = _base_frame(SYMBOL_TEXTS + [None])
    string_dtype["stock_id"] = string_dtype["stock_id"].astype("string")
    yield "string_dtype", string_dtype
    agree = _base_frame(SYMBOL_TEXTS)
    agree["code"] = (["2330", None, "2330 台積電", "1101", np.nan, " 2330", "bad"] * len(agree))[: len(agree)]
    agree["公司代號"] = ([None, "2330", "2330", 2330, "x"] * len(agree))[: len(agree)]
    yield "multi_candidate", agree
    by_symbol = _base_frame(SYMBOL_TEXTS).rename(columns={"stock_id": "symbol"})
    yield "symbol_named", by_symbol
    upper = _base_frame(SYMBOL_TEXTS).rename(columns={"stock_id": "Stock_ID"})
    upper["symbol"] = (["1101", None, "2330"] * len(upper))[: len(upper)]
    yield "case_insensitive_plus_key", upper
    chinese = _base_frame(SYMBOL_TEXTS).rename(columns={
        "date": "日期", "stock_id": "證券代號", "broker": "券商", "buy": "買進股數", "sell": "賣出股數"})
    yield "chinese_columns", chinese
    no_broker = _base_frame(SYMBOL_TEXTS).drop(columns=["broker"])
    yield "no_broker", no_broker
    shuffled = _base_frame(SYMBOL_TEXTS).sample(frac=1.0, random_state=7)
    shuffled.index = [f"r{i % 5}" for i in range(len(shuffled))]  # duplicate string labels
    yield "shuffled_duplicate_index", shuffled
    dated = _base_frame(SYMBOL_TEXTS)
    dated["date"] = pd.to_datetime(dated["date"], errors="coerce")
    yield "datetime_dates", dated
    int_volumes = _base_frame(SYMBOL_TEXTS)
    int_volumes["buy"] = np.arange(len(int_volumes), dtype=np.int64) * 10
    int_volumes["sell"] = np.arange(len(int_volumes), dtype=np.int64)[::-1] * 7
    yield "int_volumes", int_volumes
    dup = _base_frame(SYMBOL_TEXTS)
    dup["code"] = "9999"
    dup = pd.concat([dup, pd.DataFrame({"code": ["2330"] * len(dup)}, index=dup.index)], axis=1)
    yield "duplicate_symbol_label", dup
    yield "all_before_start", _base_frame(["2330"]).assign(date="2020-01-01")
    yield "all_invalid_symbols", _base_frame(["", "nan", "x"])


@pytest.mark.parametrize("name,frame", list(_frames()), ids=[name for name, _ in _frames()])
def test_normalize_matches_legacy_pandas_path(name, frame):
    start = "2026-09-02"
    expected = legacy_normalize(frame.copy(), start)
    original = frame.copy()
    actual = tool.normalize_broker_transactions_daily(frame, start)
    pd.testing.assert_frame_equal(frame, original)  # input untouched
    assert_identical(actual, expected)


@pytest.mark.parametrize("name,frame", list(_frames()), ids=[name for name, _ in _frames()])
def test_stock_ids_match_legacy_row_dicts(name, frame):
    stock_col = tool._first_existing_column(frame, ("stock_id", "symbol", "股票代號", "證券代號"))
    keep = np.ones(len(frame), dtype=bool)
    assert tool._broker_stock_ids(frame, stock_col, keep) == legacy_stock_ids(frame, stock_col)


def test_every_code_point_strips_and_matches_like_python():
    chars = [chr(code) for code in range(0x110000) if not 0xD800 <= code <= 0xDFFF]
    texts = ([ch * 4 for ch in chars] + [ch + "2330" + ch for ch in chars] + ["2330 " + ch for ch in chars]
             + ["2330" + ch for ch in chars])
    frame = pd.DataFrame({"stock_id": texts})
    keep = np.ones(len(frame), dtype=bool)
    actual = tool._broker_stock_ids(frame, "stock_id", keep)
    expected = [tool._clean_symbol(text) for text in texts]
    mismatches = [(texts[i], actual[i], expected[i]) for i in range(len(texts)) if actual[i] != expected[i]]
    assert mismatches == []


def test_random_frame_matches_legacy_pandas_path():
    rng = np.random.default_rng(42)
    n = 20_000
    pool = np.array(SYMBOL_TEXTS + [f"{code}" for code in range(1101, 1200)], dtype=object)
    frame = pd.DataFrame({
        "date": rng.choice(pd.bdate_range("2026-08-20", periods=40).astype(str).tolist() + ["bad"], n),
        "stock_id": rng.choice(pool, n),
        "broker": rng.integers(1000, 1010, n).astype(str),
        "buy": rng.integers(0, 50, n).astype(float),
        "sell": rng.integers(0, 50, n),
    })
    frame.loc[rng.random(n) < 0.05, "buy"] = np.nan
    assert_identical(tool.normalize_broker_transactions_daily(frame, "2026-09-02"),
                     legacy_normalize(frame.copy(), "2026-09-02"))


def _duplicated(label: str) -> pd.DataFrame:
    frame = _base_frame(SYMBOL_TEXTS)
    if label not in frame.columns:
        frame[label] = "1"
    return pd.concat([frame, pd.DataFrame({label: ["9999"] * len(frame)}, index=frame.index)], axis=1)


@pytest.mark.parametrize("label", ["stock_id", "broker_code", "buy_shares_raw", "sell_shares_raw"])
def test_duplicated_output_label_still_fails_closed(label):
    frame = _duplicated(label)
    with pytest.raises(Exception):
        legacy_normalize(frame.copy(), "2026-09-02")
    with pytest.raises(ValueError, match="broker_transactions_duplicate_output_columns"):
        tool.normalize_broker_transactions_daily(frame, "2026-09-02")


def test_duplicated_broker_net_label_matches_legacy_on_pandas_3():
    """An input broker_net is overwritten; pandas 3 legacy ignores the duplicate, pandas 2 legacy
    raised by accident (AttributeError). The new path follows pandas 3 on both."""
    frame = _duplicated("broker_net")
    actual = tool.normalize_broker_transactions_daily(frame, "2026-09-02")
    if int(pd.__version__.split(".")[0]) < 3:
        with pytest.raises(AttributeError):
            legacy_normalize(frame.copy(), "2026-09-02")
        assert_identical(actual, legacy_normalize(frame.drop(columns="broker_net"), "2026-09-02"))
    else:
        assert_identical(actual, legacy_normalize(frame.copy(), "2026-09-02"))
