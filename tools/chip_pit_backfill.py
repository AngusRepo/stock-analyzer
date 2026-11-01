"""Build chip PIT observations + the chip challenger feature panel from sealed GCS captures.

Reads only existing FinLab captures (no FinLab/D1 calls). Writes locally; --upload publishes
to gs://<bucket>/chip-pit/v1/{history,features}/<build_id>/ (needs Wei go).

  python tools/chip_pit_backfill.py --start 2023-03-01 --end 2026-10-30 --build-id chip-pit-hist-20261030 \
      --out-dir /tmp/chip-pit [--bulk <capture_id> ...] [--daily-since 2026-07-01] [--upload]
"""
from __future__ import annotations

import argparse
import io
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[1]
for candidate in (ROOT, ROOT / "ml-controller"):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from services import chip_pit as cp  # noqa: E402

CAPTURE_PREFIX = "finlab/v4/backfill"
# Newest full-field capture first; the 5y capture only adds institutional nets and balances before 2023-07.
DEFAULT_BULK = ("finlab-v4-3y-20260701-1782951243148", "finlab-v4-5y-20260517")


def _read(bucket, name: str) -> pl.DataFrame:
    return pl.read_parquet(io.BytesIO(bucket.blob(name).download_as_bytes()))


def _capture_files(bucket, capture: str) -> dict[str, datetime]:
    return {b.name: b.time_created for b in bucket.list_blobs(prefix=f"{CAPTURE_PREFIX}/{capture}/raw/")}


def _class_paths(capture: str, cls: str) -> dict[str, str]:
    lane = cp.CLASSES[cls]["lane"]
    return {f: f"{CAPTURE_PREFIX}/{capture}/raw/{lane}/{f}.parquet" for f in cp.CLASSES[cls]["fields"]}


def bulk_observations(bucket, capture: str, priority: int, start: str, end: str) -> dict[str, pl.DataFrame]:
    files = _capture_files(bucket, capture)
    out = {}
    for cls in cp.CLASSES:
        paths = _class_paths(capture, cls)
        if all(p in files for p in paths.values()):
            out[cls] = cp.class_observations({f: _read(bucket, p) for f, p in paths.items()}, cls, capture_id=capture,
                                             basis=cp.BASIS_RULE, priority=priority, start=start, end=end)
    return out


def daily_captures(bucket, since: str, end: str) -> list[str]:
    listing = bucket.list_blobs(prefix=f"{CAPTURE_PREFIX}/finlab-v4-daily-", delimiter="/")
    for _ in listing:
        pass  # prefixes fill in while pages are consumed
    names = {p.rstrip("/").rsplit("/", 1)[-1] for p in listing.prefixes}
    day = lambda c: f"{c.split('-')[3][:4]}-{c.split('-')[3][4:6]}-{c.split('-')[3][6:8]}"
    return sorted(c for c in names if since <= day(c) <= end)


def daily_observations(bucket, capture: str) -> tuple[dict[str, pl.DataFrame], dict]:
    """A sealed daily capture is a real-time observation stamped by its object write time (upper bound)."""
    manifest = json.loads(bucket.blob(f"{CAPTURE_PREFIX}/{capture}/manifest.json").download_as_bytes())
    files = _capture_files(bucket, capture)
    out, written = {}, []
    for cls in cp.CLASSES:
        window = {f: f"{CAPTURE_PREFIX}/{capture}/raw/chip_pit_window/{f}.parquet" for f in cp.CLASSES[cls]["fields"]}
        paths = window if all(p in files for p in window.values()) else _class_paths(capture, cls)
        if not all(p in files for p in paths.values()):
            continue
        observed_at = max(files[p] for p in paths.values())
        written.append(observed_at)
        out[cls] = cp.class_observations({f: _read(bucket, p) for f, p in paths.items()}, cls, capture_id=capture,
                                         basis=cp.BASIS_OBSERVED, observed_at=observed_at)
    meta = {"capture_id": capture, "business_date": manifest.get("source_end_date"),
            "ready": manifest.get("backfill_status") == "ready", "classes": sorted(out),
            "observed_at": max(written).astimezone(timezone.utc).isoformat() if written else None}
    return out, meta


def pit_daily_receipts(bucket, since: str, end: str) -> list[dict]:
    """Post-deploy records from services.chip_pit.record_daily_capture."""
    out = []
    for blob in bucket.list_blobs(prefix=f"{cp.STORAGE_PREFIX}/daily/"):
        if blob.name.endswith("/receipt.json"):
            receipt = json.loads(blob.download_as_bytes())
            if since <= receipt["business_date"] <= end:
                out.append(receipt)
    return out


def anchors_from(metas: list[dict]) -> dict[str, datetime]:
    """Signal cutoff = the first ready capture of the business date: that capture fed L3, so a class
    it lacked (vendor not yet published) was not available to that signal."""
    anchors: dict[str, datetime] = {}
    for meta in metas:
        if not meta["ready"] or not meta["observed_at"]:
            continue
        at = datetime.fromisoformat(meta["observed_at"])
        day = meta["business_date"]
        anchors[day] = min(anchors.get(day, at), at)
    return anchors


def coverage_gaps(merged: dict[str, pl.DataFrame], calendar: list[str]) -> dict:
    gaps = {}
    for cls, frame in merged.items():
        non_null = frame.filter(pl.any_horizontal([pl.col(f).is_not_null() for f in cp.CLASSES[cls]["fields"]]))
        days = set(non_null["data_date"].unique().to_list())
        missing = [d for d in calendar if d not in days]
        gaps[cls] = {"first_non_null": min(days) if days else None, "missing_sessions": len(missing),
                     "missing_first": missing[:5], "missing_last": missing[-5:]}
    return gaps


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start", required=True, help="first data date (include ~25 sessions of warmup)")
    parser.add_argument("--end", required=True)
    parser.add_argument("--signal-start", default="", help="first signal date in the panel; defaults to --start")
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--bucket", default="stockvision-models")
    parser.add_argument("--bulk", nargs="*", default=list(DEFAULT_BULK), help="rule-presumed captures, priority order")
    parser.add_argument("--daily-since", default="2026-07-01")
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--require-complete", action="store_true", help="fail when any class misses a session")
    parser.add_argument("--upload", action="store_true")
    args = parser.parse_args(argv)

    from google.cloud import storage
    bucket = storage.Client().bucket(args.bucket)
    frames: dict[str, list[pl.DataFrame]] = {cls: [] for cls in cp.CLASSES}
    for priority, capture in enumerate(args.bulk):
        for cls, frame in bulk_observations(bucket, capture, priority, args.start, args.end).items():
            frames[cls].append(frame)
    captures = daily_captures(bucket, args.daily_since, args.end)
    with ThreadPoolExecutor(args.workers) as pool:
        daily = list(pool.map(lambda c: daily_observations(bucket, c), captures))
    metas = [meta for _, meta in daily]
    for obs, _ in daily:
        for cls, frame in obs.items():
            frames[cls].append(frame.filter(pl.col("data_date") <= args.end))
    receipts = pit_daily_receipts(bucket, args.daily_since, args.end)
    for receipt in receipts:
        for cls, meta in receipt["classes"].items():
            frames[cls].append(_read(bucket, meta["path"]))
        metas.append({"capture_id": receipt["capture_id"], "business_date": receipt["business_date"],
                      "ready": receipt["capture_ready"], "classes": sorted(receipt["classes"]),
                      "observed_at": receipt["observed_at"]})

    merged, proofs = {}, {}
    for cls, parts in frames.items():
        if not parts:
            raise SystemExit(f"chip_pit_class_without_source:{cls}")
        merged[cls], proofs[cls] = cp.merge_observations(parts, cls)
    calendar = sorted(d for d in merged["turnover"].filter(pl.col("volume").is_not_null())["data_date"].unique().to_list()
                      if args.start <= d <= args.end)
    gaps = coverage_gaps(merged, [d for d in calendar if d >= (args.signal_start or args.start)])
    anchors = anchors_from(metas)
    signal_dates = [d for d in calendar if d >= (args.signal_start or args.start)]
    panel, panel_proof = cp.build_feature_panel(merged, signal_dates, anchors)

    out = Path(args.out_dir) / args.build_id
    (out / "history").mkdir(parents=True, exist_ok=True)
    (out / "features").mkdir(parents=True, exist_ok=True)
    history = {"schema_version": cp.OBSERVATION_SCHEMA, "contract_version": cp.CONTRACT_VERSION,
               "build_id": args.build_id, "generated_at": datetime.now(timezone.utc).isoformat(),
               "data_start": args.start, "data_end": args.end, "bulk_captures": args.bulk,
               "daily_captures": metas, "anchors": {d: t.isoformat() for d, t in sorted(anchors.items())},
               "coverage_gaps": gaps, "classes": {}}
    for cls, frame in merged.items():
        raw = cp._parquet_bytes(frame)
        (out / "history" / f"{cls}.parquet").write_bytes(raw)
        history["classes"][cls] = {"file": f"{cls}.parquet", "sha256": cp._sha(raw), **proofs[cls]}
    (out / "history" / "manifest.json").write_text(json.dumps(history, ensure_ascii=False, sort_keys=True, indent=1), encoding="utf8")
    history_sha = cp._sha((out / "history" / "manifest.json").read_bytes())
    raw, manifest = cp.panel_manifest(panel, panel_proof, sources={
        "history_manifest": f"{cp.STORAGE_PREFIX}/history/{args.build_id}/manifest.json",
        "history_manifest_sha256": history_sha})
    (out / "features" / "features.parquet").write_bytes(raw)
    (out / "features" / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=1), encoding="utf8")
    summary = {"build_id": args.build_id, "panel_rows": panel.height, "signal_dates": len(signal_dates),
               "observed_anchor_days": len(anchors), "coverage_gaps": gaps,
               "revised_after_first_seen": {c: p["revised_after_first_seen"] for c, p in proofs.items()}}
    incomplete = any(g["missing_sessions"] for c, g in gaps.items() if c in cp.CHIP_CLASSES)
    if incomplete and args.require_complete:
        print(json.dumps({**summary, "status": "incomplete"}, ensure_ascii=False))
        return 2
    if args.upload:
        for sub in ("history", "features"):
            for path in sorted((out / sub).iterdir()):
                bucket.blob(f"{cp.STORAGE_PREFIX}/{sub}/{args.build_id}/{path.name}").upload_from_filename(
                    str(path), if_generation_match=0)
        summary["uploaded"] = f"gs://{args.bucket}/{cp.STORAGE_PREFIX}/features/{args.build_id}/manifest.json"
    print(json.dumps({**summary, "status": "incomplete" if incomplete else "complete"}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
