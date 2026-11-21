"""One-time repair of FinLab adjusted prices from a single sealed capture.

(i)  canonical_market_daily (source finlab.price): rows whose adj_* is NULL or
     on a stale vendor basis are rewritten from the capture; as_of_date is kept.
(ii) legacy stock_prices.adj_close: every date the capture covers is put on the
     capture's basis, so serving payloads never splice raw and adjusted closes.
Only rows that differ are written. Dry run by default; --apply writes through
the D1 API, --emit-sql writes inlined SQL files for `wrangler d1 execute --file`.

Usage:
  python tools/canonical_adj_repair.py --vintage gs://BUCKET/.../raw/daily_price_full_vintage \
      --end-date 2026-10-22 --report out.json [--apply]
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
import tempfile
from collections import Counter
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_canonical_materializer import (  # noqa: E402
    ADJUSTED_REBASE_TOLERANCE,
    ADJUSTED_VINTAGE_FIELDS,
    _json,
    adjusted_vintage_rows,
    load_adjusted_price_vintage,
)

SOURCE = "finlab.price"
REASON = "one_time_vintage_repair"


def _backfill_tool():
    spec = importlib.util.spec_from_file_location("finlab_v4_remote_backfill_tool", ROOT / "tools" / "finlab_v4_remote_backfill.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def fetch_vintage(location: str, workdir: Path) -> Path:
    """Return an artifact root whose raw/daily_price_full_vintage holds the capture."""
    target = workdir / "raw" / "daily_price_full_vintage"
    target.mkdir(parents=True, exist_ok=True)
    if location.startswith("gs://"):
        from google.cloud import storage

        bucket_name, prefix = location[5:].split("/", 1)
        bucket = storage.Client().bucket(bucket_name)
        for name in (*ADJUSTED_VINTAGE_FIELDS, "manifest"):
            filename = "manifest.json" if name == "manifest" else f"{name}.parquet"
            bucket.blob(f"{prefix.rstrip('/')}/{filename}").download_to_filename(str(target / filename))
        return workdir
    return Path(location).resolve().parents[1]


def _differs(stored, current) -> bool:
    return stored is None or abs(float(current) / float(stored) - 1.0) > ADJUSTED_REBASE_TOLERANCE


def plan_repair(vintage: pl.DataFrame, canonical_rows: list[dict], legacy_rows: list[dict], identities: dict[str, int],
                *, capture_id: str) -> tuple[dict, list[tuple[str, list]]]:
    rows = {(r["stock_id"], r["date"]): r for r in adjusted_vintage_rows(vintage).iter_rows(named=True)}
    lineage = _json({"reason": REASON, "capture_id": capture_id})
    statements: list[tuple[str, list]] = []
    canonical = Counter()
    rebased: dict[str, set[float]] = {}
    for stored in canonical_rows:
        current = rows.get((str(stored["stock_id"]), str(stored["date"])))
        if current is None:
            canonical["not_in_capture"] += 1
            continue
        if not _differs(stored.get("adj_close"), current["adj_close"]):
            canonical["unchanged"] += 1
            continue
        if stored.get("adj_close") is None:
            canonical["null_filled"] += 1
        else:
            canonical["rebased"] += 1
            rebased.setdefault(current["stock_id"], set()).add(round(current["adj_close"] / float(stored["adj_close"]), 9))
        statements.append((
            "UPDATE canonical_market_daily SET adj_open=?, adj_high=?, adj_low=?, adj_close=?, "
            "lineage_json=json_set(COALESCE(lineage_json,'{}'),'$.adjusted_repair',json(?)) "
            "WHERE stock_id=? AND date=? AND source=?",
            [current["adj_open"], current["adj_high"], current["adj_low"], current["adj_close"], lineage,
             current["stock_id"], current["date"], SOURCE]))
    symbol_of = {sid: symbol for symbol, sid in identities.items()}
    legacy = Counter()
    for stored in legacy_rows:
        symbol = symbol_of.get(stored["stock_id"])
        current = rows.get((symbol, str(stored["date"]))) if symbol else None
        if current is None:
            legacy["not_in_capture"] += 1
            continue
        if not _differs(stored.get("adj_close"), current["adj_close"]):
            legacy["unchanged"] += 1
            continue
        legacy["rewritten"] += 1
        statements.append(("UPDATE stock_prices SET adj_close=? WHERE stock_id=? AND date=?",
                           [current["adj_close"], stored["stock_id"], current["date"]]))
    report = dict(capture_id=capture_id, tolerance=ADJUSTED_REBASE_TOLERANCE, capture_rows=len(rows),
                  canonical=dict(canonical), legacy_stock_prices=dict(legacy),
                  rebased_stocks={s: sorted(k) for s, k in sorted(rebased.items())},
                  statements=len(statements))
    return report, statements


def _sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return str(int(value))
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("non-finite value in repair statement")
        return repr(value)
    return "'" + str(value).replace("'", "''") + "'"


def render_sql_files(statements: list[tuple[str, list]], target: Path, *, per_file: int = 50_000) -> list[Path]:
    """Inline parameters so wrangler `d1 execute --remote --file` can apply the plan.

    Every statement sets absolute values, so a partly applied file can be re-run.
    """
    target.mkdir(parents=True, exist_ok=True)
    paths = []
    for index in range(0, len(statements), per_file):
        lines = []
        for sql, params in statements[index:index + per_file]:
            parts = sql.split("?")
            if len(parts) != len(params) + 1:
                raise ValueError(f"placeholder mismatch: {sql}")
            lines.append("".join(part + (_sql_literal(params[i]) if i < len(params) else "") for i, part in enumerate(parts)) + ";")
        path = target / f"adj_repair_{index // per_file:03d}.sql"
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        paths.append(path)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--vintage", required=True, help="gs:// prefix or local daily_price_full_vintage dir")
    parser.add_argument("--end-date", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--chunk-size", type=int, default=250)
    parser.add_argument("--emit-sql", help="directory for inlined SQL files instead of --apply")
    args = parser.parse_args()
    tool = _backfill_tool()
    with tempfile.TemporaryDirectory() as workdir:
        root = fetch_vintage(args.vintage, Path(workdir))
        manifest = json.loads((root / "raw" / "daily_price_full_vintage" / "manifest.json").read_text(encoding="utf-8"))
        vintage = load_adjusted_price_vintage(root, end_date=args.end_date)
    if vintage.is_empty():
        raise SystemExit("capture_empty")
    dates = sorted(vintage["date"].unique().to_list())
    canonical_rows = []
    for day in sorted({d for d in dates}):
        canonical_rows += tool.d1_query("SELECT stock_id, date, adj_close FROM canonical_market_daily WHERE source=? AND date=?",
                                        [SOURCE, day], domain="market")
    symbols = sorted(vintage["stock_id"].unique().to_list())
    identities = {}
    for i in range(0, len(symbols), 90):
        chunk = symbols[i:i + 90]
        for row in tool.d1_query(f"SELECT id, symbol FROM stocks WHERE symbol IN ({','.join('?' * len(chunk))})", chunk, domain="core"):
            identities[str(row["symbol"])] = int(row["id"])
    legacy_rows = []
    for day in dates:
        legacy_rows += tool.d1_query("SELECT stock_id, date, adj_close FROM stock_prices WHERE date=?", [day], domain="market")
    report, statements = plan_repair(vintage, canonical_rows, legacy_rows, identities, capture_id=str(manifest.get("capture_id")))
    report.update(end_date=args.end_date, capture_dates=[dates[0], dates[-1], len(dates)], applied=False)
    if args.emit_sql:
        report["sql_files"] = [str(path) for path in render_sql_files(statements, Path(args.emit_sql))]
    if args.apply and statements:
        result = tool.d1_batch_execute(statements, timeout=120.0, chunk_size=args.chunk_size, domain="market")
        tool.require_finlab_write_ack(result, len(statements), phase="adjusted_repair")
        report.update(applied=True, apply_result=result)
    Path(args.report).write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")
    print(json.dumps({k: report[k] for k in ("canonical", "legacy_stock_prices", "statements", "applied")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
