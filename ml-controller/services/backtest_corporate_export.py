"""Export original published corporate receipts without creating historical evidence."""
import json
import polars as pl
from services.paired_nav_journal import digest
from services.backtest_corporate_accounting import load_corporate_tape


def export_original_corporate_records(days, *, objects=None, scope_id="paper-account-1"):
    if objects is None:
        from services.paper_corporate_source import production_objects
        objects = production_objects()
    rows = []
    for day in sorted(set(days)):
        identity = {'owner': 'paper-corporate-source-v1', 'session_date': day, 'scope_id': scope_id}
        key = objects.lookup_delivery(digest(identity))
        if key is None:
            continue  # Missing days remain missing; no present-day replacement.
        record = objects.get(key)
        if record['identity'] != identity:
            raise ValueError('backtest_corporate_export_identity_mismatch')
        rows.append({'session_date': day, 'source_object_key': key,
                     'record_json': json.dumps(record, sort_keys=True, separators=(',', ':'))})
    frame = pl.DataFrame(rows, schema={'session_date':pl.String, 'source_object_key':pl.String, 'record_json':pl.String})
    load_corporate_tape(frame)  # Same receipt, timestamp and checksum gate as consumer.
    return frame
