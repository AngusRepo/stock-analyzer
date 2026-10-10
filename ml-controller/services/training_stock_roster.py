"""Choose prep issuers from the same immutable snapshot that owns its inputs."""
from datetime import date
import re


def _day(value, field):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("training_roster_invalid_date:" + field)
    return date.fromisoformat(value)


def select_training_stock_rows(rows, *, start_date, end_date):
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
        selected.append({"id":sid, "symbol":symbol, "market":market})
    if not ids:
        raise ValueError("training_roster_empty_snapshot")
    return sorted(selected, key=lambda row: row["id"])
