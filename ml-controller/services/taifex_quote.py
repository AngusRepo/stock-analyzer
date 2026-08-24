from __future__ import annotations


def parse_taifex_quote(body: dict, market_type: str) -> dict | None:
    quotes = ((body.get("RtData") or {}).get("QuoteList") or [])
    suffix = "-M" if market_type == "1" else "-F"
    for row in quotes:
        symbol = str(row.get("SymbolID") or "")
        if not symbol.startswith("TXF") or not symbol.endswith(suffix):
            continue
        try:
            last_price = float(row.get("CLastPrice"))
            ref_price = float(row.get("CRefPrice"))
        except (TypeError, ValueError):
            continue
        if ref_price == 0:
            continue
        change_points = last_price - ref_price
        return {
            "lastPrice": last_price,
            "refPrice": ref_price,
            "changePoints": change_points,
            "changePct": change_points / ref_price * 100,
            "date": str(row.get("CDate") or ""),
            "time": str(row.get("CTime") or ""),
            "symbol": symbol,
        }
    return None
