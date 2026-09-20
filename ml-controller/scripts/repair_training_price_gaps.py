"""Build insert-only SQL from reviewed archived OHLCV; never executes a database write."""
from __future__ import annotations
import json
import math
from pathlib import Path
import polars as pl

FIELDS = ("open", "high", "low", "close", "adj_close", "volume", "value")

def build_missing_rows(identities, existing, source, dates):
    current = {(int(r["stock_id"]), r["date"]) for r in existing}
    ids = {str(r["symbol"]): int(r["id"]) for r in identities}
    if len(ids) != len(identities) or len(set(ids.values())) != len(ids):
        raise ValueError("duplicate_stock_identity")
    rows = []
    for day in sorted(dates):
        values = {field: source[field][day] for field in FIELDS}
        for symbol, sid in sorted(ids.items()):
            if (sid, day) in current:
                continue
            raw = [values[field].get(symbol) for field in FIELDS]
            if any(v is None for v in raw):
                continue
            o,h,l,c,adj,volume,value = map(float, raw)
            if not all(math.isfinite(v) for v in (o,h,l,c,adj,volume,value)):
                raise ValueError("nonfinite_source_ohlcv")
            if min(o,h,l,c,adj) <= 0 or not l <= min(o,c) <= max(o,c) <= h or volume < 0 or value < 0:
                raise ValueError("invalid_source_ohlcv")
            if volume != round(volume):
                raise ValueError("fractional_source_share_volume")
            rows.append(dict(stock_id=sid,date=day,open=o,high=h,low=l,close=c,adj_close=adj,
                             volume=int(volume),avg_price=value/volume if volume else None))
    return rows

def render_sql(rows):
    from datetime import date
    lines = []
    for row in rows:
        day=date.fromisoformat(row["date"]).isoformat()
        values=[str(int(row["stock_id"])), "'"+day+"'"]
        for key in ("open","high","low","close","adj_close","volume","avg_price"):
            value=row[key]
            if value is not None and not math.isfinite(value):raise ValueError("nonfinite_sql_number")
            values.append("NULL" if value is None else repr(value))
        lines.append("INSERT INTO stock_prices (stock_id,date,open,high,low,close,adj_close,volume,avg_price) VALUES ("+",".join(values)+") ON CONFLICT(stock_id,date) DO NOTHING;")
    return "\n".join(lines)+"\n"

if __name__ == "__main__":
    import argparse,hashlib
    p=argparse.ArgumentParser();p.add_argument("directory",type=Path);p.add_argument("--dates",nargs='+',required=True);args=p.parse_args()
    root=args.directory
    identities=json.loads((root/'current-stock-identities.json').read_text(encoding='utf-8-sig'))[0]['results']
    existing=json.loads((root/'current-price-rows.json').read_text(encoding='utf-8-sig'))[0]['results']
    source={f:{r['date']:r for r in pl.read_parquet(root/(f+'.parquet')).to_dicts()} for f in FIELDS}
    rows=build_missing_rows(identities,existing,source,args.dates)
    sql=render_sql(rows);(root/'insert-missing-only.sql').write_bytes(sql.encode())
    receipt={'dates':args.dates,'insert_candidates':len(rows),'existing_rows_preserved':len(existing),
             'source_receipts':json.loads((root/'receipt.json').read_text()),'sql_sha256':hashlib.sha256(sql.encode()).hexdigest(),
             'writes_executed':False,'conflict_policy':'DO NOTHING'}
    (root/'repair-plan.json').write_text(json.dumps(receipt,indent=2));print(json.dumps({k:v for k,v in receipt.items() if k!='source_receipts'}))
