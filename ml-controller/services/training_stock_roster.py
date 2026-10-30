"""Choose prep issuers from the same immutable snapshot that owns its inputs."""
from datetime import date
import re


def _day(value, field):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("training_roster_invalid_date:" + field)
    return date.fromisoformat(value)


def select_training_stock_rows(rows, *, start_date, end_date, with_listed_date=False):
    start, end = _day(start_date, "start"), _day(end_date, "end")
    if start > end:
        raise ValueError("training_roster_reversed_window")
    ids, symbols, selected = set(), set(), []
    for row in rows:
        sid, symbol, market = row.get("id"), row.get("symbol"), row.get("market")
        if (not isinstance(sid, int) or isinstance(sid, bool) or sid <= 0
                or not isinstance(symbol, str) or not symbol or symbol != symbol.strip()
                or sid in ids or symbol in symbols):
            raise ValueError("training_roster_identity_invalid")
        ids.add(sid); symbols.add(symbol)
        if market not in {"TW", "TWO", "TWSE", "OTC", "ROTC", "US"}:
            raise ValueError("training_roster_venue_unknown")
        listed = _day(row["listed_date"], "listed") if row.get("listed_date") is not None else None
        delisted = _day(row["delisted_date"], "delisted") if row.get("delisted_date") is not None else None
        if listed and delisted and listed > delisted:
            raise ValueError("training_roster_reversed_lifecycle")
        # Match dataset_snapshot_exporter's inclusive window rule. Keep issuers
        # that retired within the window; do not choose only today's survivors.
        if market in {"ROTC", "US"} or (listed and listed > end) or (delisted and delisted < start):
            continue
        # The training prep needs the listing date for the R33 label venue (C28-02 C3);
        # other callers (L4 native roster checksums) keep the base row shape.
        selected.append({"id":sid, "symbol":symbol, "market":market,
                         **({"listed_date":listed.isoformat() if listed else None} if with_listed_date else {})})
    if not ids:
        raise ValueError("training_roster_empty_snapshot")
    return sorted(selected, key=lambda row: row["id"])


SIDECAR_SCHEMA = "training-roster-capture-sidecar-v1"
SIDECAR_VENUES = frozenset({"TW", "TWO", "TWSE", "OTC"})


def capture_sidecar_rows(bucket, *, sequence_gcs_prefix, stock_rows, run_date, query_fn):
    """Q5 (i), C28-02 C4: stopped commons the snapshot roster lacks, admitted from the capture.

    A snapshot exporter window drops issuers delisted before it starts, which leaves their
    sealed capture prices out of training (survivorship). Identity comes from a read-only
    core stocks SELECT; nothing is written to D1 or the capture. A symbol without a core
    identity, a TW venue, a delisting date or institutional columns stays out, recorded.
    """
    import hashlib
    import io
    import json
    import polars as pl
    from services.training_source_preflight import _sealed_manifest

    sequence = _sealed_manifest(bucket, sequence_gcs_prefix, "sequence_manifest.json", compact=True)
    daily = [r for r in sequence.get("lane_reports", []) if r.get("lane") == "daily_price"]
    uri = (daily[0].get("source_uri") or {}).get("close", "") if len(daily) == 1 else ""
    if not uri.startswith(f"gs://{bucket.name}/") or "/raw/daily_price_full_vintage/" not in uri:
        raise ValueError("training_sidecar_price_source_invalid")
    price_root = uri.split("/", 3)[3].rsplit("/", 1)[0]
    raw_root = price_root.rsplit("/", 1)[0]

    def sealed(root, field):
        manifest = json.loads(bucket.blob(root + "/manifest.json").download_as_bytes())
        raw = bucket.blob(f"{root}/{field}.parquet").download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != (manifest.get("checksums") or {}).get(field):
            raise ValueError("training_sidecar_checksum_mismatch:" + field)
        return raw, manifest

    close_raw, price_manifest = sealed(price_root, "close")
    close = pl.read_parquet(io.BytesIO(close_raw)).with_columns(pl.col("date").cast(pl.String).str.slice(0, 10))
    close = close.filter(pl.col("date") <= run_date)
    last_session = close["date"].max()
    roster = {str(r["symbol"]) for r in stock_rows}
    value = pl.col("close").cast(pl.Float64, strict=False)
    spans = (close.unpivot(index="date", variable_name="symbol", value_name="close")
             .filter(pl.col("symbol").str.contains(r"^[1-9][0-9]{3}$") & ~pl.col("symbol").is_in(list(roster))
                     & value.is_finite() & (value > 0))
             .group_by("symbol").agg(pl.col("date").max().alias("last"), pl.len().alias("days")))
    stopped = {r["symbol"]: r for r in spans.filter(pl.col("last") < last_session).iter_rows(named=True)}
    # The price and institutional loaders abort the whole prep on one symbol's missing column
    # or adjustment gap, so a sidecar symbol must pass the same checks or stay out, recorded.
    from services.training_price_capture import INSTITUTIONAL_FIELDS, PRICE_FIELDS
    price_columns = [set(pl.read_parquet_schema(io.BytesIO(close_raw if f == "close" else sealed(price_root, f)[0])))
                     for f in PRICE_FIELDS]
    priced = set.intersection(*price_columns)
    adj = pl.read_parquet(io.BytesIO(sealed(price_root, "adj_close")[0]),
                          columns=["date", *sorted(set(stopped) & priced)])
    adj = adj.with_columns(pl.col("date").cast(pl.String).str.slice(0, 10)).filter(pl.col("date") <= run_date)
    pairs = close.select("date", *sorted(set(stopped) & priced)).join(adj, on="date", how="left", suffix="__adj")
    incomplete = {s for s in set(stopped) & priced
                  if pairs.filter(pl.col(s).cast(pl.Float64, strict=False).is_finite()
                                  & (pl.col(s).cast(pl.Float64, strict=False) > 0)
                                  & ~(pl.col(s + "__adj").cast(pl.Float64, strict=False).fill_null(-1.0) > 0)).height}
    institutional = set.intersection(*[
        set(pl.read_parquet_schema(io.BytesIO(sealed(raw_root + "/chip_diversity_full_vintage", f)[0])))
        for f in INSTITUTIONAL_FIELDS])
    found, ids = {}, {r["id"] for r in stock_rows}
    names = sorted(stopped)
    for i in range(0, len(names), 80):  # D1 bind limit
        chunk = names[i:i + 80]
        rows = query_fn("SELECT id, symbol, COALESCE(listing_market, market) AS market, listed_date, delisted_date "
                        f"FROM stocks WHERE symbol IN ({','.join('?' * len(chunk))})", chunk) or []
        for row in rows:
            found.setdefault(str(row["symbol"]), []).append(row)
    admitted, excluded = [], {}
    for symbol in names:
        rows = found.get(symbol) or []
        reason = ("core_identity_missing" if not rows else "core_identity_ambiguous" if len(rows) > 1
                  else "venue_not_tw" if rows[0].get("market") not in SIDECAR_VENUES
                  else "delisted_date_missing" if not rows[0].get("delisted_date")
                  else "id_in_roster" if rows[0].get("id") in ids
                  else "price_columns_missing" if symbol not in priced
                  else "adjustment_incomplete" if symbol in incomplete
                  else "institutional_columns_missing" if symbol not in institutional else None)
        if reason:
            excluded[symbol] = reason
        else:
            admitted.append(rows[0])
    # Same identity, date and window validation as the snapshot roster.
    selected = (select_training_stock_rows(admitted, start_date=close["date"].min(), end_date=run_date,
                                           with_listed_date=True) if admitted else [])
    kept = {r["symbol"] for r in selected}
    excluded.update({str(r["symbol"]): "outside_capture_window" for r in admitted if str(r["symbol"]) not in kept})
    proof = {"schema_version": SIDECAR_SCHEMA, "capture_id": price_manifest.get("capture_id"),
             "close_sha256": hashlib.sha256(close_raw).hexdigest(), "last_session": last_session,
             "stopped_commons_absent_from_snapshot": len(stopped),
             "admitted": sorted(kept), "admitted_symbol_days": sum(stopped[s]["days"] for s in kept),
             # The core identity rows read for admitted symbols, so the roster can be replayed.
             "core_identity": [{k: r.get(k) for k in ("id", "symbol", "market", "listed_date", "delisted_date")}
                               for r in sorted(admitted, key=lambda r: str(r["symbol"])) if str(r["symbol"]) in kept],
             "excluded": dict(sorted(excluded.items())), "d1_writes": 0, "capture_writes": 0}
    return selected, proof
