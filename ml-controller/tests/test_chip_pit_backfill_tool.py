import io
import json
from datetime import datetime, timezone

import polars as pl

from services import chip_pit as cp
from tools import chip_pit_backfill as tool


class _Blob:
    def __init__(self, bucket, name):
        self.bucket, self.name = bucket, name

    @property
    def time_created(self):
        return self.bucket.times[self.name]

    def download_as_bytes(self):
        return self.bucket.store[self.name]


class _Listing(list):
    prefixes = set()


class _Bucket:
    def __init__(self):
        self.store, self.times = {}, {}

    def put(self, name, raw, at):
        self.store[name], self.times[name] = raw, at

    def blob(self, name):
        return _Blob(self, name)

    def list_blobs(self, prefix, delimiter=None):
        names = sorted(n for n in self.store if n.startswith(prefix))
        if delimiter:
            out = _Listing()
            out.prefixes = {prefix + n[len(prefix):].split(delimiter, 1)[0] + delimiter for n in names}
            return out
        return [_Blob(self, n) for n in names]


def _parquet(days, value):
    buf = io.BytesIO()
    pl.DataFrame({"date": days, "2330": [value] * len(days)}).write_parquet(buf)
    return buf.getvalue()


def _capture(bucket, capture, days, at, *, ready=True, classes=tuple(cp.CLASSES)):
    for cls in classes:
        for path in tool._class_paths(capture, cls).values():
            bucket.put(path, _parquet(days, 1.0), at)
    manifest = {"source_end_date": days[-1], "backfill_status": "ready" if ready else "partial_failed"}
    bucket.put(f"{tool.CAPTURE_PREFIX}/{capture}/manifest.json", json.dumps(manifest).encode(), at)


def _utc(day, hm):
    h, m = map(int, hm.split(":"))
    return datetime.fromisoformat(day).replace(hour=h, minute=m, tzinfo=cp.TW).astimezone(timezone.utc)


def test_daily_capture_is_observed_at_its_write_time_and_anchor_needs_all_chip_classes():
    bucket = _Bucket()
    _capture(bucket, "finlab-v4-daily-20261026-1", ["2026-10-26"], _utc("2026-10-26", "21:10"),
             classes=("institutional", "turnover"))
    _capture(bucket, "finlab-v4-daily-20261026-2", ["2026-10-26"], _utc("2026-10-26", "22:45"))
    _capture(bucket, "finlab-v4-daily-20261027-1", ["2026-10-27"], _utc("2026-10-27", "22:30"), ready=False)
    captures = tool.daily_captures(bucket, "2026-10-01", "2026-10-31")
    assert captures == ["finlab-v4-daily-20261026-1", "finlab-v4-daily-20261026-2", "finlab-v4-daily-20261027-1"]
    daily = [tool.daily_observations(bucket, c) for c in captures]
    obs, meta = daily[0]
    assert sorted(obs) == ["institutional", "turnover"]
    assert obs["institutional"]["basis"].unique().to_list() == [cp.BASIS_OBSERVED]
    assert obs["institutional"]["available_at"][0] == _utc("2026-10-26", "21:10")
    anchors = tool.anchors_from([m for _, m in daily])
    # The 21:10 capture fed L3 without margin/lending; a not-ready capture never anchors.
    assert anchors == {"2026-10-26": _utc("2026-10-26", "21:10")}
    merged = {cls: cp.merge_observations([o[cls] for o, _ in daily if cls in o], cls)[0] for cls in cp.CLASSES}
    panel, _ = cp.build_feature_panel(merged, ["2026-10-26", "2026-10-27"], anchors)
    got = panel.select("signal_date", "chip_institutional_data_date", "chip_margin_data_date").rows()
    # 10-27 has no ready capture: its rule cutoff (21:00) precedes the 22:30 capture.
    assert got == [("2026-10-26", "2026-10-26", None), ("2026-10-27", "2026-10-26", "2026-10-26")]


def test_next_day_window_logs_a_table_published_after_the_evening_capture():
    bucket = _Bucket()
    day1, day2 = "2026-10-26", "2026-10-27"
    _capture(bucket, "finlab-v4-daily-20261026-1", [day1], _utc(day1, "21:01"), classes=("institutional", "turnover"))
    _capture(bucket, "finlab-v4-daily-20261027-1", [day2], _utc(day2, "21:01"), classes=("institutional", "turnover"))
    for f in cp.lane_fields("chip_diversity"):  # day-2 window holds day-1 margin/lending only
        if f not in cp.CLASSES["institutional"]["fields"]:
            bucket.put(f"{tool.CAPTURE_PREFIX}/finlab-v4-daily-20261027-1/raw/chip_pit_window/{f}.parquet",
                       _parquet([day1], 3.0), _utc(day2, "21:01"))
    daily = [tool.daily_observations(bucket, c) for c in tool.daily_captures(bucket, day1, day2)]
    merged = {cls: cp.merge_observations([o[cls] for o, _ in daily if cls in o], cls)[0] for cls in cp.CLASSES}
    panel, _ = cp.build_feature_panel(merged, [day1, day2], tool.anchors_from([m for _, m in daily]))
    got = panel.select("signal_date", "chip_margin_data_date", "chip_lending_data_date").rows()
    assert got == [(day1, None, None), (day2, day1, day1)]


def test_finlab_daily_window_writer_keeps_trailing_sessions(tmp_path):
    import pandas as pd
    from tools import finlab_v4_remote_backfill as finlab
    days = pd.bdate_range("2026-09-01", periods=30)
    frame = pd.DataFrame({"2330": range(30)}, index=days.rename("date"), dtype=float)
    finlab.write_chip_pit_window({"margin_balance": frame, "volume": frame}, lane="chip_diversity",
                                 run_dir=tmp_path, end_date=str(days[-2].date()))
    out = pl.read_parquet(tmp_path / "raw/chip_pit_window/margin_balance.parquet")
    assert out.height == cp.CAPTURE_WINDOW_SESSIONS and str(out["date"].max())[:10] == str(days[-2].date())
    assert not (tmp_path / "raw/chip_pit_window/volume.parquet").exists()  # volume belongs to daily_price


def test_bulk_capture_is_rule_presumed_and_gaps_are_reported():
    bucket = _Bucket()
    _capture(bucket, "bulk", ["2023-07-03", "2023-07-04"], _utc("2026-07-02", "08:00"))
    obs = tool.bulk_observations(bucket, "bulk", 0, "2023-07-01", "2023-07-31")
    assert set(obs["lending"]["basis"].to_list()) == {cp.BASIS_RULE}
    assert obs["lending"]["available_at"][0] == cp.presumed_available_at("2023-07-03", "lending")
    merged = {cls: cp.merge_observations([frame], cls)[0] for cls, frame in obs.items()}
    gaps = tool.coverage_gaps(merged, ["2023-06-30", "2023-07-03", "2023-07-04"])
    assert gaps["lending"]["missing_sessions"] == 1 and gaps["lending"]["missing_first"] == ["2023-06-30"]
