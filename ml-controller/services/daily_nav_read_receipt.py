"""Same-date retry reuse guarded by the complete recorded SQL read set.

Only native L4's retired-owner daily path with no possible promotion is
eligible. Failed comparison results stay failed; they cannot grant adoption. This never completes a scheduler ticket: the original durable job
still verifies today's Paper plan and sends its ordinary terminal callback.
Any changed read, code, missing source or uncertain evidence runs the owner.
"""
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import logging
import os
import re
from pathlib import Path

log = logging.getLogger(__name__)
MAX_RECEIPT_BYTES = 1024 * 1024


def _readonly(sql):
    return sql.lstrip().upper().startswith('SELECT ') or re.fullmatch(
        r'\s*PRAGMA\s+(?:table_info|index_info|index_list|foreign_key_list)\s*\([a-zA-Z0-9_]+\)\s*;?\s*', sql, re.I) is not None


def _digest(value):
    digest = hashlib.sha256()
    for chunk in json.JSONEncoder(sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).iterencode(value):
        digest.update(chunk.encode())
    return digest.hexdigest()


def code_identity():
    root = Path(__file__).parents[1]
    h = hashlib.sha256()
    h.update(os.environ.get('STOCKVISION_SOURCE_SHA', '').encode())
    paths = [root / 'oof_materialize_job_main.py', *root.joinpath('services').glob('*.py'),
             *root.joinpath('routers').glob('*.py'), *root.joinpath('services').glob('*.json'), root / 'requirements.txt']
    for path in sorted(paths):
        h.update(str(path.relative_to(root)).replace('\\', '/').encode())
        h.update(path.read_bytes())
    return h.hexdigest()


class RecordedClient:
    def __init__(self, client):
        self.client, self.reads, self.stable = client, {}, True

    def __getattr__(self, key):
        return getattr(self.client, key)

    def query(self, sql, params=None, *args, **kwargs):
        rows = self.client.query(sql, params, *args, **kwargs)
        if not _readonly(sql):
            self.stable = False
            return rows
        if not self.stable:
            return rows
        request = {'sql': sql, 'params': params or []}
        try:
            key, checksum = _digest(request), _digest(rows)
        except (TypeError, ValueError):
            self.stable = False
            return rows
        previous = self.reads.get(key)
        if previous is not None and previous['checksum'] != checksum:
            self.stable = False
        self.reads[key] = {**request, 'checksum': checksum}
        if len(self.reads) > 512:
            self.stable = False
        return rows


def unchanged(client, reads):
    if not reads or len(reads) > 512:
        return False
    # Original queries include empty end pages and COUNT/schema checks, so new
    # publications, removed rows and changed values invalidate the whole receipt.
    for start in range(0, len(reads), 25):
        page = reads[start:start + 25]
        if any(not _readonly(item['sql']) for item in page):
            return False
        if hasattr(client, 'database_id'):
            from services.d1_client import read_raw_batch
            rows = read_raw_batch([{'sql': r['sql'], 'params': r['params']} for r in page],
                                  database_id=client.database_id)
        else:
            rows = [client.query(r['sql'], r['params']) for r in page]
        if len(rows) != len(page) or any(_digest(actual) != r['checksum'] for actual, r in zip(rows, page)):
            return False
    return True


def reusable_result(result):
    status = result.get('status')
    accounting = result.get('accounting_status') if status == 'failed' else status
    if (accounting not in {'up_to_date', 'materialized', 'awaiting_execution_pairs'}
            or result.get('open_pair_sessions') != 0
            or (result.get('_adoption_candidates') and status != 'failed')
            or result.get('journal_chain_verified') is not True or result.get('error_type')):
        return False
    def unexpected(value):
        if isinstance(value, dict):
            known_absent_allocation = (value.get('stage') == 'original_source'
                and value.get('reason') == 'nav_policy_original_allocation_missing'
                and value.get('error_type') == 'ValueError')
            if (value.get('error_type') and not known_absent_allocation) or value.get('stage') == 'refresh':
                return True
            return any(unexpected(v) for v in value.values())
        return isinstance(value, list) and any(unexpected(v) for v in value)
    return not unexpected(result)


def run_with_receipt(*, business_date, client, run, store, now=None):
    clock = now or datetime.now(timezone.utc)
    # Never freeze a result while that business session can still be open.
    if date.fromisoformat(business_date) >= clock.astimezone(timezone(timedelta(hours=8))).date():
        return run(client)
    identity = code_identity()
    key = 'daily-nav-read-receipts/v1/' + business_date + '/' + identity + '.json'
    try:
        receipt = store.read(key)
        if (receipt and receipt.get('business_date') == business_date and receipt.get('code_identity') == identity
                and receipt.get('result_checksum') == _digest(receipt['result'])
                and reusable_result(receipt['result']) and unchanged(client, receipt['reads'])):
            log.info('[DailyNav] reused unchanged original SQL read set queries=%s', len(receipt['reads']))
            return deepcopy(receipt['result'])
    except Exception as exc:
        log.warning('[DailyNav] retry receipt unavailable error_type=%s', type(exc).__name__)
    recorded = RecordedClient(client)
    result = run(recorded)
    if recorded.stable and reusable_result(result):
        receipt = {'business_date': business_date, 'code_identity': identity,
                   'reads': list(recorded.reads.values()), 'result': result, 'result_checksum': _digest(result)}
        try:
            raw = json.dumps(receipt, ensure_ascii=False, allow_nan=False).encode()
            if len(raw) <= MAX_RECEIPT_BYTES and unchanged(client, receipt['reads']):
                store.write(key, raw)
        except Exception as exc:
            # Optional cost optimization cannot turn a completed owner into a failure.
            log.warning('[DailyNav] retry receipt not saved error_type=%s', type(exc).__name__)
    return result


class GcsReceiptStore:
    def __init__(self, bucket):
        self.bucket = bucket

    def read(self, key):
        from google.api_core.exceptions import NotFound
        blob = self.bucket.blob(key)
        try:
            blob.reload()
        except NotFound:
            return None
        if blob.size > MAX_RECEIPT_BYTES:
            return None
        return json.loads(blob.download_as_bytes(if_generation_match=blob.generation))

    def write(self, key, raw):
        self.bucket.blob(key).upload_from_string(raw, content_type='application/json')
