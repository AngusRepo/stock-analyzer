"""Point-in-time chip observations (法人／融資券／借券) and the chip challenger feature block.

Only the chip challenger consumes this contract; the 131 formal contract is untouched.
An observation is usable for signal date s only when it was available before the
evening L3 payload freeze of s (see data/feature_registry/chip_pit_feature_contract_v1.json).
"""
from __future__ import annotations

import hashlib
import io
import json
from datetime import datetime, timedelta, timezone

import numpy as np
import polars as pl

from services.formal_feature_contract import FEATURES131

CONTRACT_VERSION = "chip-pit-features-v1"
OBSERVATION_SCHEMA = "chip-pit-observations-v1"
PANEL_SCHEMA = "chip-pit-feature-panel-v1"
DAILY_RECEIPT_SCHEMA = "chip-pit-daily-receipt-v1"
STORAGE_PREFIX = "chip-pit/v1"
TW = timezone(timedelta(hours=8))
BASIS_OBSERVED = "observed_capture"
BASIS_RULE = "rule_presumed"
# rule_same_day: a rule-presumed row (no capture evidence) may serve its own data date. FinLab lags the
# exchange (institutional rows were missing from 3/65 observed 21:00 captures), so a chip row without a
# capture holding it by the cutoff serves from the next signal date on. Turnover is the daily price lane.
CLASSES = {
    "institutional": {"lane": "chip_diversity", "publication_tw": "17:00", "rule_same_day": False,
                      "fields": ("foreign_net", "trust_net", "dealer_self_net", "dealer_hedge_net")},
    "margin": {"lane": "chip_diversity", "publication_tw": "21:30", "rule_same_day": False,
               "fields": ("margin_balance", "short_balance")},
    "lending": {"lane": "chip_diversity", "publication_tw": "21:30", "rule_same_day": False,
                "fields": ("security_lending_sell_balance", "security_lending_balance")},
    "turnover": {"lane": "daily_price", "publication_tw": "14:30", "rule_same_day": True, "fields": ("volume",)},
}
CHIP_CLASSES = ("institutional", "margin", "lending")
# infra/gcp-scheduler-jobs.json evening-chain "45 13 * * 1-5" UTC (test-bound); its FinLab capture is the L3 input.
RULE_CUTOFF_TW = "21:45"
# MI_MARGN balances are lots; volume and lending balances are shares.
MARGIN_LOT_SHARES = 1000.0
# Longest rolling window; a feature row waits for every observation inside it.
WINDOW = 20
# Each daily capture re-observes this many trailing sessions, so late vendor tables are still logged.
CAPTURE_WINDOW_SESSIONS = WINDOW + 1
FEATURES_BY_CLASS = {
    "institutional": ("chip_inst_foreign_net_vol_5", "chip_inst_foreign_net_vol_20", "chip_inst_trust_net_vol_5",
                      "chip_inst_trust_net_vol_20", "chip_inst_dealer_net_vol_5", "chip_inst_total_net_vol_1",
                      "chip_inst_total_net_vol_5", "chip_inst_total_net_vol_20"),
    "margin": ("chip_margin_bal_chg_1", "chip_margin_bal_chg_5", "chip_margin_bal_chg_20", "chip_margin_bal_vol_20",
               "chip_short_bal_chg_5", "chip_short_bal_chg_20", "chip_short_bal_vol_20", "chip_short_margin_ratio"),
    "lending": ("chip_sbl_sell_bal_chg_5", "chip_sbl_sell_bal_chg_20", "chip_sbl_sell_bal_vol_20",
                "chip_sbl_bal_chg_5", "chip_sbl_bal_chg_20"),
}
FEATURES = tuple(name for cls in CHIP_CLASSES for name in FEATURES_BY_CLASS[cls])
FEATURES_SHA256 = hashlib.sha256(json.dumps(list(FEATURES), separators=(",", ":")).encode()).hexdigest()
if set(FEATURES) & set(FEATURES131):
    raise RuntimeError("chip_pit_features_overlap_formal131")

_TS = pl.Datetime("us", "UTC")
_KEYS = ["stock_id", "data_date"]


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _parquet_bytes(frame: pl.DataFrame) -> bytes:
    buf = io.BytesIO()
    frame.write_parquet(buf, compression="zstd")
    return buf.getvalue()


def lane_fields(lane: str) -> tuple[str, ...]:
    return tuple(f for spec in CLASSES.values() if spec["lane"] == lane for f in spec["fields"])


def presumed_available_at(data_date: str, cls: str) -> datetime:
    hour, minute = map(int, CLASSES[cls]["publication_tw"].split(":"))
    day = datetime.fromisoformat(data_date)
    return day.replace(hour=hour, minute=minute, tzinfo=TW).astimezone(timezone.utc)


def rule_cutoff(signal_date: str) -> datetime:
    """Without an observed capture, L3 for s reads the FinLab capture taken when evening-chain fires."""
    hour, minute = map(int, RULE_CUTOFF_TW.split(":"))
    return datetime.fromisoformat(signal_date).replace(hour=hour, minute=minute, tzinfo=TW).astimezone(timezone.utc)


def signal_cutoffs(signal_dates: list[str], anchors: dict[str, datetime]) -> tuple[list[datetime], int]:
    """anchors: business date -> write time of its first ready daily capture (observed L3 input).

    A late recovery run can freeze s after s+1 froze; s then takes the earlier cutoff, which only
    removes information. Returns (cutoffs, clamped_count)."""
    cutoffs = [anchors[s].astimezone(timezone.utc) if s in anchors else rule_cutoff(s) for s in signal_dates]
    clamped = 0
    for i in range(len(cutoffs) - 2, -1, -1):
        if cutoffs[i] > cutoffs[i + 1]:
            cutoffs[i] = cutoffs[i + 1]
            clamped += 1
    return cutoffs, clamped


def wide_to_long(wide: pl.DataFrame, field: str) -> pl.DataFrame:
    """FinLab wide frame (date column + one column per stock) -> stock_id, data_date, field."""
    if "date" not in wide.columns:
        raise ValueError("chip_pit_wide_date_missing:" + field)
    stocks = [c for c in wide.columns if c != "date"]
    out = (wide.select(pl.col("date").cast(pl.String).str.slice(0, 10).alias("data_date"),
                       *[pl.col(c).cast(pl.Float64) for c in stocks])
           .unpivot(index="data_date", on=stocks, variable_name="stock_id", value_name=field)
           .with_columns(pl.col(field).fill_nan(None)))
    if out.select(pl.col(field).is_infinite().any()).item():
        raise ValueError("chip_pit_nonfinite:" + field)
    return out.select(_KEYS + [field])


def class_observations(fields: dict[str, pl.DataFrame], cls: str, *, capture_id: str, basis: str,
                       observed_at: datetime | None = None, priority: int = 0,
                       start: str | None = None, end: str | None = None) -> pl.DataFrame:
    """One capture's rows for one class. Stocks absent from a published table stay as null rows,
    so stale values never carry forward."""
    names = CLASSES[cls]["fields"]
    missing = [f for f in names if f not in fields]
    if missing:
        raise ValueError(f"chip_pit_class_fields_missing:{cls}:{','.join(missing)}")
    long = None
    for name in names:
        part = wide_to_long(fields[name], name)
        long = part if long is None else long.join(part, on=_KEYS, how="full", coalesce=True)
    # A table that is null for every stock was not published yet (vendor "empty"); it observes nothing.
    published = (long.group_by("data_date").agg(pl.any_horizontal([pl.col(n).is_not_null() for n in names]).any().alias("_p"))
                 .filter(pl.col("_p"))["data_date"])
    long = long.filter(pl.col("data_date").is_in(published.to_list()))
    if start:
        long = long.filter(pl.col("data_date") >= start)
    if end:
        long = long.filter(pl.col("data_date") <= end)
    if basis == BASIS_OBSERVED:
        if observed_at is None:
            raise ValueError("chip_pit_observed_at_missing")
        available = pl.lit(observed_at.astimezone(timezone.utc)).cast(_TS)
    elif basis == BASIS_RULE:
        days = long["data_date"].unique().to_list()
        available = pl.col("data_date").replace_strict({d: presumed_available_at(d, cls) for d in days}, return_dtype=_TS)
    else:
        raise ValueError("chip_pit_basis_unknown:" + str(basis))
    return (long.with_columns(available.alias("available_at"), pl.lit(basis).alias("basis"),
                              pl.lit(capture_id).alias("source_capture_id"), pl.lit(priority).alias("source_priority"))
            .select(_KEYS + list(names) + ["available_at", "basis", "source_capture_id", "source_priority"]))


def merge_observations(frames: list[pl.DataFrame], cls: str) -> tuple[pl.DataFrame, dict]:
    """First observed vintage wins; dates seen by an observed capture drop every rule-presumed row."""
    names = list(CLASSES[cls]["fields"])
    rows = pl.concat(frames, how="vertical")
    observed_days = rows.filter(pl.col("basis") == BASIS_OBSERVED)["data_date"].unique()
    rows = rows.filter((pl.col("basis") == BASIS_OBSERVED) | ~pl.col("data_date").is_in(observed_days.to_list()))
    ranked = rows.sort(_KEYS + ["available_at", "source_priority"])
    chosen = ranked.group_by(_KEYS, maintain_order=True).first()
    revised = (ranked.group_by(_KEYS).agg([pl.col(n).drop_nulls().n_unique().alias(n) for n in names])
               .filter(pl.any_horizontal([pl.col(n) > 1 for n in names])).height)
    proof = {"rows": chosen.height, "observed_rows": int((chosen["basis"] == BASIS_OBSERVED).sum()),
             "rule_presumed_rows": int((chosen["basis"] == BASIS_RULE).sum()),
             "revised_after_first_seen": revised,
             "date_min": chosen["data_date"].min(), "date_max": chosen["data_date"].max()}
    return chosen.sort(_KEYS), proof


def _div(num: pl.Expr, den: pl.Expr) -> pl.Expr:
    return pl.when(den.is_not_null() & (den != 0)).then(num / den).otherwise(None)


def _sum(col: str, w: int) -> pl.Expr:
    return pl.col(col).rolling_sum(w, min_samples=w).over("stock_id")


def _chg(col: str, w: int) -> pl.Expr:
    return _div(pl.col(col), pl.col(col).shift(w).over("stock_id")) - 1


def _vol_mean(w: int) -> pl.Expr:
    return pl.col("volume").rolling_mean(w, min_samples=w).over("stock_id")


def class_feature_rows(obs: pl.DataFrame, turnover: pl.DataFrame, cls: str) -> pl.DataFrame:
    """Rolling features per data_date over each stock's own sessions; nulls never become zeros."""
    vol = turnover.select(_KEYS + ["volume", pl.col("available_at").alias("_vol_available_at")])
    frame = obs.join(vol, on=_KEYS, how="left").sort(_KEYS)
    if cls == "institutional":
        frame = frame.with_columns(
            (pl.col("dealer_self_net") + pl.col("dealer_hedge_net")).alias("_dealer_net"),
            (pl.col("foreign_net") + pl.col("trust_net") + pl.col("dealer_self_net")
             + pl.col("dealer_hedge_net")).alias("_total_net"))
        spec = {"chip_inst_foreign_net_vol_5": ("foreign_net", 5), "chip_inst_foreign_net_vol_20": ("foreign_net", 20),
                "chip_inst_trust_net_vol_5": ("trust_net", 5), "chip_inst_trust_net_vol_20": ("trust_net", 20),
                "chip_inst_dealer_net_vol_5": ("_dealer_net", 5), "chip_inst_total_net_vol_1": ("_total_net", 1),
                "chip_inst_total_net_vol_5": ("_total_net", 5), "chip_inst_total_net_vol_20": ("_total_net", 20)}
        exprs = [_div(_sum(src, w), _sum("volume", w)).alias(name) for name, (src, w) in spec.items()]
    elif cls == "margin":
        exprs = [_chg("margin_balance", 1).alias("chip_margin_bal_chg_1"),
                 _chg("margin_balance", 5).alias("chip_margin_bal_chg_5"),
                 _chg("margin_balance", 20).alias("chip_margin_bal_chg_20"),
                 _div(pl.col("margin_balance") * MARGIN_LOT_SHARES, _vol_mean(20)).alias("chip_margin_bal_vol_20"),
                 _chg("short_balance", 5).alias("chip_short_bal_chg_5"),
                 _chg("short_balance", 20).alias("chip_short_bal_chg_20"),
                 _div(pl.col("short_balance") * MARGIN_LOT_SHARES, _vol_mean(20)).alias("chip_short_bal_vol_20"),
                 _div(pl.col("short_balance"), pl.col("margin_balance")).alias("chip_short_margin_ratio")]
    elif cls == "lending":
        exprs = [_chg("security_lending_sell_balance", 5).alias("chip_sbl_sell_bal_chg_5"),
                 _chg("security_lending_sell_balance", 20).alias("chip_sbl_sell_bal_chg_20"),
                 _div(pl.col("security_lending_sell_balance"), _vol_mean(20)).alias("chip_sbl_sell_bal_vol_20"),
                 _chg("security_lending_balance", 5).alias("chip_sbl_bal_chg_5"),
                 _chg("security_lending_balance", 20).alias("chip_sbl_bal_chg_20")]
    else:
        raise ValueError("chip_pit_feature_class_unknown:" + cls)
    row_available = pl.max_horizontal(pl.col("available_at").dt.epoch("us"),
                                      pl.col("_vol_available_at").dt.epoch("us"))
    return (frame.with_columns(exprs)
            .with_columns(row_available.alias("_row_available_us"))
            .with_columns(pl.col("_row_available_us").rolling_max(WINDOW + 1, min_samples=1).over("stock_id")
                          .alias("window_available_us"))
            .select(_KEYS + list(FEATURES_BY_CLASS[cls]) + ["window_available_us", "basis"]))


def select_for_signals(rows: pl.DataFrame, cls: str, signal_dates: list[str], cutoffs: list[datetime]) -> pl.DataFrame:
    """For each (stock, s): latest data_date <= s whose whole window was available by cutoff(s)."""
    if len(signal_dates) != len(cutoffs) or signal_dates != sorted(signal_dates):
        raise ValueError("chip_pit_signal_calendar_invalid")
    cut_us = np.asarray([int(c.timestamp() * 1_000_000) for c in cutoffs], dtype=np.int64)
    days = np.asarray(signal_dates)
    data_days = np.asarray(rows["data_date"].to_list(), dtype=days.dtype)
    d_idx = np.searchsorted(days, data_days, side="left")
    if not CLASSES[cls]["rule_same_day"]:
        # Same-day use needs a capture holding the row by cutoff(s); a rule-presumed row has none.
        presumed = (rows["basis"] == BASIS_RULE).to_numpy()
        d_idx = np.where(presumed, np.searchsorted(days, data_days, side="right"), d_idx)
    avail = rows["window_available_us"].fill_null(np.iinfo(np.int64).max).to_numpy()
    a_idx = np.searchsorted(cut_us, avail, side="left")
    first = np.maximum(d_idx, a_idx)
    usable = rows.with_columns(pl.Series("_first_signal", first, dtype=pl.Int64)).filter(
        pl.col("_first_signal") < len(signal_dates))
    # Frontier rows: each one raises the stock's newest usable data_date.
    frontier = (usable.sort(["stock_id", "_first_signal", "data_date"])
                .with_columns(pl.col("data_date").str.to_date().alias("_day"))
                .with_columns(pl.col("_day").cum_max().over("stock_id").alias("_newest"))
                .filter(pl.col("_day") == pl.col("_newest"))
                .unique(["stock_id", "_first_signal"], keep="last", maintain_order=True)
                .sort(["stock_id", "_first_signal"]))
    grid = (pl.DataFrame({"stock_id": frontier["stock_id"].unique().sort()})
            .join(pl.DataFrame({"_signal": np.arange(len(signal_dates), dtype=np.int64),
                                "signal_date": signal_dates}), how="cross")
            .sort(["stock_id", "_signal"]))
    picked = grid.join_asof(frontier, left_on="_signal", right_on="_first_signal", by="stock_id",
                            strategy="backward", check_sortedness=False)
    return (picked.filter(pl.col("data_date").is_not_null())
            .select(["stock_id", "signal_date", *FEATURES_BY_CLASS[cls],
                     pl.col("data_date").alias(f"chip_{cls}_data_date"), pl.col("basis").alias(f"chip_{cls}_basis")]))


def build_feature_panel(observations: dict[str, pl.DataFrame], signal_dates: list[str],
                        anchors: dict[str, datetime]) -> tuple[pl.DataFrame, dict]:
    """observations: merged frames for the three chip classes plus turnover."""
    cutoffs, clamped = signal_cutoffs(signal_dates, anchors)
    panel = None
    coverage = {}
    for cls in CHIP_CLASSES:
        part = select_for_signals(class_feature_rows(observations[cls], observations["turnover"], cls),
                                  cls, signal_dates, cutoffs)
        coverage[cls] = {"rows": part.height, "same_day_rows": int((part[f"chip_{cls}_data_date"] == part["signal_date"]).sum())}
        panel = part if panel is None else panel.join(part, on=["stock_id", "signal_date"], how="full", coalesce=True)
    panel = panel.select(["stock_id", "signal_date", *FEATURES,
                          *[c for cls in CHIP_CLASSES for c in (f"chip_{cls}_data_date", f"chip_{cls}_basis")]]
                         ).sort(["signal_date", "stock_id"])
    validate_panel(panel)
    proof = {"schema_version": PANEL_SCHEMA, "contract_version": CONTRACT_VERSION, "features": list(FEATURES),
             "features_sha256": FEATURES_SHA256, "signal_date_min": signal_dates[0], "signal_date_max": signal_dates[-1],
             "observed_anchor_days": sorted(d for d in anchors if d in set(signal_dates)), "clamped_cutoffs": clamped,
             "rule_cutoff_tw": RULE_CUTOFF_TW, "rule_same_day": {c: CLASSES[c]["rule_same_day"] for c in CHIP_CLASSES},
             "coverage": coverage,
             "feature_non_null": {f: int(panel[f].is_not_null().sum()) for f in FEATURES}, "rows": panel.height}
    return panel, proof


def validate_panel(panel: pl.DataFrame) -> None:
    expected = ["stock_id", "signal_date", *FEATURES]
    if panel.columns[:len(expected)] != expected:
        raise ValueError("chip_pit_panel_columns_mismatch")
    if panel.select(pl.struct("stock_id", "signal_date").is_duplicated().any()).item():
        raise ValueError("chip_pit_panel_duplicate_keys")
    for cls in CHIP_CLASSES:
        col = f"chip_{cls}_data_date"
        if panel.filter(pl.col(col).is_not_null() & (pl.col(col) > pl.col("signal_date"))).height:
            raise ValueError("chip_pit_future_data_date:" + cls)


def panel_manifest(panel: pl.DataFrame, proof: dict, *, sources: dict) -> tuple[bytes, dict]:
    raw = _parquet_bytes(panel)
    return raw, {**proof, "panel_file": "features.parquet", "panel_sha256": _sha(raw), "sources": sources}


def load_panel(bucket, manifest_path: str) -> tuple[pl.DataFrame, dict]:
    """W1 entry: verified panel from GCS."""
    manifest = json.loads(bucket.blob(manifest_path).download_as_bytes())
    if (manifest.get("schema_version") != PANEL_SCHEMA or manifest.get("contract_version") != CONTRACT_VERSION
            or manifest.get("features_sha256") != FEATURES_SHA256 or manifest.get("rule_cutoff_tw") != RULE_CUTOFF_TW):
        raise ValueError("chip_pit_panel_contract_mismatch")
    raw = bucket.blob(manifest_path.rsplit("/", 1)[0] + "/" + manifest["panel_file"]).download_as_bytes()
    if _sha(raw) != manifest.get("panel_sha256"):
        raise ValueError("chip_pit_panel_checksum_mismatch")
    panel = pl.read_parquet(io.BytesIO(raw))
    validate_panel(panel)
    return panel, manifest


def attach_chip_block(X: np.ndarray, feature_names: list[str], signal_dates, symbols,
                      panel: pl.DataFrame) -> tuple[np.ndarray, list[str], dict]:
    """Append the chip block to an existing prep matrix row-for-row; absent keys become NaN."""
    if len(X) != len(signal_dates) or len(X) != len(symbols):
        raise ValueError("chip_pit_attach_length_mismatch")
    if set(feature_names) & set(FEATURES):
        raise ValueError("chip_pit_attach_feature_overlap")
    validate_panel(panel)
    # Prep symbols may carry a venue suffix (2330.TW); the vendor panel keys on the bare code.
    keys = pl.DataFrame({"stock_id": [str(s).split(".")[0] for s in symbols], "signal_date": [str(d)[:10] for d in signal_dates],
                         "_row": np.arange(len(X), dtype=np.int64)})
    block = (keys.join(panel.select(["stock_id", "signal_date", *FEATURES]), on=["stock_id", "signal_date"], how="left")
             .sort("_row").select(FEATURES).to_numpy().astype(np.float32))
    if block.shape[0] != len(X):
        raise ValueError("chip_pit_attach_row_mismatch")
    coverage = {name: float(np.isfinite(block[:, i]).mean()) if len(X) else 0.0 for i, name in enumerate(FEATURES)}
    proof = {"contract_version": CONTRACT_VERSION, "features_sha256": FEATURES_SHA256, "rows": len(X),
             "feature_coverage": coverage}
    return np.hstack([np.asarray(X, dtype=np.float32), block]), [*feature_names, *FEATURES], proof


def daily_receipt(*, business_date: str, capture_id: str, capture_ready: bool, observed_at: datetime,
                  class_files: dict[str, tuple[str, bytes, pl.DataFrame]]) -> dict:
    classes = {}
    for cls, (path, raw, frame) in class_files.items():
        same_day = frame.filter(pl.col("data_date") == business_date)
        values = same_day.select(list(CLASSES[cls]["fields"]))
        classes[cls] = {"path": path, "sha256": _sha(raw), "rows": frame.height,
                        "data_dates": sorted(frame["data_date"].unique().to_list()),
                        "business_date_non_null": int(values.select(pl.any_horizontal(pl.all().is_not_null()).sum()).item())
                        if values.height else 0}
    return {"schema_version": DAILY_RECEIPT_SCHEMA, "contract_version": CONTRACT_VERSION,
            "business_date": business_date, "capture_id": capture_id, "capture_ready": bool(capture_ready),
            "observed_at": observed_at.astimezone(timezone.utc).isoformat(), "classes": classes}


def record_daily_capture(*, run_dir, bucket, business_date: str, capture_id: str, capture_ready: bool,
                         now=None) -> dict:
    """Write this capture's chip rows as immutable observations, stamped at write time (upper bound)."""
    observed_at = (now or (lambda: datetime.now(timezone.utc)))()
    prefix = f"{STORAGE_PREFIX}/daily/{business_date}/{capture_id}"
    class_files = {}
    absent = []
    for cls, spec in CLASSES.items():
        window = {f: run_dir / "raw" / "chip_pit_window" / f"{f}.parquet" for f in spec["fields"]}
        paths = window if all(p.exists() for p in window.values()) else {
            f: run_dir / "raw" / spec["lane"] / f"{f}.parquet" for f in spec["fields"]}
        if not all(p.exists() for p in paths.values()):
            absent.append(cls)  # lane-scoped retry captures carry only some lanes
            continue
        fields = {f: pl.read_parquet(p) for f, p in paths.items()}
        frame = class_observations(fields, cls, capture_id=capture_id, basis=BASIS_OBSERVED, observed_at=observed_at)
        raw = _parquet_bytes(frame)
        path = f"{prefix}/{cls}.parquet"
        bucket.blob(path).upload_from_string(raw, content_type="application/octet-stream", if_generation_match=0)
        class_files[cls] = (path, raw, frame)
    if not class_files:
        return {"status": "skipped_no_chip_lane", "classes_absent": absent}
    receipt = daily_receipt(business_date=business_date, capture_id=capture_id, capture_ready=capture_ready,
                            observed_at=observed_at, class_files=class_files)
    receipt["classes_absent"] = absent
    body = json.dumps(receipt, sort_keys=True, ensure_ascii=False).encode()
    bucket.blob(f"{prefix}/receipt.json").upload_from_string(body, content_type="application/json", if_generation_match=0)
    return {"status": "written", "receipt_path": f"{prefix}/receipt.json", "receipt_sha256": _sha(body),
            "observed_at": receipt["observed_at"], "classes_absent": absent}
