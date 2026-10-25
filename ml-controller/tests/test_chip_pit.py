import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import polars as pl
import pytest

from services import chip_pit as cp
from services.formal_feature_contract import FEATURES131

ROOT = Path(__file__).resolve().parents[2]
DAYS = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-06"]


def tw(day, hm):
    h, m = map(int, hm.split(":"))
    return datetime.fromisoformat(day).replace(hour=h, minute=m, tzinfo=cp.TW).astimezone(timezone.utc)


def wide(days, values):
    return pl.DataFrame({"date": days, **{sid: col for sid, col in values.items()}})


def class_frame(cls, days, base, basis=cp.BASIS_RULE, observed_at=None, capture="cap", priority=0, stocks=("2330",)):
    fields = {f: wide(days, {s: [base * (i + 1) + j for i in range(len(days))] for j, s in enumerate(stocks)})
              for f in cp.CLASSES[cls]["fields"]}
    return cp.class_observations(fields, cls, capture_id=capture, basis=basis, observed_at=observed_at, priority=priority)


def rule_obs(days, stocks=("2330",)):
    out = {}
    for cls, base in (("institutional", 10.0), ("margin", 100.0), ("lending", 1000.0), ("turnover", 500.0)):
        out[cls] = cp.merge_observations([class_frame(cls, days, base, stocks=stocks)], cls)[0]
    return out


def test_contract_json_matches_module():
    contract = json.loads((ROOT / "data/feature_registry/chip_pit_feature_contract_v1.json").read_text(encoding="utf8"))
    assert contract["contract_version"] == cp.CONTRACT_VERSION
    assert contract["features"] == list(cp.FEATURES)
    assert contract["storage_prefix"] == cp.STORAGE_PREFIX
    for cls, spec in cp.CLASSES.items():
        assert tuple(contract["classes"][cls]["fields"]) == spec["fields"]
        assert contract["classes"][cls]["presumed_publication_tw"] == spec["publication_tw"]
        assert contract["classes"][cls]["source_lane"] == spec["lane"]
    assert len(FEATURES131) == 131 and not set(cp.FEATURES) & set(FEATURES131)


def test_rule_presumed_lags_margin_and_lending_past_the_evening_cutoff():
    panel, proof = cp.build_feature_panel(rule_obs(DAYS), DAYS, anchors={})
    assert panel["chip_institutional_data_date"].to_list() == DAYS
    for cls in ("margin", "lending"):
        assert panel[f"chip_{cls}_data_date"].to_list() == [None] + DAYS[:-1]
        assert proof["coverage"][cls]["same_day_rows"] == 0
    assert set(panel["chip_institutional_basis"].to_list()) == {cp.BASIS_RULE}
    # total net = 4 fields * 10*(i+1); volume = 500*(i+1)
    assert panel["chip_inst_total_net_vol_1"].to_list() == pytest.approx([0.08] * 4)


def test_rule_cutoff_is_the_evening_chain_schedule():
    jobs = json.loads((ROOT / "infra/gcp-scheduler-jobs.json").read_text(encoding="utf8"))
    chain = next(j for j in jobs["jobs"] if j["id"] == "evening-chain")
    minute, hour = chain["schedule"].split()[:2]
    assert jobs["timeZone"] == "UTC"
    assert cp.rule_cutoff("2026-07-01") == datetime(2026, 7, 1, int(hour), int(minute), tzinfo=timezone.utc)
    for cls in ("institutional", "turnover"):
        assert cp.presumed_available_at("2026-07-01", cls) <= cp.rule_cutoff("2026-07-01")
    for cls in ("margin", "lending"):
        assert cp.presumed_available_at("2026-07-01", cls) > cp.rule_cutoff("2026-07-01")
        assert cp.presumed_available_at("2026-07-01", cls) <= cp.rule_cutoff("2026-07-02")


def test_late_capture_is_not_usable_for_its_own_signal_day():
    anchors = {d: tw(d, "22:40") for d in DAYS}
    obs = rule_obs(DAYS)
    on_time = [class_frame("margin", [d], 100.0 + i, cp.BASIS_OBSERVED, anchors[d], capture=f"c{i}")
               for i, d in enumerate(DAYS) if d != "2026-07-02"]
    late = class_frame("margin", ["2026-07-02"], 200.0, cp.BASIS_OBSERVED, tw("2026-07-02", "23:30"), capture="retry")
    obs["margin"] = cp.merge_observations(on_time + [late], "margin")[0]
    panel, _ = cp.build_feature_panel(obs, DAYS, anchors)
    got = dict(zip(panel["signal_date"].to_list(), panel["chip_margin_data_date"].to_list()))
    assert got == {"2026-07-01": "2026-07-01", "2026-07-02": "2026-07-01",
                   "2026-07-03": "2026-07-03", "2026-07-06": "2026-07-06"}
    assert set(panel["chip_margin_basis"].to_list()) == {cp.BASIS_OBSERVED}


def test_window_waits_for_a_late_earlier_observation():
    anchors = {d: tw(d, "22:40") for d in DAYS}
    obs = rule_obs(DAYS)
    frames = [class_frame("lending", ["2026-07-01"], 1.0, cp.BASIS_OBSERVED, anchors["2026-07-01"], capture="a"),
              # 07-02 arrives only after the 07-03 freeze
              class_frame("lending", ["2026-07-02"], 2.0, cp.BASIS_OBSERVED, tw("2026-07-03", "23:00"), capture="b"),
              class_frame("lending", ["2026-07-03"], 3.0, cp.BASIS_OBSERVED, anchors["2026-07-03"], capture="c"),
              class_frame("lending", ["2026-07-06"], 4.0, cp.BASIS_OBSERVED, anchors["2026-07-06"], capture="d")]
    obs["lending"] = cp.merge_observations(frames, "lending")[0]
    panel, _ = cp.build_feature_panel(obs, DAYS, anchors)
    got = dict(zip(panel["signal_date"].to_list(), panel["chip_lending_data_date"].to_list()))
    assert got == {"2026-07-01": "2026-07-01", "2026-07-02": "2026-07-01",
                   "2026-07-03": "2026-07-01", "2026-07-06": "2026-07-06"}


def test_future_rows_never_reach_an_earlier_signal():
    obs = rule_obs(DAYS)
    panel, _ = cp.build_feature_panel(obs, DAYS[:2], anchors={})
    assert panel["chip_margin_data_date"].max() <= "2026-07-02"
    bad = panel.with_columns(pl.lit("2026-07-06").alias("chip_margin_data_date"))
    with pytest.raises(ValueError, match="chip_pit_future_data_date:margin"):
        cp.validate_panel(bad)


def test_observed_vintage_replaces_rule_rows_and_first_seen_wins():
    rule = class_frame("margin", ["2026-07-01", "2026-07-02"], 100.0, capture="bulk")
    first = class_frame("margin", ["2026-07-02"], 110.0, cp.BASIS_OBSERVED, tw("2026-07-02", "21:40"), capture="d1")
    revised = class_frame("margin", ["2026-07-02"], 120.0, cp.BASIS_OBSERVED, tw("2026-07-02", "23:10"), capture="d2")
    merged, proof = cp.merge_observations([rule, revised, first], "margin")
    day2 = merged.filter(pl.col("data_date") == "2026-07-02").row(0, named=True)
    assert (day2["margin_balance"], day2["source_capture_id"], day2["basis"]) == (110.0, "d1", cp.BASIS_OBSERVED)
    assert merged.filter(pl.col("data_date") == "2026-07-01")["basis"].to_list() == [cp.BASIS_RULE]
    assert proof["revised_after_first_seen"] == 1 and proof["observed_rows"] == 1


def test_unpublished_empty_table_is_not_an_observation():
    empty = cp.class_observations({f: wide(["2026-07-02"], {"2330": [None], "2317": [None]})
                                   for f in cp.CLASSES["margin"]["fields"]}, "margin", capture_id="2100",
                                  basis=cp.BASIS_OBSERVED, observed_at=tw("2026-07-02", "21:00"))
    assert empty.height == 0
    real = class_frame("margin", ["2026-07-02"], 100.0, cp.BASIS_OBSERVED, tw("2026-07-02", "22:40"), capture="2240")
    merged, _ = cp.merge_observations([empty, real], "margin")
    assert merged["source_capture_id"].to_list() == ["2240"]


def test_absent_stock_in_observed_table_stays_null_instead_of_stale():
    anchors = {d: tw(d, "22:40") for d in DAYS[:2]}
    obs = rule_obs(DAYS[:2], stocks=("2330", "2317"))
    d1 = cp.class_observations({f: wide(["2026-07-01"], {"2330": [5.0], "2317": [7.0]}) for f in cp.CLASSES["margin"]["fields"]},
                               "margin", capture_id="d1", basis=cp.BASIS_OBSERVED, observed_at=anchors["2026-07-01"])
    d2 = cp.class_observations({f: wide(["2026-07-02"], {"2330": [6.0], "2317": [None]}) for f in cp.CLASSES["margin"]["fields"]},
                               "margin", capture_id="d2", basis=cp.BASIS_OBSERVED, observed_at=anchors["2026-07-02"])
    obs["margin"] = cp.merge_observations([d1, d2], "margin")[0]
    panel, _ = cp.build_feature_panel(obs, DAYS[:2], anchors)
    row = panel.filter((pl.col("stock_id") == "2317") & (pl.col("signal_date") == "2026-07-02")).row(0, named=True)
    assert row["chip_margin_data_date"] == "2026-07-02"
    assert row["chip_margin_bal_chg_1"] is None and row["chip_short_margin_ratio"] is None
    kept = panel.filter((pl.col("stock_id") == "2330") & (pl.col("signal_date") == "2026-07-02")).row(0, named=True)
    assert kept["chip_margin_bal_chg_1"] == pytest.approx(0.2)


def test_feature_math_keeps_warmup_and_zero_denominators_null():
    days = [f"2026-07-{d:02d}" for d in range(1, 23)]
    obs = rule_obs(days)
    obs["turnover"] = cp.merge_observations([cp.class_observations(
        {"volume": wide(days, {"2330": [0.0] + [1000.0] * 21})}, "turnover", capture_id="v", basis=cp.BASIS_RULE)],
        "turnover")[0]
    rows = cp.class_feature_rows(obs["margin"], obs["turnover"], "margin")
    chg5 = rows["chip_margin_bal_chg_5"].to_list()
    assert chg5[:5] == [None] * 5 and chg5[5] == pytest.approx(600 / 100 - 1)
    vol20 = rows["chip_margin_bal_vol_20"].to_list()
    assert vol20[:19] == [None] * 19
    assert vol20[20] == pytest.approx(2100.0 * cp.MARGIN_LOT_SHARES / 1000.0)
    inst = cp.class_feature_rows(obs["institutional"], obs["turnover"], "institutional")
    assert inst["chip_inst_total_net_vol_1"].to_list()[0] is None  # zero volume
    assert all(v is None or math.isfinite(v) for v in inst["chip_inst_total_net_vol_5"].to_list())


def test_late_recovery_cutoff_is_clamped_to_the_next_signal():
    cutoffs, clamped = cp.signal_cutoffs(["2026-07-09", "2026-07-10"], {"2026-07-09": tw("2026-07-11", "23:28")})
    assert cutoffs == [cp.rule_cutoff("2026-07-10"), cp.rule_cutoff("2026-07-10")] and clamped == 1


def test_attach_chip_block_aligns_rows_and_fills_missing_with_nan():
    panel, _ = cp.build_feature_panel(rule_obs(DAYS), DAYS, anchors={})
    X = np.arange(6, dtype=np.float32).reshape(3, 2)
    out, names, proof = cp.attach_chip_block(X, ["a", "b"], ["2026-07-02", "2026-07-01", "2026-07-02"],
                                             ["2330", "2330", "9999"], panel)
    assert out.shape == (3, 2 + len(cp.FEATURES)) and names[2:] == list(cp.FEATURES)
    col = names.index("chip_inst_total_net_vol_1")
    assert out[0, col] == pytest.approx(0.08) and out[1, col] == pytest.approx(0.08) and np.isnan(out[2, col])
    assert proof["feature_coverage"]["chip_inst_total_net_vol_1"] == pytest.approx(2 / 3)
    with pytest.raises(ValueError, match="overlap"):
        cp.attach_chip_block(X, ["a", cp.FEATURES[0]], ["2026-07-01"] * 3, ["2330"] * 3, panel)


class _Blob:
    def __init__(self, store, name):
        self.store, self.name = store, name

    def upload_from_string(self, raw, content_type=None, if_generation_match=None):
        if if_generation_match == 0 and self.name in self.store:
            raise RuntimeError("exists")
        self.store[self.name] = raw if isinstance(raw, bytes) else raw.encode()

    def download_as_bytes(self):
        return self.store[self.name]


class _Bucket:
    def __init__(self):
        self.store = {}

    def blob(self, name):
        return _Blob(self.store, name)


def _write_capture(run_dir, day):
    for cls, spec in cp.CLASSES.items():
        root = run_dir / "raw" / spec["lane"]
        root.mkdir(parents=True, exist_ok=True)
        for f in spec["fields"]:
            wide([day], {"2330": [1.0], "2317": [None]}).write_parquet(root / f"{f}.parquet")


def test_record_daily_capture_is_immutable_and_reports_same_day_rows(tmp_path):
    _write_capture(tmp_path, "2026-10-26")
    bucket = _Bucket()
    now = tw("2026-10-26", "22:41")
    result = cp.record_daily_capture(run_dir=tmp_path, bucket=bucket, business_date="2026-10-26",
                                     capture_id="finlab-v4-daily-x", capture_ready=True, now=lambda: now)
    receipt = json.loads(bucket.store[result["receipt_path"]])
    assert receipt["observed_at"] == now.isoformat() and receipt["capture_ready"] is True
    assert receipt["classes"]["lending"]["business_date_non_null"] == 1
    lending = pl.read_parquet(bucket.store["chip-pit/v1/daily/2026-10-26/finlab-v4-daily-x/lending.parquet"])
    assert lending["basis"].unique().to_list() == [cp.BASIS_OBSERVED] and lending.height == 2
    # The trailing window wins over the target-date lane file when present.
    (tmp_path / "raw/chip_pit_window").mkdir(parents=True)
    for f in cp.CLASSES["margin"]["fields"]:
        wide(["2026-10-23", "2026-10-26"], {"2330": [2.0, 1.0]}).write_parquet(tmp_path / f"raw/chip_pit_window/{f}.parquet")
    second = cp.record_daily_capture(run_dir=tmp_path, bucket=bucket, business_date="2026-10-26",
                                     capture_id="finlab-v4-daily-y", capture_ready=True, now=lambda: now)
    assert json.loads(bucket.store[second["receipt_path"]])["classes"]["margin"]["data_dates"] == ["2026-10-23", "2026-10-26"]
    with pytest.raises(RuntimeError, match="exists"):
        cp.record_daily_capture(run_dir=tmp_path, bucket=bucket, business_date="2026-10-26",
                                capture_id="finlab-v4-daily-x", capture_ready=True, now=lambda: now)


def test_load_panel_rejects_checksum_mismatch():
    panel, proof = cp.build_feature_panel(rule_obs(DAYS), DAYS, anchors={})
    raw, manifest = cp.panel_manifest(panel, proof, sources={})
    bucket = _Bucket()
    bucket.store["chip-pit/v1/features/b/features.parquet"] = raw
    bucket.store["chip-pit/v1/features/b/manifest.json"] = json.dumps(manifest).encode()
    loaded, _ = cp.load_panel(bucket, "chip-pit/v1/features/b/manifest.json")
    assert loaded.equals(panel)
    bucket.store["chip-pit/v1/features/b/features.parquet"] = raw + b"x"
    with pytest.raises(ValueError, match="checksum"):
        cp.load_panel(bucket, "chip-pit/v1/features/b/manifest.json")
