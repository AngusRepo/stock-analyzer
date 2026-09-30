"""Bounded, exact native allocator forecast originals in the existing R2 registry."""
from __future__ import annotations

import hashlib
import json
import re
from collections import defaultdict
from contextlib import ExitStack, contextmanager
from typing import Any, Callable

POINTER_SCHEMA = 'allocator-forecast-pointer-v1'
ARCHIVE_SCHEMA = 'allocator-forecast-archive-v1'
DOMAIN = 'allocator_ev_feature_forecast'
MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_ARTIFACT_ROWS = 16
MIN_ARCHIVE_BYTES = 2048
BASE_PATH = '/api/internal/evidence-artifacts/allocator-forecast/'


def _sha(raw: str | bytes) -> str:
    return 'sha256:' + hashlib.sha256(raw.encode('utf-8') if isinstance(raw, str) else raw).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


@contextmanager
def _operation_request():
    """Lazy one-client operation scope; no shared global connection state."""
    with ExitStack() as stack:
        client = None
        def request(operation, payload):
            nonlocal client
            if client is None:
                import httpx
                client = stack.enter_context(httpx.Client(timeout=60.))
            return _request(operation, payload, client=client)
        yield request


def _request(operation: str, payload: dict[str, Any], *, client=None) -> bytes:
    if client is None:
        with _operation_request() as request:
            return request(operation, payload)
    from services.worker_config_client import worker_auth_headers, worker_url
    raw = _json(payload).encode('utf-8')
    if len(raw) > MAX_ARTIFACT_BYTES:
        raise RuntimeError('allocator_forecast_request_byte_limit')
    headers = {**worker_auth_headers(), 'Content-Type': 'application/json', 'Accept-Encoding': 'identity'}
    with client.stream('POST', worker_url() + BASE_PATH + operation, headers=headers, content=raw) as response:
        if response.status_code != 200:
            raise RuntimeError(f'allocator_forecast_http_{response.status_code}')
        if response.headers.get('Content-Encoding', 'identity').lower() != 'identity':
            raise RuntimeError('allocator_forecast_compressed_response_forbidden')
        declared = response.headers.get('Content-Length')
        if declared and int(declared) > MAX_ARTIFACT_BYTES:
            raise RuntimeError('allocator_forecast_response_byte_limit')
        chunks, size = [], 0
        for chunk in response.iter_raw(chunk_size=65536):
            size += len(chunk)
            if size > MAX_ARTIFACT_BYTES:
                raise RuntimeError('allocator_forecast_response_byte_limit')
            chunks.append(chunk)
        return b''.join(chunks)


def _post(operation: str, payload: dict[str, Any], *, request=None) -> dict[str, Any]:
    result = json.loads((request or _request)(operation, payload))
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise RuntimeError('allocator_forecast_response_invalid')
    return result


def _key(row: dict[str, Any]) -> tuple[str, int, str]:
    day = str(row.get('snapshot_date') or row.get('prediction_date') or '')
    stock = row.get('stock_id')
    source = str(row.get('snapshot_source') or row.get('allocator_ev_feature_snapshot_source') or '')
    if len(day) != 10 or type(stock) is not int or stock <= 0 or not source:
        raise RuntimeError('allocator_forecast_row_identity_invalid')
    return day, stock, source


def _hot_projection(raw: str) -> dict[str, Any]:
    source = json.loads(raw)
    if not isinstance(source, dict):
        raise RuntimeError('allocator_forecast_inline_object_required')
    result = {}
    for parent, keys in (('ensemble_v2', ('model_set_signature', 'target_semantic_version')),
                         ('model_score_lineage', ('target_semantic_version',))):
        value = source.get(parent)
        if isinstance(value, dict):
            selected = {key: value[key] for key in keys if key in value}
            if selected:
                result[parent] = selected
    return result


def archive_allocator_forecasts(
    source_rows: list[dict[str, Any]], *, run_id: str,
    post: Callable[[str, dict[str, Any]], dict[str, Any]] | None = None,
    summary: dict[str, Any] | None = None,
) -> tuple[list[str], list[str]]:
    """Original strings/pointers in original order. No caller mutation on failure."""
    if post is None:
        with _operation_request() as request:
            return archive_allocator_forecasts(source_rows, run_id=run_id, summary=summary,
                post=lambda op, payload: _post(op, payload, request=request))
    sender = post or _post
    replacements = [row['forecast_data'] for row in source_rows]
    artifact_ids: list[str] = []
    chunk: list[tuple[int, dict[str, Any]]] = []
    size = 0
    oversized_inline_rows = 0
    writer_disabled = False
    gate_reason = None

    def flush() -> None:
        nonlocal chunk, size, writer_disabled, gate_reason
        if not chunk:
            return
        if writer_disabled:
            chunk, size = [], 0
            return
        receipt = sender('write', {'run_id': run_id, 'rows': [row for _, row in chunk]})
        if receipt.get('writer_enabled') is False:
            # One authoritative off response ends transport for this operation.
            # Previously verified pointers stay valid; remaining originals stay
            # byte-for-byte inline, with no second request or caller mutation.
            if (receipt.get('manifest') is not None or receipt.get('activation_id') is not None
                    or receipt.get('rows') != [row for _, row in chunk]):
                raise RuntimeError('allocator_forecast_disabled_response_mismatch')
            writer_disabled, gate_reason = True, str(receipt.get('reason') or 'activation_disabled')
            chunk, size = [], 0
            return
        if (receipt.get('writer_enabled') is not True or not isinstance(receipt.get('activation_id'), str)
                or not 0 < len(receipt['activation_id']) <= 140):
            raise RuntimeError('allocator_forecast_activation_response_invalid')
        manifest = receipt.get('manifest') or {}
        if (manifest.get('domain') != DOMAIN or manifest.get('schema_version') != ARCHIVE_SCHEMA
                or manifest.get('retention_class') != 'ten_year_cold_archive' or manifest.get('status') != 'ready'
                or not manifest.get('checksum_verified_at') or manifest.get('producer_run_id') != run_id
                or manifest.get('row_count') != len(chunk)
                or type(manifest.get('byte_size')) is not int or not 0 < manifest['byte_size'] <= MAX_ARTIFACT_BYTES
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', str(manifest.get('checksum') or ''))):
            raise RuntimeError('allocator_forecast_write_manifest_invalid')
        artifact_id = str(manifest.get('artifact_id') or '')
        if not artifact_id.startswith('artifact:' + DOMAIN + ':'):
            raise RuntimeError('allocator_forecast_write_identity_invalid')
        outputs = receipt.get('rows')
        if not isinstance(outputs, list) or len(outputs) != len(chunk):
            raise RuntimeError('allocator_forecast_write_rows_missing')
        for (index, original), output in zip(chunk, outputs, strict=True):
            if _key(output) != _key(original) or output.get('forecast_checksum') != _sha(original['forecast_data']):
                raise RuntimeError('allocator_forecast_write_row_mismatch')
            replacement = output.get('forecast_data')
            if not isinstance(replacement, str):
                raise RuntimeError('allocator_forecast_write_value_invalid')
            if replacement != original['forecast_data']:
                pointer = json.loads(replacement)
                if (pointer.get('schema_version') != POINTER_SCHEMA or pointer.get('artifact_id') != artifact_id
                        or pointer.get('checksum') != manifest.get('checksum') or _key(pointer) != _key(original)
                        or pointer.get('forecast_checksum') != _sha(original['forecast_data'])
                        or pointer.get('as_of_guard') != original['as_of_guard']
                        or pointer.get('original_bytes') != len(original['forecast_data'].encode('utf-8'))
                        or _hot_projection(replacement) != _hot_projection(original['forecast_data'])
                        or len(replacement.encode('utf-8')) >= len(original['forecast_data'].encode('utf-8'))):
                    raise RuntimeError('allocator_forecast_write_pointer_invalid')
            replacements[index] = replacement
        artifact_ids.append(artifact_id)
        chunk, size = [], 0

    seen = set()
    for index, row in enumerate(source_rows):
        key = _key(row)
        if key in seen:
            raise RuntimeError('allocator_forecast_duplicate_row')
        seen.add(key)
        original = row['forecast_data']
        if not isinstance(original, str):
            raise RuntimeError('allocator_forecast_inline_string_required')
        if writer_disabled:
            continue
        original_bytes = len(original.encode('utf-8'))
        if original_bytes < MIN_ARCHIVE_BYTES:
            continue
        parsed = json.loads(original)
        if not isinstance(parsed, dict) or parsed.get('schema_version') == POINTER_SCHEMA:
            raise RuntimeError('allocator_forecast_inline_original_required')
        encoded_size = len(_json(row).encode('utf-8')) + 1
        if encoded_size > MAX_ARTIFACT_BYTES - 4096:
            # Preserve the existing inline writer's complete legal value; the
            # archive transport budget must not become a new source data limit.
            oversized_inline_rows += 1
            continue
        if chunk and (len(chunk) >= MAX_ARTIFACT_ROWS or size + encoded_size > MAX_ARTIFACT_BYTES - 4096):
            flush()
        chunk.append((index, row)); size += encoded_size
    flush()
    if summary is not None:
        summary.update(artifact_count=len(artifact_ids),
            archived_rows=sum(replacement != original['forecast_data'] for replacement, original in zip(replacements, source_rows)),
            retained_inline_rows=sum(replacement == original['forecast_data'] for replacement, original in zip(replacements, source_rows)),
            oversized_inline_rows=oversized_inline_rows,
            logical_bytes_saved=sum(len(original['forecast_data'].encode('utf-8')) - len(replacement.encode('utf-8'))
                for replacement, original in zip(replacements, source_rows)))
        if writer_disabled:
            summary.update(writer_enabled=False, writer_gate_reason=gate_reason)
    return replacements, artifact_ids


def hydrate_allocator_forecasts(
    rows: list[dict[str, Any]], *,
    download: Callable[[str], bytes] | None = None,
) -> list[dict[str, Any]]:
    """One bounded artifact at a time; publish a private result after full success.

    The complete output retains the pre-existing inline consumer's memory needs.
    Extra transport/decoded state is bounded to one artifact; there is no new
    aggregate output cap or second full forecast collection. SQL RAM is unchanged.
    Inline callers retain the previous contract and cause no network request.
    """
    if download is None:
        with _operation_request() as request:
            return hydrate_allocator_forecasts(rows,
                download=lambda artifact_id: request('read', {'artifact_id': artifact_id}))
    groups: dict[tuple[str, str], list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for index, row in enumerate(rows):
        raw = row.get('forecast_data')
        if not isinstance(raw, str) or POINTER_SCHEMA not in raw:
            continue
        pointer = json.loads(raw)
        if not isinstance(pointer, dict) or pointer.get('schema_version') != POINTER_SCHEMA:
            continue
        if (_key(pointer) != _key(row)
                or pointer.get('as_of_guard') != row.get('as_of_guard', row.get('allocator_ev_feature_snapshot_guard'))
                or type(pointer.get('original_bytes')) is not int or pointer['original_bytes'] < 0
                or pointer['original_bytes'] > MAX_ARTIFACT_BYTES):
            raise RuntimeError('allocator_forecast_pointer_identity_invalid')
        artifact_id, checksum = str(pointer.get('artifact_id') or ''), str(pointer.get('checksum') or '')
        if not artifact_id.startswith('artifact:' + DOMAIN + ':') or len(checksum) != 71 or not checksum.startswith('sha256:'):
            raise RuntimeError('allocator_forecast_pointer_invalid')
        groups[(artifact_id, checksum)].append((index, pointer))
    if not groups:
        return rows
    getter = download or (lambda artifact_id: _request('read', {'artifact_id': artifact_id}))
    result = [dict(row) for row in rows]
    for (artifact_id, checksum), requests in groups.items():
        raw = getter(artifact_id)
        if not isinstance(raw, bytes) or not raw or len(raw) > MAX_ARTIFACT_BYTES:
            raise RuntimeError('allocator_forecast_archive_byte_limit')
        if _sha(raw) != checksum:
            raise RuntimeError('allocator_forecast_archive_checksum_mismatch')
        archive = json.loads(raw)
        if not isinstance(archive, dict) or not isinstance(archive.get('payload'), dict):
            raise RuntimeError('allocator_forecast_archive_identity_invalid')
        payload = archive['payload']
        originals = payload.get('rows')
        if (archive.get('schema_version') != ARCHIVE_SCHEMA or archive.get('domain') != DOMAIN
                or payload.get('source_table') != 'allocator_ev_feature_snapshots'
                or not isinstance(originals, list) or not 0 < len(originals) <= MAX_ARTIFACT_ROWS):
            raise RuntimeError('allocator_forecast_archive_identity_invalid')
        by_key = {}
        for original in originals:
            if not isinstance(original, dict):
                raise RuntimeError('allocator_forecast_archive_row_invalid')
            key = _key(original)
            if key in by_key or archive.get('business_date') != key[0] or not isinstance(original.get('forecast_data'), str):
                raise RuntimeError('allocator_forecast_archive_row_invalid')
            by_key[key] = original
        for index, pointer in requests:
            original = by_key.get(_key(pointer))
            if original is None:
                raise RuntimeError('allocator_forecast_original_missing')
            forecast = original['forecast_data']
            if (original.get('as_of_guard') != pointer['as_of_guard'] or _sha(forecast) != pointer.get('forecast_checksum')
                    or len(forecast.encode('utf-8')) != pointer['original_bytes']
                    or _hot_projection(forecast) != _hot_projection(str(rows[index]['forecast_data']))):
                raise RuntimeError('allocator_forecast_original_mismatch')
            result[index]['forecast_data'] = forecast
    return result


def reconcile_allocator_forecast_references(run_id: str, *, post=None) -> None:
    if post is None:
        with _operation_request() as request:
            return reconcile_allocator_forecast_references(run_id,
                post=lambda op, payload: _post(op, payload, request=request))
    sender = post or _post
    after = ''
    for _ in range(32):
        result = sender('reconcile', {'run_id': run_id, 'after_artifact_id': after})
        if result.get('has_more') is not True:
            return
        next_cursor = str(result.get('after_artifact_id') or '')
        if next_cursor <= after:
            raise RuntimeError('allocator_forecast_reconcile_cursor_invalid')
        after = next_cursor
    raise RuntimeError('allocator_forecast_reconcile_page_budget')


def reconcile_allocator_forecast_date(snapshot_date: str, source: str, query, *, post=None) -> dict[str, Any]:
    """At most two terminal runs and sixteen originals after publication.

    The existing daily Worker owner resumes all other pages through its durable
    run inventory/cursor, including process death immediately after publication.
    """
    if post is None:
        with _operation_request() as request:
            return reconcile_allocator_forecast_date(snapshot_date, source, query,
                post=lambda op, payload: _post(op, payload, request=request))
    runs = query("""SELECT run_id FROM allocator_ev_snapshot_runs
        WHERE snapshot_date=? AND snapshot_source=? AND status IN ('ready','failed')
        ORDER BY run_id ASC LIMIT 2""", [snapshot_date, source])
    checked = 0
    for run in runs:
        if checked >= 16:
            break
        result = (post or _post)('reconcile', {'run_id': run['run_id']})
        checked += int(result.get('checked') or 0)
        # Every API page is capped at 16; stop after the first nonempty page.
        if checked:
            break
    return {'status': 'bounded_pass_complete', 'checked': checked, 'natural_recovery_owner': 'artifact-reconcile'}
