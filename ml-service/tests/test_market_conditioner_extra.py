"""mkt16: seven market columns derived from the sealed capture's breadth, close and foreign files."""
import hashlib
import io
import json
import math
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import polars as pl
import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / "ml-controller") not in sys.path:
    sys.path.append(str(ROOT / "ml-controller"))

from app import market_conditioner as mc
from app.formal_feature_contract import FEATURES131

EXTRA = ["limit_down_count", "limit_down_pct", "adl_value", "adl_trend_numeric", "bull_alignment_pct",
         "foreign_net_5d_market", "foreign_consecutive_sell"]
PRICE_ROOT = "cap/daily_price_full_vintage"
CHIP_ROOT = "cap/chip_diversity_full_vintage"


def sessions(n):
    return [str(date(2026, 1, 1) + timedelta(days=i)) for i in range(n)]


def mi_index(day, advance, decline, flat, limit_down, decline_cell=None, flat_label="持平"):
    rows = [["上漲(漲停)", "9,000(30)", f"{advance:,}(7)"],
            ["下跌(跌停)", "8,000(20)", decline_cell if decline_cell is not None else f"{decline:,}({limit_down})"],
            [flat_label, "1,000", f"{flat:,}"], ["未成交", "10", "3"]]
    return {"stat": "OK", "date": day.replace("-", ""), "tables": [
        {"fields": ["成交統計", "成交金額(元)"], "data": []},
        {"fields": ["類型", "整體市場", "股票"], "data": rows}]}


class Bucket:
    def __init__(self, values):
        self.values = values

    def blob(self, name):
        values = self.values

        class Blob:
            def download_as_bytes(self, **kw):
                return values[name]
        return Blob()


def _sha(raw):
    return hashlib.sha256(raw).hexdigest()


def _parquet(days, symbols, values):
    out = io.BytesIO()
    pl.DataFrame({"date": days, **{s: values[:, j] for j, s in enumerate(symbols)}}).write_parquet(out)
    return out.getvalue()


def capture(n=130, end=None, bodies=None, seed=3, vendor_null=0, thin_days=()):
    """A sealed capture (price manifest, MI_INDEX per day, close, foreign_net) truncated at `end`.

    vendor_null symbols a day carry no foreign value (ETF/preferred in the real capture); thin_days drop 22%."""
    rng = np.random.default_rng(seed)
    days = sessions(n)
    symbols = [str(1101 + j) for j in range(98)] + ["0050", "12345"]
    close = 50 * np.exp(np.cumsum(rng.normal(0, 0.03, size=(n, len(symbols))), axis=0))
    close[10, 0] = close[70, 1] = np.nan  # suspended days: out of the bull window, not a gap in the market
    foreign = rng.normal(0, 2e6, size=close.shape).round()
    counts = [(int(a), int(d), int(f), int(m)) for a, d, f, m in zip(
        rng.integers(200, 700, n), rng.integers(200, 700, n), rng.integers(50, 120, n), rng.integers(0, 15, n))]
    for i in range(n):
        dropped = int(0.22 * len(symbols)) if i in thin_days else vendor_null
        foreign[i, rng.permutation(len(symbols))[:dropped]] = np.nan
    keep = n if end is None else days.index(end) + 1
    days, close, foreign, counts = days[:keep], close[:keep], foreign[:keep], counts[:keep]
    values, sources = {}, []
    for i, day in enumerate(days):
        body = (bodies or {}).get(day) or mi_index(day, *counts[i])
        raw = json.dumps(body, ensure_ascii=False).encode()
        values[f"{PRICE_ROOT}/official_breadth/{day}.json"] = raw
        sources.append({"date": day, "sha256": _sha(raw)})
    close_raw, foreign_raw = _parquet(days, symbols, close), _parquet(days, symbols, foreign)
    manifest = json.dumps({"capture_id": "cap", "end_date": days[-1], "checksums": {"close": _sha(close_raw)}}).encode()
    breadth = json.dumps({"capture_id": "cap", "end": days[-1], "sources": sources}).encode()
    chip_manifest = json.dumps({"capture_id": "cap", "checksums": {"foreign_net": _sha(foreign_raw)}}).encode()
    values.update({f"{PRICE_ROOT}/manifest.json": manifest, f"{PRICE_ROOT}/training_breadth.json": breadth,
                   f"{PRICE_ROOT}/close.parquet": close_raw, f"{CHIP_ROOT}/manifest.json": chip_manifest,
                   f"{CHIP_ROOT}/foreign_net.parquet": foreign_raw})
    prep = {"price_capture": {"capture_id": "cap", "capture_manifest_path": f"{PRICE_ROOT}/manifest.json",
                              "capture_manifest_sha256": _sha(manifest), "checksums": {"close": _sha(close_raw)}},
            "institutional_capture": {"capture_id": "cap", "capture_manifest_path": f"{CHIP_ROOT}/manifest.json",
                                      "capture_manifest_sha256": _sha(chip_manifest),
                                      "checksums": {"foreign_net": _sha(foreign_raw)}},
            "global_capture": {"breadth_manifest_sha256": _sha(breadth), "history_sha256": "h" * 64}}
    return Bucket(values), prep, days


@pytest.fixture(autouse=True)
def small_market(monkeypatch):
    # 98 fixture stocks stand in for the ~1000 the Worker requires.
    monkeypatch.setattr(mc, "BULL_MIN_ELIGIBLE", 20)


def test_contract_declares_the_seven_columns_and_mkt16():
    declared = mc._declared()
    assert all(declared[n]["status"] == "available" and declared[n]["block"] == "capture_extra" for n in EXTRA)
    assert {declared[n]["status"] for n in ("us_hy_spread", "us_hy_spread_chg", "market_risk_score",
                                            "market_risk_level")} == {"excluded_with_reason"}
    names = mc.arm_feature_names("mkt16")
    assert names[:138] == mc.arm_feature_names("mkt9") and names[138:] == EXTRA and len(names) == 145
    assert {f"{short}_mkt16" for short in ("lgbm", "et", "tabm")} <= set(mc.LIFECYCLE_SLOTS)
    assert len(mc.LIFECYCLE_SLOTS) == 9


def test_mi_index_limit_down_is_read_from_the_decline_cell():
    assert mc.parse_limit_down(mi_index("2026-01-05", 1234, 456, 78, 9), "2026-01-05") == \
        {"advance": 1234, "decline": 456, "flat": 78, "limit_down": 9}
    row = mc.breadth_columns({"2026-01-05": {"advance": 500, "decline": 400, "flat": 100, "limit_down": 10}})
    assert row["2026-01-05"]["limit_down_count"] == 10 and row["2026-01-05"]["limit_down_pct"] == 0.01


@pytest.mark.parametrize("body, error", [
    (mi_index("2026-01-05", 500, 400, 100, 0, decline_cell="400"), "limit_down_format_unexpected"),
    (mi_index("2026-01-05", 500, 400, 100, 0, decline_cell="400()"), "limit_down_format_unexpected"),
    (mi_index("2026-01-05", 500, 400, 100, 0, flat_label="平盤"), "breadth_row_missing:持平"),
    (mi_index("2026-01-05", 500, 3, 100, 9), "limit_down_exceeds_decline"),
    ({**mi_index("2026-01-05", 500, 400, 100, 1), "date": "20260106"}, "breadth_table_invalid"),
])
def test_mi_index_parser_fails_closed(body, error):
    with pytest.raises(ValueError, match=error):
        mc.parse_limit_down(body, "2026-01-05")


def test_an_unexpected_mi_index_leaves_only_mkt16_unsupported(monkeypatch):
    from tests.test_market_conditioner import history_block
    bucket, prep, days = capture(bodies={"2026-03-01": mi_index("2026-03-01", 500, 400, 100, 0, decline_cell="400")})
    monkeypatch.setitem(mc.BLOCK_BUILDERS, "history", lambda b, m: history_block())
    blocks = mc.build_blocks(bucket, prep)
    assert "limit_down_format_unexpected:2026-03-01" in blocks["capture_extra"]["error"]
    conditioner, reason = mc.conditioner_for_arm("mkt16", blocks)
    assert conditioner is None and reason.startswith("market_conditioner_block_unavailable:capture_extra:")
    assert mc.conditioner_for_arm("mkt9", blocks)[1] is None and mc.conditioner_for_arm("mkt0", blocks)[1] is None


def test_adl_window_and_threshold_boundaries():
    def adl(nets):
        counts = {d: {"advance": 500 + v, "decline": 500, "flat": 0, "limit_down": 0}
                  for d, v in zip(sessions(len(nets)), nets)}
        return mc.breadth_columns(counts)[sessions(len(nets))[-1]]
    assert adl([0, 50, 0, 0])["adl_value"] is None and adl([0, 50, 0, 0])["adl_trend_numeric"] is None
    assert (adl([999, 50, 0, 0, 0])["adl_value"], adl([999, 50, 0, 0, 0])["adl_trend_numeric"]) == (1049.0, 0.0)
    assert adl([999, 51, 0, 0, 0])["adl_trend_numeric"] == 1.0
    assert adl([-999, -51, 0, 0, 0])["adl_trend_numeric"] == -1.0
    assert adl([-999, -50, 0, 0, 0])["adl_trend_numeric"] == 0.0
    # Only the last five sessions count.
    assert adl([10_000, 1, 1, 1, 1, 1])["adl_value"] == 5.0


def test_bull_alignment_follows_the_worker_sql(monkeypatch):
    monkeypatch.setattr(mc, "BULL_MIN_ELIGIBLE", 3)
    monkeypatch.setattr(mc, "BULL_MIN_SHARE", 0.7)
    days = sessions(61)
    up, down = np.linspace(10, 20, 61), np.linspace(20, 10, 61)
    gap = up.copy()
    gap[30] = np.nan
    symbols = ["1101", "1102", "1103", "1104", "0050", "12345"]
    close = np.column_stack([up, up, down, gap, up, up])
    value = mc.bull_alignment(days, symbols, close)
    # Eligible: 1101-1103 (1104 misses a day in the window; 0050 and 12345 are not 4-digit stocks).
    assert value[days[59]] == pytest.approx(2 / 3) and value[days[58]] is None
    assert value[days[60]] == pytest.approx(2 / 3)
    monkeypatch.setattr(mc, "BULL_MIN_SHARE", 0.8)  # 3 eligible of a 4-stock universe
    assert mc.bull_alignment(days, symbols, close)[days[59]] is None
    monkeypatch.setattr(mc, "BULL_MIN_SHARE", 0.7)
    monkeypatch.setattr(mc, "BULL_MIN_ELIGIBLE", 4)
    assert mc.bull_alignment(days, symbols, close)[days[59]] is None


@pytest.mark.parametrize("nets, streak", [
    ([-1, -1, -1, -1, -1], -5.0), ([-1, -1, -1, -1, 1], 1.0), ([-1, -1, -1, -1, 0], 0.0),
    ([-1, -1, -1, 1, -1], -1.0), ([1, -1, 2, -1, -1], -2.0), ([0, 0, 0, 0, 2], 1.0)])
def test_foreign_consecutive_sell_truth_table(nets, streak):
    days = sessions(5)
    close = np.ones((5, 1))
    shares = np.asarray(nets, dtype=float).reshape(-1, 1) * 1e8
    row = mc.foreign_columns(days, close, shares)[days[-1]]
    assert row == {"foreign_net_5d_market": float(sum(nets)), "foreign_consecutive_sell": streak}


def test_foreign_needs_five_covered_sessions():
    days = sessions(6)
    close = np.ones((6, 20))
    shares = np.ones((6, 20)) * 1e8
    shares[2, :3] = np.nan  # 17 of 20 traded symbols carry a foreign value: coverage 0.85
    out = mc.foreign_columns(days, close, shares)
    assert out[days[3]]["foreign_net_5d_market"] is None  # fewer than five sessions
    assert out[days[4]]["foreign_net_5d_market"] is None and out[days[5]]["foreign_net_5d_market"] is None
    shares[2, 1:3] = 1e8  # 19 of 20: coverage 0.95
    assert mc.foreign_columns(days, close, shares)[days[5]]["foreign_net_5d_market"] == 99.0


def test_build_extra_block_seals_the_seven_columns():
    bucket, prep, days = capture()
    block = mc.build_extra_block(bucket, prep)
    assert block["columns"] == [n for n in mc._declared() if n in EXTRA] and sorted(block["values"]) == days
    assert block["inputs"]["close_sha256"] == prep["price_capture"]["checksums"]["close"]
    bull = block["columns"].index("bull_alignment_pct")
    assert all(block["values"][d][bull] is None for d in days[:59]) and block["values"][days[59]][bull] is not None
    X = np.zeros((len(days), 131), dtype=np.float32)
    from tests.test_market_conditioner import history_block
    out, names, receipt = mc.apply_block(X, np.asarray(days), list(FEATURES131), {"arm": "mkt16", "blocks": {
        "history": history_block(days), "capture_extra": block}})
    assert names == mc.arm_feature_names("mkt16") and out.shape == (len(days), 145)
    assert math.isnan(out[0, names.index("bull_alignment_pct")])  # warm-up: NaN for the trainer, never zero
    assert receipt["null_filled_days"]["bull_alignment_pct"] == 59 and set(receipt["block_sha256"]) == {"history", "capture_extra"}


# PIT: truncating the capture at day d leaves every value up to d unchanged.
def test_pit_prefix_invariance_of_each_derivation():
    bucket, prep, days = capture()
    full = mc.build_extra_block(bucket, prep)["values"]
    for end in (days[-1], days[-2], days[-6], days[-10]):
        cut = mc.build_extra_block(*capture(end=end)[:2])["values"]
        assert sorted(cut) == days[:days.index(end) + 1]
        assert all(cut[d] == full[d] for d in cut)


def test_pit_prefix_invariance_day_by_day():
    rng = np.random.default_rng(5)
    days = sessions(90)
    close = 30 * np.exp(np.cumsum(rng.normal(0, 0.03, size=(90, 25)), axis=0))
    symbols = [str(2001 + j) for j in range(25)]
    foreign = rng.normal(0, 1e6, size=close.shape)
    counts = {d: {"advance": int(a), "decline": int(b), "flat": 50, "limit_down": 1}
              for d, a, b in zip(days, rng.integers(200, 700, 90), rng.integers(200, 700, 90))}
    full = (mc.breadth_columns(counts), mc.bull_alignment(days, symbols, close), mc.foreign_columns(days, close, foreign))
    for k in range(1, 91):
        cut = (mc.breadth_columns({d: counts[d] for d in days[:k]}), mc.bull_alignment(days[:k], symbols, close[:k]),
               mc.foreign_columns(days[:k], close[:k], foreign[:k]))
        for whole, part in zip(full, cut):
            assert part[days[k - 1]] == whole[days[k - 1]]


# Real capture shape (finlab-v4-daily-20261030): ~5.5% of symbols a day are vendor null in foreign_net,
# median coverage 0.945, with rare 0.78 days (here 6% and 22%). mkt16 must still be supported.
def test_vendor_null_foreign_values_keep_mkt16_supported(monkeypatch):
    from tests.test_market_conditioner import history_block
    bucket, prep, days = capture(vendor_null=6, thin_days={90})
    monkeypatch.setitem(mc.BLOCK_BUILDERS, "history", lambda b, m: history_block(days))
    blocks = mc.build_blocks(bucket, prep)
    assert not blocks["capture_extra"].get("error"), blocks["capture_extra"]
    assert mc.conditioner_for_arm("mkt16", blocks)[1] is None
    block = blocks["capture_extra"]
    net = block["columns"].index("foreign_net_5d_market")
    missing = [d for d in days if block["values"][d][net] is None]
    assert missing == days[:4] + days[90:95]  # warm-up, and the five windows holding the 0.78 day
    monkeypatch.setattr(mc, "FOREIGN_MIN_COVERAGE", 0.95)
    assert "_column:foreign_" in mc.build_blocks(bucket, prep)["capture_extra"]["error"]  # the old 0.95 kills mkt16


@pytest.mark.parametrize("tamper, error", [
    (lambda b, p: p["price_capture"]["checksums"].update(close="0" * 64), "capture_checksum_mismatch:close"),
    (lambda b, p: p["institutional_capture"]["checksums"].update(foreign_net="0" * 64),
     "capture_checksum_mismatch:foreign_net"),
    (lambda b, p: p["global_capture"].update(breadth_manifest_sha256="0" * 64), "breadth_manifest_mismatch"),
    (lambda b, p: p["institutional_capture"].update(capture_id="other"), "institutional_manifest_mismatch"),
    (lambda b, p: p["price_capture"].update(capture_manifest_sha256="0" * 64), "price_manifest_mismatch"),
    (lambda b, p: b.values.update({f"{PRICE_ROOT}/official_breadth/2026-02-01.json": b"{}"}), "breadth_checksum_mismatch"),
])
def test_every_input_is_bound_to_the_prep_manifest(tamper, error):
    bucket, prep, _ = capture()
    tamper(bucket, prep)
    with pytest.raises(ValueError, match=error):
        mc.build_extra_block(bucket, prep)
    blocks = mc.build_blocks(bucket, prep)
    assert error in blocks["capture_extra"]["error"]
    assert mc.conditioner_for_arm("mkt16", blocks)[0] is None
